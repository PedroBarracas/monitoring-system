/**
 * Compares prices across stores to find the ones that are consistently
 * expensive — useful to prune targets that alert a lot but never at a price
 * worth buying.
 *
 * How it works:
 *   1. Load every live (non-removed) product with a price, convert to EUR.
 *   2. Fingerprint each title into a comparable key:
 *        game | set | product type | language
 *      e.g. "one-piece|OP-09|booster-box|EN" or "pokemon|surging sparks|etb|EN".
 *      Pokémon is compared on standard Elite Trainer Boxes only — one per set,
 *      so like-for-like across stores; other Pokémon SKUs are skipped.
 *      Titles we can't fingerprint (no recognisable set or type) are skipped —
 *      run with --unmatched to see samples. Pokémon set names are read from
 *      data/pokemon-sets.json, which is built from --discover-sets output.
 *   3. For each key sold by >= --min-stores distinct stores, take each store's
 *      cheapest listing and compute the market median.
 *   4. Each store's score = median of (its price / market median) across every
 *      key it sells. 1.00 = at market, 1.20 = typically 20% above market.
 *
 * Usage:
 *   node scripts/compare-store-prices.js                  # defaults
 *   node scripts/compare-store-prices.js --until 2026-11-16
 *   node scripts/compare-store-prices.js --threshold 1.15 --min-stores 3 --min-keys 3
 *   node scripts/compare-store-prices.js --in-stock-only  # ignore out-of-stock listings
 *   node scripts/compare-store-prices.js --strict-lang    # don't assume unlabelled titles are English
 *   node scripts/compare-store-prices.js --store kidult   # per-product breakdown for hosts matching "kidult"
 *   node scripts/compare-store-prices.js --groups         # print every comparable product group
 *   node scripts/compare-store-prices.js --unmatched      # sample titles we couldn't fingerprint
 *   node scripts/compare-store-prices.js --json
 *   node scripts/compare-store-prices.js --discover-sets  # recurring phrases in Pokémon titles, to build data/pokemon-sets.json
 *
 * Freshness: only products checked within --fresh-days (default 7) of the
 * "as of" date count. "As of" = --until YYYY-MM-DD, or the DB's latest
 * products.last_checked_at (when the monitor last ran).
 *
 * Reads DB_PATH from env (falls back to ./data/monitoring.db). EUR rates come
 * from the app's defaults plus CURRENCY_RATES_EUR overrides.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DEFAULT_EUR_RATES } = require('../src/config');
const { convertToEur } = require('../src/utils/price');

// ---------- CLI ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const AS_JSON = flag('--json');
const SHOW_GROUPS = flag('--groups');
const SHOW_UNMATCHED = flag('--unmatched');
const IN_STOCK_ONLY = flag('--in-stock-only');
const STRICT_LANG = flag('--strict-lang');
const STORE_FILTER = opt('--store', null);
const THRESHOLD = parseFloat(opt('--threshold', '1.15'));
const MIN_STORES = parseInt(opt('--min-stores', '3'), 10);
const MIN_KEYS = parseInt(opt('--min-keys', '3'), 10);
const FRESH_DAYS = parseInt(opt('--fresh-days', '7'), 10);
// Ratios outside this band are almost always a fingerprint mismatch (a single
// pack keyed as a box, a case keyed as a box) rather than a real price —
// excluded from scoring so one bad match can't sink a store.
const MAX_RATIO = 3;
const MIN_RATIO = 1 / 3;

const TARGETS_PATH = path.join(__dirname, '..', 'data', 'product-targets.json');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'monitoring.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const targets = fs.existsSync(TARGETS_PATH) ? JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')) : [];
const targetByUrl = new Map(targets.map((t) => [t.url, t]));

let rateOverrides = {};
try { rateOverrides = JSON.parse(process.env.CURRENCY_RATES_EUR || '{}') || {}; } catch { /* ignore */ }
const EUR_RATES = { ...DEFAULT_EUR_RATES, ...rateOverrides };

function isoToSqlite(iso) {
  return iso.replace('T', ' ').slice(0, 19);
}

let asOfMs;
const until = opt('--until', null);
if (until) {
  asOfMs = Date.parse(`${until}T23:59:59Z`);
  if (Number.isNaN(asOfMs)) {
    console.error(`Invalid --until date "${until}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }
} else {
  const { last } = db.prepare('SELECT MAX(last_checked_at) AS last FROM products').get();
  asOfMs = last ? Date.parse(last.replace(' ', 'T') + 'Z') : Date.now();
}
const asOfIso = isoToSqlite(new Date(asOfMs).toISOString());
const freshCutoffIso = isoToSqlite(new Date(asOfMs - FRESH_DAYS * 24 * 3600 * 1000).toISOString());

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// ---------- Fingerprinting ----------

// Strip accents so "Pokémon"/"español"/"élite" match plain ASCII patterns,
// drop apostrophes ("Sea’s" / "Sea's" → "seas") and fold the Unicode dash
// variants stores paste in ("OP‑13" with a non-breaking hyphen) to "-".
function normalize(title) {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`´]/g, '')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase();
}

function gameOf(title, sourceUrl) {
  const t = normalize(title);
  if (/\bpokemon\b/.test(t)) return 'pokemon';
  if (/one[\s-]?piece/.test(t)) return 'one-piece';
  const target = targetByUrl.get(sourceUrl);
  if (target && target.category) return target.category;
  const u = normalize(sourceUrl);
  if (u.includes('pokemon')) return 'pokemon';
  if (/one[-_+]?piece|one%20piece/.test(u)) return 'one-piece';
  // One Piece set codes are distinctive enough to imply the game on their own.
  if (/\b(op|eb|prb)[-_\s]?\d{1,2}\b/.test(t)) return 'one-piece';
  return null;
}

// Set-name dictionaries, built from the titles the stores actually use (see
// --discover-sets / --unmatched) — not from a hand-written list.
// Format: { "canonical set": ["alias as it appears in titles", ...] }.
// Aliases are matched accent-stripped and case-insensitive on word
// boundaries. FILE ORDER IS PRIORITY: the first entry with a matching alias
// wins, so a series-wide name like "mega evolution" (which prefixes every
// set in that series) goes last as the base-set fallback.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadSetFile(file) {
  const p = path.join(__dirname, '..', 'data', file);
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Object.entries(raw).map(([canonical, aliases]) => [
    canonical,
    [canonical, ...(aliases || [])]
      .map((a) => normalize(String(a)).trim())
      .filter(Boolean)
      .map((a) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(a)}($|[^a-z0-9])`)),
  ]);
}

function matchSet(dict, t) {
  for (const [canonical, res] of dict) if (res.some((re) => re.test(t))) return canonical;
  return null;
}

const POKEMON_SETS = loadSetFile('pokemon-sets.json');
// One Piece name → code, for titles that carry the set name but no code
// ("Carrying on his Will Booster Box"). Keys are the codes.
const ONE_PIECE_SETS = loadSetFile('one-piece-sets.json');

// One Piece: OP-01..OP-1x, EB-0x (extra boosters), PRB-0x (premium boosters).
// The code wins when present; otherwise fall back to the set name.
function onePieceSet(t) {
  const m = t.match(/\b(op|eb|prb)[-_\s]?0?(\d{1,2})\b/);
  if (m) return `${m[1].toUpperCase()}-${m[2].padStart(2, '0')}`;
  return matchSet(ONE_PIECE_SETS, t);
}

function pokemonSet(t) {
  return matchSet(POKEMON_SETS, t);
}

// Product type. First match wins, so bigger/more specific formats go first:
// a "booster box case" is a case, an "ETB" is never a "booster", etc.
const TYPES = [
  ['case', /\bcase\b|\bcaisse\b|\bkarton\b|\bcaja (de )?(12|6) /],
  ['premium-collection', /premium (collection|box)|super[\s-]?premium|ultra[\s-]?premium|\bupc\b|\bspc\b/],
  ['etb', /elite trainer|\betb\b|top[\s-]?trainer|dresseur d.?elite|entrenador (de )?elite|allenatore fuoriclasse/],
  ['booster-bundle', /booster bundle|\bbundle\b|buste di espansione.*6|lot de 6 boosters/],
  ['half-box', /half[\s-]?(box|display)|mini[\s-]?display|\b18 (booster|pack|sobres)/],
  ['booster-box', /booster[\s-]?(box|display|kiste)|\bdisplay\b|caja (de )?sobres|boite de boosters|box di buste|\b(24|30|36) (booster|pack|sobres|buste)|\bbox\b.*\b(24|36)\b/],
  ['blister', /\bblister\b|\bcheckland\b/],
  ['tin', /\btin\b|\blata\b|\bboite metal|\bmetallbox\b|\bscatola da collezione in latta/],
  ['sleeved-booster', /sleeved booster|booster in busta/],
  ['booster-pack', /booster[\s-]?pack|\bsobre\b|\bbusta\b|\bsingle booster|\bbooster\b(?!.*\b(box|display|bundle)\b)/],
  // Last resort: a bare "BOX" / "Caja" next to a set code ("OP16 – BOX –
  // RESERVA", "Op 07.Caja") is a booster box in practice.
  ['booster-box', /\bbox\b|\bcaja\b/],
];

function typeOf(t) {
  for (const [key, re] of TYPES) if (re.test(t)) return key;
  return null;
}

// Full language words, matched on the accent-stripped lowercase title.
const LANGS = [
  // "(Non-English)" must be checked before EN, or "english" claims it.
  ['NON-EN', /\bnon[\s-]?english\b|\bnot english\b/],
  ['JP', /\b(japanese|japan|jap|jpn|japones|japonais|japanisch|giapponese)\b/],
  ['KR', /\b(korean|coreano|coreen|koreanisch)\b/],
  ['CN', /\b(chinese|chinois|chino|cinese|chinesisch|simplified chinese|traditional chinese)\b/],
  ['DE', /\b(german|deutsch|aleman|allemand|tedesco)\b/],
  ['FR', /\b(french|francais|frances|francese|franzosisch)\b/],
  ['ES', /\b(spanish|espanol|castellano|espagnol|spagnolo|spanisch)\b/],
  ['IT', /\b(italian|italiano|italien|italienisch|ita)\b/],
  ['PT', /\b(portuguese|portugues)\b/],
  ['EN', /\b(english|ingles|anglais|englisch|inglese|eng)\b/],
];
// Two-letter codes collide with real words ("caja de sobres", "es", "it"), so
// they only count UPPERCASE in the original title: "OP-09 Booster Box EN".
const LANG_CODES = /\b(JP|JPN|KR|CN|DE|FR|ES|ESP|IT|ITA|PT|EN|ENG)\b/;
const LANG_CODE_ALIASES = { JPN: 'JP', ESP: 'ES', ITA: 'IT', ENG: 'EN' };

function langOf(t, rawTitle) {
  for (const [key, re] of LANGS) if (re.test(t)) return key;
  const m = rawTitle.match(LANG_CODES);
  if (m) return LANG_CODE_ALIASES[m[1]] || m[1];
  // Unmarked titles are English in practice: JP/other imports get labelled
  // because they're the exception, and a translated Pokémon set name already
  // pins the language via the set key. --strict-lang keeps them apart instead.
  return STRICT_LANG ? '?' : 'EN';
}

// Pokémon sets ship many SKUs (bundles, tins, blisters, collections), but
// every set has exactly one standard Elite Trainer Box — so ETBs are the
// only Pokémon product compared. Pokémon Center ETBs are a pricier variant
// and are left out so they don't inflate the median.
function isStandardEtb(t) {
  return typeOf(t) === 'etb' && !/pokemon center/.test(t);
}

function fingerprint(title, sourceUrl) {
  const t = normalize(title);
  const game = gameOf(title, sourceUrl);
  if (!game) return { key: null, reason: 'game' };
  if (game === 'pokemon' && !isStandardEtb(t)) return { key: null, reason: 'not-etb' };
  const set = game === 'one-piece' ? onePieceSet(t) : game === 'pokemon' ? pokemonSet(t) : null;
  if (!set) return { key: null, reason: 'set' };
  const type = typeOf(t);
  if (!type) return { key: null, reason: 'type' };
  return { key: `${game}|${set}|${type}|${langOf(t, title)}`, reason: null };
}

// ---------- Set discovery (--discover-sets) ----------

// Words that are never part of a set name: game/brand words, product types,
// languages, connectives. They act as phrase separators, so "Pokémon Surging
// Sparks Booster Box EN" yields the candidate phrase "surging sparks".
const NOISE = new Set(`
  pokemon tcg jcc gcc ccg card cards game trading jeu jeux cartes carte juego cartas gioco sammelkartenspiel sammelkarten kartenspiel
  booster boosters box boxes display displays pack packs elite trainer etb bundle bundles tin tins blister blisters collection collections
  premium ultra super special case caja cajas sobre sobres coffret coffrets dresseur dresseurs busta buste top mini half sleeved checklane
  entrenador allenatore fuoriclasse lata scatola boite metal sealed new preorder pre order reserva precommande vorbestellung prevendita
  english ingles anglais englisch inglese eng en japanese jap jp jpn japones japonais japanisch giapponese german deutsch aleman allemand
  tedesco de french francais frances francese fr spanish espanol castellano espagnol spagnolo es italian italiano italien ita it
  portuguese portugues pt korean kr chinese cn version edition ed
  the a of and und et y e o di del della der die das des du la le les el los las von al ex
`.split(/\s+/).filter(Boolean));

function discoverSets(products) {
  const grams = new Map(); // phrase → { hosts:Set, titles, example }
  const codes = new Map();
  let pokemonTitles = 0;
  // Only ETB titles: they're the only Pokémon product compared, and their
  // titles are the cleanest source of set names (one per set).
  for (const p of products) {
    if (gameOf(p.title, p.source_url) !== 'pokemon') continue;
    if (!isStandardEtb(normalize(p.title))) continue;
    pokemonTitles++;
    const host = hostOf(p.source_url);
    const t = normalize(p.title);
    // Set codes like SV08, SV8.5, ME02, SWSH12 — counted separately.
    for (const m of t.matchAll(/\b(sv|me|swsh|sm)\s?-?(\d{1,2}(?:\.\d|[a-z])?)\b/g)) {
      const code = `${m[1].toUpperCase()}${m[2]}`;
      if (!codes.has(code)) codes.set(code, { hosts: new Set(), example: p.title });
      codes.get(code).hosts.add(host);
    }
    // Split into runs of non-noise, non-numeric words; every 1–4 word
    // sub-phrase of a run is a candidate.
    const runs = [];
    let run = [];
    for (const w of t.split(/[^a-z0-9]+/).filter(Boolean)) {
      if (NOISE.has(w) || /^\d+$/.test(w) || /^(sv|me|swsh|sm)\d/.test(w)) {
        if (run.length) runs.push(run);
        run = [];
      } else {
        run.push(w);
      }
    }
    if (run.length) runs.push(run);
    const seen = new Set();
    for (const r of runs) {
      for (let n = 1; n <= Math.min(4, r.length); n++) {
        for (let i = 0; i + n <= r.length; i++) {
          const phrase = r.slice(i, i + n).join(' ');
          if (seen.has(phrase)) continue;
          seen.add(phrase);
          if (!grams.has(phrase)) grams.set(phrase, { hosts: new Set(), titles: 0, example: p.title });
          const g = grams.get(phrase);
          g.hosts.add(host);
          g.titles++;
        }
      }
    }
  }

  // Drop phrases fully explained by a longer phrase with the same reach
  // ("surging" when "surging sparks" appears in exactly the same stores).
  const list = [...grams.entries()]
    .filter(([, g]) => g.hosts.size >= 2)
    .map(([phrase, g]) => ({ phrase, stores: g.hosts.size, titles: g.titles, example: g.example }));
  const kept = list.filter((a) => !list.some((b) =>
    b !== a && b.phrase.length > a.phrase.length && b.titles === a.titles &&
    ` ${b.phrase} `.includes(` ${a.phrase} `)));
  kept.sort((a, b) => b.stores - a.stores || b.titles - a.titles);

  const codeList = [...codes.entries()]
    .map(([code, c]) => ({ code, stores: c.hosts.size, example: c.example }))
    .sort((a, b) => b.stores - a.stores);

  if (AS_JSON) {
    console.log(JSON.stringify({ pokemonTitles, phrases: kept, codes: codeList }, null, 2));
    return;
  }
  console.log(`\n=== Set discovery — ${pokemonTitles} Pokémon ETB titles, phrases used by ≥2 stores ===`);
  console.log(`  ${'stores'.padStart(6)} ${'titles'.padStart(6)}  phrase  —  example title`);
  kept.slice(0, 250).forEach((g) =>
    console.log(`  ${String(g.stores).padStart(6)} ${String(g.titles).padStart(6)}  ${g.phrase}  —  ${g.example}`));
  if (kept.length > 250) console.log(`  … ${kept.length - 250} more (use --json for all)`);
  if (codeList.length) {
    console.log(`\n=== Set codes seen in titles ===`);
    codeList.forEach((c) => console.log(`  ${String(c.stores).padStart(6)}  ${c.code}  —  ${c.example}`));
  }
  console.log(`\n=== end ===\n`);
}

if (flag('--discover-sets')) {
  discoverSets(db.prepare('SELECT source_url, title FROM products WHERE removed = 0').all());
  process.exit(0);
}

// ---------- Data ----------

const rows = db.prepare(`
  SELECT source_url, product_id, product_url, title, in_stock, price, currency
  FROM products
  WHERE removed = 0
    AND price IS NOT NULL
    AND last_checked_at >= ?
    AND last_checked_at <= ?
    ${IN_STOCK_ONLY ? 'AND in_stock = 1' : ''}
`).all(freshCutoffIso, asOfIso);

// User-visible alert counts per source, up to the as-of date. Joined via the
// product_id inside alert_log.details, same as find-silent-targets.js.
const alertCountStmt = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM alert_log al
  JOIN products p
    ON json_extract(al.details, '$.productId') = p.product_id
   AND p.source_url = ?
  WHERE al.event_type IN ('new_product', 'stock_change')
    AND al.sent_at <= ?
`);

const unmatched = { game: [], set: [], type: [], 'not-etb': [] };
const noRate = new Set();
let matchedCount = 0;

// key → host → cheapest listing
const groups = new Map();

for (const r of rows) {
  const eur = convertToEur(r.price, r.currency || 'EUR', EUR_RATES);
  if (eur == null) { noRate.add(r.currency); continue; }
  const { key, reason } = fingerprint(r.title, r.source_url);
  if (!key) { unmatched[reason].push(r.title); continue; }
  matchedCount++;
  const host = hostOf(r.source_url);
  if (!groups.has(key)) groups.set(key, new Map());
  const g = groups.get(key);
  const price = parseFloat(eur);
  const prev = g.get(host);
  if (!prev || price < prev.price) {
    g.set(host, { price, title: r.title, sourceUrl: r.source_url, productUrl: r.product_url, inStock: r.in_stock });
  }
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- Scoring ----------

const stores = new Map(); // host → { ratios: [], items: [], sourceUrls: Set }
const comparableGroups = [];

for (const [key, byHost] of groups) {
  if (byHost.size < MIN_STORES) continue;
  const market = median([...byHost.values()].map((l) => l.price));
  const min = Math.min(...[...byHost.values()].map((l) => l.price));
  comparableGroups.push({ key, stores: byHost.size, median: market, min, listings: byHost });
  for (const [host, l] of byHost) {
    const ratio = l.price / market;
    if (!stores.has(host)) stores.set(host, { ratios: [], items: [], sourceUrls: new Set(), cheapest: 0, outliers: 0 });
    const s = stores.get(host);
    s.sourceUrls.add(l.sourceUrl);
    s.items.push({ key, price: l.price, median: market, ratio, title: l.title, inStock: l.inStock });
    if (ratio > MAX_RATIO || ratio < MIN_RATIO) { s.outliers++; continue; }
    s.ratios.push(ratio);
    if (l.price === min) s.cheapest++;
  }
}

// Include tracked hosts with no comparable products so they're visible too.
const trackedHosts = new Map();
for (const t of targets) {
  const h = hostOf(t.url);
  if (!trackedHosts.has(h)) trackedHosts.set(h, []);
  trackedHosts.get(h).push(t.url);
}

const report = [...trackedHosts.entries()].map(([host, urls]) => {
  const s = stores.get(host);
  const alerts = urls.reduce((n, u) => n + alertCountStmt.get(u, asOfIso).cnt, 0);
  if (!s || s.ratios.length === 0) {
    return { host, urls, alerts, keys: 0, score: null, verdict: 'NO_DATA' };
  }
  const score = median(s.ratios);
  const keys = s.ratios.length;
  let verdict;
  if (keys < MIN_KEYS) verdict = 'LOW_DATA';
  else if (score >= THRESHOLD) verdict = 'EXPENSIVE';
  else if (score <= 1 / THRESHOLD) verdict = 'CHEAP';
  else verdict = 'FAIR';
  return {
    host, urls, alerts, keys, score,
    abovePct: Math.round((s.ratios.filter((r) => r > 1.05).length / keys) * 100),
    cheapest: s.cheapest,
    outliers: s.outliers,
    verdict,
    items: s.items.sort((a, b) => b.ratio - a.ratio),
  };
});

const ORDER = { EXPENSIVE: 0, FAIR: 1, CHEAP: 2, LOW_DATA: 3, NO_DATA: 4 };
report.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || (b.score || 0) - (a.score || 0));

// ---------- Output ----------

if (AS_JSON) {
  console.log(JSON.stringify({
    asOf: asOfIso, freshDays: FRESH_DAYS, threshold: THRESHOLD, minStores: MIN_STORES, minKeys: MIN_KEYS,
    coverage: { priced: rows.length, matched: matchedCount, comparableGroups: comparableGroups.length },
    stores: report.map(({ items, ...r }) => (STORE_FILTER && r.host.includes(STORE_FILTER) ? { ...r, items } : r)),
  }, null, 2));
  process.exit(0);
}

const fmt = (n) => (n == null ? '   -  ' : n.toFixed(2));
const eur = (n) => `€${n.toFixed(2)}`;

console.log(`\n=== compare-store-prices.js — as of ${asOfIso}, products checked in the prior ${FRESH_DAYS}d ===`);
console.log(`Priced listings: ${rows.length}   |   fingerprinted: ${matchedCount} (${rows.length ? Math.round((matchedCount / rows.length) * 100) : 0}%)   |   comparable groups (≥${MIN_STORES} stores): ${comparableGroups.length}`);
console.log(`Unmatched — no game: ${unmatched.game.length}, no set: ${unmatched.set.length}, no type: ${unmatched.type.length}   |   Pokémon non-ETB (skipped by design): ${unmatched['not-etb'].length}${noRate.size ? `   |   unknown currency: ${[...noRate].join(', ')}` : ''}`);
console.log(`Score = median(store price / market median). EXPENSIVE ≥ ${THRESHOLD.toFixed(2)}, CHEAP ≤ ${(1 / THRESHOLD).toFixed(2)}, needs ≥ ${MIN_KEYS} comparable products.`);

const counts = report.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
console.log(`Stores: ${report.length}   |   EXPENSIVE: ${counts.EXPENSIVE || 0}   FAIR: ${counts.FAIR || 0}   CHEAP: ${counts.CHEAP || 0}   LOW_DATA: ${counts.LOW_DATA || 0}   NO_DATA: ${counts.NO_DATA || 0}`);

let currentVerdict = null;
for (const r of report) {
  if (r.verdict !== currentVerdict) {
    currentVerdict = r.verdict;
    console.log(`\n--- ${currentVerdict} ---`);
    console.log(`  ${'score'.padEnd(6)} ${'n'.padStart(3)} ${'>mkt'.padStart(5)} ${'best'.padStart(4)} ${'alerts'.padStart(6)}  host`);
  }
  const above = r.abovePct != null ? `${r.abovePct}%` : '-';
  console.log(`  ${fmt(r.score).padEnd(6)} ${String(r.keys).padStart(3)} ${above.padStart(5)} ${String(r.cheapest ?? '-').padStart(4)} ${String(r.alerts).padStart(6)}  ${r.host}${r.urls.length > 1 ? `  (${r.urls.length} targets)` : ''}`);
}
console.log(`\n  n = comparable products, >mkt = share priced >5% above median, best = times it was the cheapest store`);

if (STORE_FILTER) {
  for (const r of report.filter((x) => x.host.includes(STORE_FILTER))) {
    console.log(`\n=== ${r.host} — ${r.verdict}${r.score != null ? ` (score ${fmt(r.score)})` : ''} ===`);
    r.urls.forEach((u) => console.log(`  target: ${u}`));
    (r.items || []).forEach((i) => {
      const flagStr = i.ratio > MAX_RATIO || i.ratio < MIN_RATIO ? ' [outlier, ignored]' : '';
      console.log(`  ${fmt(i.ratio)}x  ${eur(i.price).padStart(9)} vs ${eur(i.median).padStart(9)}  ${i.key}${i.inStock ? '' : ' (OOS)'}${flagStr}`);
      console.log(`        ${i.title}`);
    });
  }
}

if (SHOW_GROUPS) {
  console.log(`\n=== Comparable groups ===`);
  comparableGroups.sort((a, b) => b.stores - a.stores).forEach((g) => {
    console.log(`\n  ${g.key} — ${g.stores} stores, median ${eur(g.median)}, min ${eur(g.min)}`);
    [...g.listings.entries()].sort((a, b) => a[1].price - b[1].price).forEach(([host, l]) => {
      console.log(`    ${eur(l.price).padStart(9)}  ${host}${l.inStock ? '' : ' (OOS)'}  — ${l.title}`);
    });
  });
}

if (SHOW_UNMATCHED) {
  for (const [reason, titles] of Object.entries(unmatched)) {
    if (titles.length === 0) continue;
    const label = reason === 'not-etb' ? 'Pokémon, not a standard ETB' : `no ${reason}`;
    console.log(`\n=== Unmatched (${label}) — ${titles.length}, sample ===`);
    [...new Set(titles)].slice(0, 40).forEach((t) => console.log(`  ${t}`));
  }
}

console.log(`\n=== end ===\n`);
