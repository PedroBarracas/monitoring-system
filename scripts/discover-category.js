/**
 * discover-category.js — finds category/listing pages for a trading-card game
 * across the store set we already know, by adapting URLs we have for other games.
 *
 * For every store we already monitor (data/product-targets.json) or have as a
 * raw candidate (data/links_stores_needs_work.json), it derives candidate URLs
 * for the requested game two ways:
 *   1. substitution — swap a known game's tokens in an existing URL's path/query
 *      for the target game's tokens (e.g. one-piece -> pokemon)
 *   2. nav scan — fetch the store's pages and collect <a> links whose href or
 *      text mentions the game
 * Each candidate is fetched and run through the real extractors; the first that
 * lists products wins. Results are staged for review — nothing is pushed live.
 *
 * Usage:  node scripts/discover-category.js <game> [--source targets|pool|both] [--limit N]
 * Writes: data/links_<game>.json          validated:  [{ store, url, strategy, method, productCount }]
 *         data/links_<game>_removed.json  rejected:   [{ store, reason, tried }]
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const jsonldExtractor = require('../src/extractors/jsonld-extractor');
const heuristicExtractor = require('../src/extractors/heuristic-extractor');
const { createLimiter } = require('../src/utils/concurrency');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TARGETS_PATH = path.join(DATA_DIR, 'product-targets.json');
const POOL_PATH = path.join(DATA_DIR, 'links_stores_needs_work.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 15000;
const CONCURRENCY = 10;
const MIN_PRODUCTS = 2;    // a real category page should list at least this many
const MAX_CANDIDATES = 12; // cap fetches per store

// Tokens used both to *detect* which game an existing URL belongs to and to
// *substitute* into URLs for the target game. `navKeywords` are matched against
// link href + text when scanning a store's navigation.
const GAMES = {
  'one-piece': {
    primary: 'one-piece',
    urlTokens: ['one-piece', 'one_piece', 'onepiece', 'one+piece', 'one%20piece'],
    navKeywords: ['one piece'],
  },
  'pokemon': {
    primary: 'pokemon',
    urlTokens: ['pokemon-tcg', 'pokemon_tcg', 'pokemon', 'pokémon'],
    navKeywords: ['pokemon', 'pokémon'],
  },
  'magic': {
    primary: 'magic',
    urlTokens: ['magic-the-gathering', 'mtg', 'magic'],
    navKeywords: ['magic the gathering', 'mtg'],
  },
  'yugioh': {
    primary: 'yugioh',
    urlTokens: ['yu-gi-oh', 'yugioh', 'yu_gi_oh'],
    navKeywords: ['yu-gi-oh', 'yugioh', 'yu gi oh'],
  },
};

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function detectGame(url) {
  const lower = url.toLowerCase();
  for (const [key, g] of Object.entries(GAMES)) {
    if (g.urlTokens.some((t) => lower.includes(t))) return key;
  }
  return null;
}

// Swap a known game's tokens in a reference URL for the target game's tokens.
function substitutionCandidates(refUrl, fromGame, toGame) {
  const from = GAMES[fromGame];
  const to = GAMES[toGame];
  const substTokens = to.substTokens || [to.primary, `${to.primary}-tcg`];
  const out = new Set();

  for (const newTok of substTokens) {
    let u = refUrl;
    let replaced = false;
    for (const oldTok of from.urlTokens) {
      if (u.toLowerCase().includes(oldTok)) {
        u = u.replace(new RegExp(escapeRegex(oldTok), 'gi'), newTok);
        replaced = true;
      }
    }
    if (replaced) {
      out.add(u);
      // game-specific filter params rarely carry over — also try without them
      const qIdx = u.indexOf('?');
      if (qIdx > -1) out.add(u.slice(0, qIdx));
    }
  }
  return [...out];
}

// Harvest same-host links whose href or text mentions the target game.
function navScanCandidates(html, baseUrl, toGame) {
  const $ = cheerio.load(html);
  const kws = GAMES[toGame].navKeywords;
  const baseHost = hostOf(baseUrl);
  const found = new Set();

  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    const text = ($(el).text() || '').toLowerCase();
    if (!kws.some((k) => (href + ' ' + text).toLowerCase().includes(k))) return;

    let abs;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    if (abs.hostname.replace(/^www\./, '') !== baseHost) return;
    found.add(abs.href.split('#')[0]);
  });

  // rank category-looking URLs ahead of product-detail pages
  const score = (u) => {
    const l = u.toLowerCase();
    let s = 0;
    if (/\/(collections?|categor|c)\//.test(l)) s += 3;
    if (l.includes('tcg') || l.includes('card')) s += 1;
    if (/\/products?\//.test(l)) s -= 2;
    return -s;
  };
  return [...found].sort((a, b) => score(a) - score(b));
}

async function fetchHtml(url) {
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
    return { ok: r.ok, status: r.status, html, error: null };
  } catch (err) {
    return { ok: false, status: null, html: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Run the real extractors — same path the monitor uses for `auto` targets.
function validate(html, url) {
  let products = jsonldExtractor.extract(html, url);
  let method = 'jsonld';
  if (products.length === 0) {
    products = heuristicExtractor.extract(html, url);
    method = 'heuristic';
  }
  return { productCount: products.length, method };
}

async function processStore(store, toGame) {
  const tried = [];
  const candidates = [];

  // strategy 1: token substitution from a known (different-game) URL
  if (store.fromGame && store.fromGame !== toGame) {
    for (const ref of store.refUrls) {
      for (const url of substitutionCandidates(ref, store.fromGame, toGame)) {
        candidates.push({ url, strategy: 'substitution' });
      }
    }
  }

  // strategy 2: nav scan — harvest game links from a reference page + the homepage
  const scanSources = store.refUrls.length ? [store.refUrls[0]] : [];
  const homepage = `https://${store.host}/`;
  if (!scanSources.includes(homepage)) scanSources.push(homepage);

  for (const src of scanSources) {
    const res = await fetchHtml(src);
    tried.push({ role: 'nav-source', url: src, status: res.status, error: res.error });
    if (res.ok && res.html) {
      for (const url of navScanCandidates(res.html, src, toGame)) {
        candidates.push({ url, strategy: 'nav-scan' });
      }
    }
  }

  // dedupe, keep order (substitution first), cap the fetch budget
  const seen = new Set();
  const ordered = [];
  for (const c of candidates) {
    const key = c.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(c);
    if (ordered.length >= MAX_CANDIDATES) break;
  }

  if (ordered.length === 0) {
    return {
      ok: false,
      store: store.host,
      reason: 'no candidate URLs derived (substitution found nothing, nav scan found no game links)',
      tried,
    };
  }

  // validate candidates in order — first one that lists products wins
  for (const c of ordered) {
    const res = await fetchHtml(c.url);
    if (!res.ok || !res.html) {
      tried.push({ url: c.url, strategy: c.strategy, status: res.status, error: res.error });
      continue;
    }
    const { productCount, method } = validate(res.html, c.url);
    tried.push({ url: c.url, strategy: c.strategy, status: res.status, productCount, method });
    if (productCount >= MIN_PRODUCTS) {
      return {
        ok: true,
        store: store.host,
        url: c.url,
        strategy: c.strategy,
        method,
        productCount,
        dynamic: store.dynamic,
        tried,
      };
    }
  }

  // nothing validated — summarise why
  const statuses = tried.filter((t) => t.role !== 'nav-source' && t.status).map((t) => t.status);
  let reason;
  if (statuses.length && statuses.every((s) => s === 403)) {
    reason = 'all candidates blocked (HTTP 403)';
  } else if (statuses.length && statuses.every((s) => s === 404)) {
    reason = 'no matching category page (all candidates 404)';
  } else {
    reason = `candidates fetched but none listed >= ${MIN_PRODUCTS} products`;
  }
  if (store.dynamic) reason += ' — store is JS-rendered, needs manual check';
  return { ok: false, store: store.host, reason, tried };
}

// Build the de-duplicated store list, skipping hosts already covered for the game.
function buildStores(toGame, source) {
  const targets = readJson(TARGETS_PATH, []);
  const alreadyHosts = new Set(
    targets
      .filter((t) => detectGame(t.url) === toGame)
      .map((t) => hostOf(t.url))
      .filter(Boolean)
  );

  const byHost = new Map();

  if (source === 'targets' || source === 'both') {
    for (const t of targets) {
      const host = hostOf(t.url);
      if (!host) continue;
      const fromGame = detectGame(t.url);
      if (!fromGame || fromGame === toGame) continue; // only useful as a reference for another game
      const entry = byHost.get(host) || { host, refUrls: [], fromGame, dynamic: false };
      entry.refUrls.push(t.url);
      if (t.dynamic) entry.dynamic = true;
      byHost.set(host, entry);
    }
  }

  if (source === 'pool' || source === 'both') {
    for (const item of readJson(POOL_PATH, [])) {
      const url = typeof item === 'string' ? item : item && item.url;
      const host = hostOf(url);
      if (!host || byHost.has(host)) continue; // targets entry is richer — keep it
      byHost.set(host, { host, refUrls: [url], fromGame: detectGame(url), dynamic: false });
    }
  }

  const stores = [...byHost.values()].filter((s) => !alreadyHosts.has(s.host));
  return { stores, skipped: alreadyHosts.size };
}

async function main() {
  const game = (process.argv[2] || '').toLowerCase();
  if (!GAMES[game]) {
    console.error('Usage: node scripts/discover-category.js <game> [--source targets|pool|both] [--limit N]');
    console.error(`Known games: ${Object.keys(GAMES).join(', ')}`);
    process.exit(1);
  }
  const source = argValue('--source') || 'both';
  const limit = parseInt(argValue('--limit'), 10) || Infinity;

  const { stores: all, skipped } = buildStores(game, source);
  const stores = all.slice(0, limit);
  console.log(`[discover] game=${game} source=${source}  stores=${stores.length}  (skipped ${skipped} already covered for ${game})`);

  const limiter = createLimiter(CONCURRENCY);
  let done = 0;
  const results = await Promise.all(
    stores.map((s) =>
      limiter(async () => {
        const r = await processStore(s, game);
        done++;
        if (done % 20 === 0 || done === stores.length) console.log(`[discover] ${done}/${stores.length}`);
        return r;
      })
    )
  );

  const validated = results
    .filter((r) => r.ok)
    .map((r) => ({
      store: r.store,
      url: r.url,
      strategy: r.strategy,
      method: r.method,
      productCount: r.productCount,
      dynamic: r.dynamic || false,
    }));
  const removed = results
    .filter((r) => !r.ok)
    .map((r) => ({ store: r.store, reason: r.reason, tried: r.tried }));

  const okPath = path.join(DATA_DIR, `links_${game}.json`);
  const rmPath = path.join(DATA_DIR, `links_${game}_removed.json`);
  fs.writeFileSync(okPath, JSON.stringify(validated, null, 2));
  fs.writeFileSync(rmPath, JSON.stringify(removed, null, 2));

  const byStrategy = {};
  for (const v of validated) byStrategy[v.strategy] = (byStrategy[v.strategy] || 0) + 1;

  console.log('\n[discover] done');
  console.log(`  validated: ${validated.length}  -> ${okPath}`);
  console.log(`  removed:   ${removed.length}  -> ${rmPath}`);
  console.log(`  by strategy: ${JSON.stringify(byStrategy)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
