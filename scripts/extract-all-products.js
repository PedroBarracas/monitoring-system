/**
 * Extracts products from all targets and prints a summarized list per site.
 * Dynamic targets are rendered via Playwright (Chromium).
 * Usage: node scripts/extract-all-products.js
 */

const fs = require('fs');
const path = require('path');
const jsonldExtractor = require('../src/extractors/jsonld-extractor');
const heuristicExtractor = require('../src/extractors/heuristic-extractor');
const { checkDetailPageStock } = require('../src/utils/detail-stock-checker');

const TARGETS_PATH = path.join(__dirname, '..', 'data', 'product-targets.json');
const CONCURRENCY = 5;
const TIMEOUT = 15000;
const PW_TIMEOUT = 30000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let chromium = null;
try {
  chromium = require('playwright').chromium;
} catch {
  // Playwright not installed — dynamic targets will be skipped
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchDynamic(url) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: PW_TIMEOUT });
    } catch {
      // networkidle can hang on Wix/WebSocket sites — fall back to load + wait
      await page.goto(url, { waitUntil: 'load', timeout: PW_TIMEOUT });
      await page.waitForTimeout(5000);
    }
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function extractFromUrl(target) {
  if (target.dynamic && !chromium) return { url: target.url, method: 'skipped (dynamic)', products: [], error: null };
  try {
    const html = target.dynamic ? await fetchDynamic(target.url) : await fetchHtml(target.url);
    let products = jsonldExtractor.extract(html, target.url);
    const isDynamic = !!target.dynamic;
    if (products.length > 0) return { url: target.url, method: isDynamic ? 'dynamic+jsonld' : 'jsonld', products, error: null };
    products = heuristicExtractor.extract(html, target.url);
    const method = products.length > 0 ? (isDynamic ? 'dynamic+heuristic' : 'heuristic') : (isDynamic ? 'dynamic+none' : 'none');

    if (target.detailStock && products.length > 0) {
      const httpClient = { fetchHtml };
      const logger = { info: () => {}, warn: console.warn, error: console.error, debug: () => {} };
      products = await checkDetailPageStock(products, {
        baseUrl: target.url,
        httpClient,
        logger,
        concurrency: target.detailConcurrency || 3,
      });
      return { url: target.url, method: method + '+detail', products, error: null };
    }

    return { url: target.url, method, products, error: null };
  } catch (err) {
    return { url: target.url, method: 'error', products: [], error: err.message };
  }
}

async function runWithLimit(tasks, limit) {
  const results = []; let idx = 0;
  async function worker() { while (idx < tasks.length) { const i = idx++; results[i] = await tasks[i](); } }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

async function main() {
  const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
  const tasks = targets.map((t) => () => extractFromUrl(t));
  const results = await runWithLimit(tasks, CONCURRENCY);

  let totalProducts = 0;
  let totalInStock = 0;
  let totalOOS = 0;
  let sitesWithProducts = 0;

  for (const r of results) {
    const domain = new URL(r.url).hostname.replace(/^www\./, '');
    const METHOD_TAGS = {
      'jsonld': '[JSON-LD]', 'heuristic': '[Heuristic]',
      'heuristic+detail': '[Heuristic+Detail]', 'jsonld+detail': '[JSON-LD+Detail]',
      'dynamic+jsonld': '[Dynamic+JSON-LD]', 'dynamic+heuristic': '[Dynamic+Heuristic]',
      'dynamic+none': '[Dynamic+NO DATA]',
      'error': '[ERROR]', 'skipped (dynamic)': '[DYNAMIC-SKIP]', 'none': '[NO DATA]',
    };
    const tag = METHOD_TAGS[r.method] || `[${r.method}]`;

    console.log(`\n${domain}  ${tag}`);

    if (r.error) { console.log(`  Error: ${r.error}`); continue; }
    if (r.products.length === 0) { console.log('  No products found'); continue; }

    sitesWithProducts++;
    const inStock = r.products.filter(p => p.inStock === 1);
    const oos = r.products.filter(p => p.inStock === 0);
    totalProducts += r.products.length;
    totalInStock += inStock.length;
    totalOOS += oos.length;

    console.log(`  ${r.products.length} products (${inStock.length} in stock, ${oos.length} out of stock)`);

    for (const p of r.products) {
      const stock = p.inStock === 1 ? '\x1b[32mIN STOCK\x1b[0m' : '\x1b[31mOUT OF STOCK\x1b[0m';
      console.log(`    ${stock}  ${p.title}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`TOTAL: ${totalProducts} products across ${sitesWithProducts} sites`);
  console.log(`  In Stock:     ${totalInStock}`);
  console.log(`  Out of Stock: ${totalOOS}`);
  console.log('='.repeat(80) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
