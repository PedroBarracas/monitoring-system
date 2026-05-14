/**
 * verify-stock-filter.js — detects which stores support an "in stock only" URL
 * filter and rewrites their listing URLs to use it.
 *
 * The in-stock filter is platform-specific and not always supported, so this
 * never guesses blindly. For each URL it detects the platform, then confirms
 * the filter with an extractor-independent test:
 *   - count drop  — the in-stock page lists strictly fewer products than the
 *                   unfiltered page, OR
 *   - in vs out   — the in-stock view differs from the out-of-stock view
 *                   (a store that ignores the param returns identical pages).
 * Neither test trusts our own stock detection. Sites that ignore the param keep
 * their original URL.
 *
 * Rate limits: card shops (esp. Shopify) throttle aggressively, so the run is
 * deliberately gentle and INCREMENTAL — if a prior <name>_filter-report.json
 * exists, stores with a definitive outcome are reused and only the rate-limited
 * `error` stragglers are re-checked. Re-run a few times to converge. `--fresh`
 * ignores the prior report.
 *
 * Usage:  node scripts/verify-stock-filter.js [--file data/links_pokemon.json] [--fresh]
 * Effect: rewrites `url` in place (and adds `stockFilter`) for supported stores;
 *         writes data/<name>_filter-report.json with the per-store outcome.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const jsonldExtractor = require('../src/extractors/jsonld-extractor');
const heuristicExtractor = require('../src/extractors/heuristic-extractor');
const { createLimiter } = require('../src/utils/concurrency');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 15000;
const CONCURRENCY = 4;
const MIN_BASE_PRODUCTS = 2; // need a few products on the unfiltered page to verify against
const MAX_CANDIDATES = 4;    // cap filter params tried per store (bounds fetch count)
const RETRY_429 = 2;         // extra attempts on rate-limit, with exponential backoff

// PrestaShop's availability facet is localised; used only when the page's own
// filter links can't be scraped. [facetName, inStockValue, outOfStockValue]
const PRESTASHOP_FALLBACKS = [
  ['Availability', 'In stock', 'Out of stock'],
  ['Disponibilidad', 'En stock', 'Sin stock'],
  ['Disponibilité', 'En stock', 'Rupture de stock'],
];

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    const html = await r.text();
    return { ok: r.ok, status: r.status, html, retryAfter: r.headers.get('retry-after'), error: null };
  } catch (err) {
    return { ok: false, status: null, html: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Gentle fetch: small jitter to desync the pool, exponential backoff on 429.
async function fetchHtml(url) {
  await sleep(Math.random() * 300);
  let res = await fetchOnce(url);
  for (let attempt = 1; attempt <= RETRY_429 && res.status === 429; attempt++) {
    const base = parseFloat(res.retryAfter) * 1000 || 3000 * Math.pow(2, attempt - 1);
    await sleep(Math.min(base, 20000) + Math.random() * 500);
    res = await fetchOnce(url);
  }
  return res;
}

function detectPlatform(html) {
  const h = html.toLowerCase();
  if (h.includes('cdn.shopify.com') || h.includes('/cdn/shop/') || h.includes('shopify.theme') || h.includes('window.shopify')) {
    return 'shopify';
  }
  if (h.includes('woocommerce') || h.includes('wp-content/plugins/woocommerce')) return 'woocommerce';
  if (h.includes('prestashop')) return 'prestashop';
  return 'unknown';
}

// True if the URL already carries some form of in-stock filter.
function alreadyFiltered(url) {
  const l = url.toLowerCase();
  if (l.includes('filter.v.availability=1')) return true;
  if (l.includes('stock_status=instock') || l.includes('filter_status=instock')) return true;
  if (/[?&]q=[^&]*(in[+%20 ]?stock|en[+%20 ]?stock|disponib|auf[+%20 ]?lager|op[+%20 ]?voorraad)/i.test(url)) return true;
  return false;
}

// Scrape PrestaShop's own availability facet links so we use the store's real
// (localised) facet name and values rather than guessing.
function prestashopFilters(html, baseUrl) {
  const $ = cheerio.load(html);
  const IN = /(in stock|en stock|disponib|auf lager|op voorraad|raktáron|in magazzino|på lager|tillgäng)/;
  const OUT = /(out of stock|sin stock|rupture|agotad|ausverkauft|esaurit|sem stock|niet op voorraad|nicht auf lager|non disponib)/;
  const facets = {}; // facetName -> { in, out }

  $('a[href*="q="]').each((_i, el) => {
    let q;
    try {
      q = new URL($(el).attr('href') || '', baseUrl).searchParams.get('q');
    } catch {
      return;
    }
    if (!q) return;
    const dec = decodeURIComponent(q);
    const dash = dec.indexOf('-');
    if (dash < 1) return;
    const name = dec.slice(0, dash);
    const value = dec.slice(dash + 1);
    const low = value.toLowerCase();
    facets[name] = facets[name] || {};
    if (OUT.test(low)) facets[name].out = facets[name].out || value;
    else if (IN.test(low)) facets[name].in = facets[name].in || value;
  });

  const filters = [];
  for (const [name, vals] of Object.entries(facets)) {
    if (vals.in) {
      filters.push({ key: 'q', inValue: `${name}-${vals.in}`, outValue: vals.out ? `${name}-${vals.out}` : null });
    }
  }
  if (filters.length === 0) {
    for (const [name, inV, outV] of PRESTASHOP_FALLBACKS) {
      filters.push({ key: 'q', inValue: `${name}-${inV}`, outValue: `${name}-${outV}` });
    }
  }
  return filters;
}

// Candidate in-stock / out-of-stock filter pairs for the detected platform.
// `outValue` lets us test whether the store actually honours the filter without
// trusting our own stock detection.
function candidateFilters(platform, html, baseUrl) {
  if (platform === 'shopify') {
    return [{ key: 'filter.v.availability', inValue: '1', outValue: '0' }];
  }
  if (platform === 'woocommerce') {
    return [
      { key: 'stock_status', inValue: 'instock', outValue: 'outofstock' },
      { key: 'filter_status', inValue: 'instock', outValue: 'outofstock' },
    ];
  }
  if (platform === 'prestashop') {
    return prestashopFilters(html, baseUrl);
  }
  return [];
}

function applyFilter(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.href;
}

function extractIds(html, url) {
  let products = jsonldExtractor.extract(html, url);
  if (products.length === 0) products = heuristicExtractor.extract(html, url);
  return new Set(products.map((p) => p.productId));
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

async function verify(entry) {
  const url = entry.url;
  if (alreadyFiltered(url)) {
    return { store: entry.store, outcome: 'already-filtered', note: 'URL already carries an in-stock filter' };
  }

  const baseRes = await fetchHtml(url);
  if (!baseRes.ok || !baseRes.html) {
    return { store: entry.store, outcome: 'error', note: `base fetch failed: HTTP ${baseRes.status || baseRes.error}` };
  }

  const platform = detectPlatform(baseRes.html);
  const base = extractIds(baseRes.html, url);
  if (base.size < MIN_BASE_PRODUCTS) {
    return { store: entry.store, platform, outcome: 'inconclusive', note: `unfiltered page extracted ${base.size} products — too few to verify` };
  }

  const filters = candidateFilters(platform, baseRes.html, url).slice(0, MAX_CANDIDATES);
  if (filters.length === 0) {
    return {
      store: entry.store,
      platform,
      outcome: 'unsupported',
      note: platform === 'unknown' ? 'platform not recognised' : `no known in-stock filter for ${platform}`,
    };
  }

  const attempts = [];
  let inconclusive = false;
  let hadFetchError = false;
  let hadUsableComparison = false;

  for (const f of filters) {
    const inUrl = applyFilter(url, f.key, f.inValue);
    const inRes = await fetchHtml(inUrl);
    if (!inRes.ok || !inRes.html) {
      attempts.push({ filter: `${f.key}=${f.inValue}`, status: inRes.status, error: inRes.error });
      hadFetchError = true;
      continue;
    }
    const inSet = extractIds(inRes.html, inUrl);
    const inSubset = [...inSet].every((id) => base.has(id));
    if (inSet.size === 0 || !inSubset) {
      attempts.push({ filter: `${f.key}=${f.inValue}`, baseCount: base.size, inCount: inSet.size, inSubset });
      continue; // empty or not a clean subset — unusable
    }
    hadUsableComparison = true;

    // test 1: count drop — the in-stock page lists strictly fewer products
    if (inSet.size < base.size) {
      attempts.push({ filter: `${f.key}=${f.inValue}`, baseCount: base.size, inCount: inSet.size, test: 'count-drop' });
      return accepted(entry, platform, f, inUrl, 'high (fewer products than unfiltered)', base.size, inSet.size, attempts);
    }

    // test 2: in vs out — equal count, so check the in-stock view differs from
    // the out-of-stock view (a store that ignores the param returns the same page)
    if (f.outValue) {
      const outUrl = applyFilter(url, f.key, f.outValue);
      const outRes = await fetchHtml(outUrl);
      if (outRes.ok && outRes.html) {
        const outSet = extractIds(outRes.html, outUrl);
        const identical = sameSet(inSet, outSet);
        attempts.push({
          filter: `${f.key}=${f.inValue}`,
          baseCount: base.size,
          inCount: inSet.size,
          outCount: outSet.size,
          test: 'in-vs-out',
          discriminates: !identical,
        });
        if (!identical) {
          return accepted(entry, platform, f, inUrl, 'high (in-stock view differs from out-of-stock view)', base.size, inSet.size, attempts);
        }
        continue; // identical → param ignored, try the next candidate
      }
      hadFetchError = true;
    }

    // equal count and no usable out-of-stock control — can't confirm either way
    attempts.push({ filter: `${f.key}=${f.inValue}`, baseCount: base.size, inCount: inSet.size, test: 'inconclusive (equal count, no out-of-stock control)' });
    inconclusive = true;
  }

  // never got a usable comparison and the fetches were failing → it's an error,
  // not a genuine "unsupported" — so an incremental re-run will retry it
  if (!hadUsableComparison && hadFetchError) {
    return { store: entry.store, platform, outcome: 'error', note: 'all candidate fetches failed (blocked or rate-limited)', attempts };
  }
  if (inconclusive) {
    return { store: entry.store, platform, outcome: 'inconclusive', note: 'filter param accepted but could not be confirmed to actually filter', attempts };
  }
  return { store: entry.store, platform, outcome: 'unsupported', note: 'filter param had no effect (in-stock and out-of-stock views identical)', attempts };
}

function accepted(entry, platform, f, url, confidence, baseCount, filteredCount, attempts) {
  return { store: entry.store, platform, outcome: 'applied', filter: `${f.key}=${f.inValue}`, url, confidence, baseCount, filteredCount, attempts };
}

async function main() {
  const file = argValue('--file') || path.join('data', 'links_pokemon.json');
  const filePath = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
  const reportPath = filePath.replace(/\.json$/, '_filter-report.json');
  const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // incremental: reuse definitive outcomes from a prior report, only re-check `error`s
  const prior = new Map();
  if (!hasFlag('--fresh') && fs.existsSync(reportPath)) {
    for (const r of JSON.parse(fs.readFileSync(reportPath, 'utf8'))) {
      if (r.outcome && r.outcome !== 'error') prior.set(r.store, r);
    }
  }
  const reused = prior.size;
  console.log(`[stock-filter] ${entries.length} URLs from ${file}  (reusing ${reused} prior results, re-checking ${entries.length - reused})`);

  const limiter = createLimiter(CONCURRENCY);
  let done = 0;
  const results = await Promise.all(
    entries.map((entry, i) =>
      limiter(async () => {
        const r = prior.get(entry.store) || (await verify(entry));
        done++;
        if (done % 20 === 0 || done === entries.length) console.log(`[stock-filter] ${done}/${entries.length}`);
        return { i, r };
      })
    )
  );

  // apply verified filters back onto the entries (skip ones already rewritten)
  let applied = 0;
  for (const { i, r } of results) {
    if (r.outcome === 'applied' && !entries[i].stockFilter) {
      entries[i].url = r.url;
      entries[i].stockFilter = r.filter;
      applied++;
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
  fs.writeFileSync(reportPath, JSON.stringify(results.map((x) => x.r), null, 2));

  const byOutcome = {};
  for (const { r } of results) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;

  console.log('\n[stock-filter] done');
  console.log(`  newly applied this run: ${applied}`);
  console.log(`  outcomes: ${JSON.stringify(byOutcome)}`);
  if (byOutcome.error) console.log(`  ${byOutcome.error} still rate-limited/blocked — re-run to retry just those`);
  console.log(`  full report -> ${reportPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
