/**
 * Finds product targets that haven't produced any user-visible activity —
 * useful to spot dead or dormant sources on the deployed machine.
 *
 * Buckets each target into one of:
 *   DEAD           — 0 products ever extracted, tracked for >= min-age days
 *   BOOTSTRAP_ONLY — products exist, no alerts ever, tracked for >= min-age days
 *   DORMANT        — had alerts historically, none in the last N days
 *   ACTIVE         — had at least one alert in the last N days
 *   TOO_YOUNG      — added too recently to judge (excluded from other buckets)
 *   UNKNOWN_AGE    — 0 products AND no source_cache row (can't tell age at all)
 *
 * Age is computed from the earliest signal we have per source_url:
 *   1) MIN(products.first_seen_at) — most reliable
 *   2) source_cache.last_full_fetch_at — for static targets that fetched but
 *      extracted nothing
 * Dynamic-only targets that never yielded products AND never hit source_cache
 * fall into UNKNOWN_AGE.
 *
 * Correlation with alert_log is done via product_id inside the JSON details
 * (source_url isn't stored there directly). We restrict the join on
 * source_url so identical product_ids across stores don't cross-contaminate.
 *
 * Usage:
 *   node scripts/find-silent-targets.js                       # 30d window, 7d min-age (defaults)
 *   node scripts/find-silent-targets.js 60                    # 60d window
 *   node scripts/find-silent-targets.js 60 --min-age 14       # 60d window, 14d min-age
 *   node scripts/find-silent-targets.js 30 --json             # machine-readable output
 *   node scripts/find-silent-targets.js 30 --until 2026-11-16 # measure back from a fixed date
 *
 * Windows are measured back from the "as of" date: --until YYYY-MM-DD if given,
 * otherwise the DB's latest products.last_checked_at (i.e. when the monitor last
 * ran). That way a stopped monitor doesn't make every target look dormant.
 *
 * Reads DB_PATH from env (falls back to ./data/monitoring.db).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const AS_JSON = process.argv.includes('--json');
const SUMMARY_ONLY = process.argv.includes('--summary');
const COMPACT = process.argv.includes('--compact');

const positionalArgs = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false;
  // Skip the value that immediately follows --min-age
  if (arr[i - 1] === '--min-age' || arr[i - 1] === '--until') return false;
  return true;
});
const DAYS_WINDOW = parseInt(positionalArgs[0], 10) || 30;

const minAgeIdx = process.argv.indexOf('--min-age');
const MIN_AGE_DAYS = minAgeIdx > -1 ? parseInt(process.argv[minAgeIdx + 1], 10) || 7 : 7;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

const TARGETS_PATH = path.join(__dirname, '..', 'data', 'product-targets.json');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'monitoring.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(TARGETS_PATH)) {
  console.error(`Targets file not found at ${TARGETS_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));

// SQLite datetime('now') gives 'YYYY-MM-DD HH:MM:SS' UTC; match that shape.
function isoToSqlite(iso) {
  return iso.replace('T', ' ').slice(0, 19);
}

// "As of" reference point. --until is taken as the END of that day (UTC).
const untilIdx = process.argv.indexOf('--until');
let asOfMs;
if (untilIdx > -1) {
  asOfMs = Date.parse(`${process.argv[untilIdx + 1]}T23:59:59Z`);
  if (Number.isNaN(asOfMs)) {
    console.error(`Invalid --until date "${process.argv[untilIdx + 1]}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }
} else {
  const { last } = db.prepare('SELECT MAX(last_checked_at) AS last FROM products').get();
  asOfMs = last ? Date.parse(last.replace(' ', 'T') + 'Z') : Date.now();
}
const asOfIso = isoToSqlite(new Date(asOfMs).toISOString());
const cutoffIso = isoToSqlite(new Date(asOfMs - DAYS_WINDOW * 24 * 3600 * 1000).toISOString());
const minAgeCutoffIso = isoToSqlite(new Date(asOfMs - MIN_AGE_DAYS * 24 * 3600 * 1000).toISOString());

const productStats = db.prepare(`
  SELECT
    COUNT(*)                AS total,
    MIN(first_seen_at)      AS first_seen,
    MAX(first_seen_at)      AS last_new_product,
    MAX(last_checked_at)    AS last_checked
  FROM products
  WHERE source_url = ?
`);

// Fallback age signal: static targets can fetch (and get 304) without
// producing any products. source_cache is only populated on HTTP fetches, so
// dynamic-only targets don't have rows here.
const sourceCacheAgeStmt = (() => {
  try {
    return db.prepare(`SELECT last_full_fetch_at FROM source_cache WHERE source_url = ?`);
  } catch {
    return null; // old DB without source_cache table
  }
})();

// Any user-visible alert ever tied to a product from this source.
const alertsForSource = db.prepare(`
  SELECT
    COUNT(*)     AS total,
    MAX(sent_at) AS last_alert
  FROM alert_log al
  JOIN products p
    ON json_extract(al.details, '$.productId') = p.product_id
   AND p.source_url = ?
  WHERE al.event_type IN ('new_product', 'stock_change')
`);

const recentAlertsForSource = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM alert_log al
  JOIN products p
    ON json_extract(al.details, '$.productId') = p.product_id
   AND p.source_url = ?
  WHERE al.event_type IN ('new_product', 'stock_change')
    AND al.sent_at >= ?
    AND al.sent_at <= ?
`);

const results = targets.map((t) => {
  const ps = productStats.get(t.url) || { total: 0 };
  const as = alertsForSource.get(t.url) || { total: 0 };
  const ra = recentAlertsForSource.get(t.url, cutoffIso, asOfIso) || { cnt: 0 };
  const cache = sourceCacheAgeStmt ? sourceCacheAgeStmt.get(t.url) : null;

  // Best available "known since" signal, in order of reliability.
  const knownSince = ps.first_seen || (cache && cache.last_full_fetch_at) || null;

  return {
    url: t.url,
    products: ps.total,
    firstSeen: ps.first_seen,
    knownSince,
    lastNewProduct: ps.last_new_product,
    lastChecked: ps.last_checked,
    alertsTotal: as.total,
    lastAlert: as.last_alert,
    alertsRecent: ra.cnt,
  };
});

// Bucket classification. Order matters — earlier buckets are more concerning.
// Age filter only applies to DEAD / BOOTSTRAP_ONLY, because DORMANT already
// requires past alerts (implicitly old enough) and ACTIVE is inherently OK.
function classify(r) {
  const tooYoung = r.knownSince != null && r.knownSince >= minAgeCutoffIso;
  if (r.products === 0 && r.knownSince == null) return 'UNKNOWN_AGE';
  if (r.products === 0) return tooYoung ? 'TOO_YOUNG' : 'DEAD';
  if (r.alertsTotal === 0) return tooYoung ? 'TOO_YOUNG' : 'BOOTSTRAP_ONLY';
  if (r.alertsRecent === 0) return 'DORMANT';
  return 'ACTIVE';
}

const buckets = { DEAD: [], BOOTSTRAP_ONLY: [], DORMANT: [], ACTIVE: [], TOO_YOUNG: [], UNKNOWN_AGE: [] };
results.forEach((r) => { buckets[classify(r)].push(r); });

if (AS_JSON) {
  console.log(JSON.stringify({
    windowDays: DAYS_WINDOW,
    minAgeDays: MIN_AGE_DAYS,
    asOf: asOfIso,
    cutoff: cutoffIso,
    minAgeCutoff: minAgeCutoffIso,
    totals: {
      total: targets.length,
      dead: buckets.DEAD.length,
      bootstrapOnly: buckets.BOOTSTRAP_ONLY.length,
      dormant: buckets.DORMANT.length,
      active: buckets.ACTIVE.length,
      tooYoung: buckets.TOO_YOUNG.length,
      unknownAge: buckets.UNKNOWN_AGE.length,
    },
    buckets,
  }, null, 2));
  process.exit(0);
}

// Human-readable report
console.log(`\n=== find-silent-targets.js — window ${DAYS_WINDOW}d, min-age ${MIN_AGE_DAYS}d, as of ${asOfIso} ===`);
console.log(`Total targets: ${targets.length}   |   ACTIVE: ${buckets.ACTIVE.length}   |   attention: ${buckets.DEAD.length + buckets.BOOTSTRAP_ONLY.length + buckets.DORMANT.length}   |   pending: ${buckets.TOO_YOUNG.length + buckets.UNKNOWN_AGE.length}`);
console.log(`  DEAD:           ${buckets.DEAD.length}          — 0 products, tracked ≥${MIN_AGE_DAYS}d`);
console.log(`  BOOTSTRAP_ONLY: ${buckets.BOOTSTRAP_ONLY.length}          — products but no alerts, tracked ≥${MIN_AGE_DAYS}d`);
console.log(`  DORMANT:        ${buckets.DORMANT.length}          — silent in the last ${DAYS_WINDOW}d`);
console.log(`  TOO_YOUNG:      ${buckets.TOO_YOUNG.length}          — < ${MIN_AGE_DAYS}d since first observation`);
console.log(`  UNKNOWN_AGE:    ${buckets.UNKNOWN_AGE.length}          — no products AND no fetch record`);

// Top-3 hosts contributing to problem buckets — quick "who's the noisy one".
function topHosts(entries, limit = 3) {
  const counts = {};
  entries.forEach((r) => {
    const h = hostOf(r.url);
    counts[h] = (counts[h] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
}
const attentionEntries = [...buckets.DEAD, ...buckets.BOOTSTRAP_ONLY, ...buckets.DORMANT];
if (attentionEntries.length > 0) {
  const tops = topHosts(attentionEntries);
  if (tops.length > 0 && tops[0][1] > 1) {
    console.log(`\nTop hosts com mais problemas: ${tops.map(([h, c]) => `${h}×${c}`).join(', ')}`);
  }
}

if (SUMMARY_ONLY) {
  console.log('');
  process.exit(0);
}

// Compact mode: one line per entry, no indented metadata block.
function printBucket(name, header, entries, formatCompact, formatFull, sort) {
  if (entries.length === 0) return;
  const sorted = sort ? [...entries].sort(sort) : entries;
  console.log(`\n--- ${name} (${header}) — ${entries.length} target(s) ---`);
  sorted.forEach((r) => {
    if (COMPACT) {
      console.log(`  ${formatCompact(r)}`);
    } else {
      console.log(`  ${r.url}`);
      console.log(`      ${formatFull(r)}`);
    }
  });
}

printBucket(
  'DEAD',
  `0 products, tracked ≥${MIN_AGE_DAYS}d`,
  buckets.DEAD,
  (r) => `${r.url}  [known_since ${r.knownSince}]`,
  (r) => `known_since: ${r.knownSince}, last_checked: ${r.lastChecked || 'never'}`
);

printBucket(
  'BOOTSTRAP_ONLY',
  `products, no alerts, tracked ≥${MIN_AGE_DAYS}d`,
  buckets.BOOTSTRAP_ONLY,
  (r) => `${r.url}  [${r.products} products, since ${r.firstSeen}]`,
  (r) => `products: ${r.products}, baseline: ${r.firstSeen}, last_checked: ${r.lastChecked}`
);

printBucket(
  'DORMANT',
  `no alerts in last ${DAYS_WINDOW}d`,
  buckets.DORMANT,
  (r) => `${r.url}  [last_alert ${r.lastAlert}, ${r.alertsTotal} total]`,
  (r) => `last_alert: ${r.lastAlert} (${r.alertsTotal} total)`,
  (a, b) => String(a.lastAlert).localeCompare(String(b.lastAlert))
);

printBucket(
  'TOO_YOUNG',
  `< ${MIN_AGE_DAYS}d — check again later`,
  buckets.TOO_YOUNG,
  (r) => `${r.url}  [since ${r.knownSince}]`,
  (r) => `known_since: ${r.knownSince}, products: ${r.products}, alerts: ${r.alertsTotal}`
);

printBucket(
  'UNKNOWN_AGE',
  '0 products AND no fetch record',
  buckets.UNKNOWN_AGE,
  (r) => r.url,
  () => '(no signal — retry after next cycle)'
);

console.log(`\n=== end ===\n`);
