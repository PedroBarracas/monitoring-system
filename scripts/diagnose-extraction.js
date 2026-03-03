/**
 * Diagnostic script — fetches each target URL and tests extraction pipeline.
 * Reports: JSON-LD products, heuristic products, and final extraction method used.
 * Dynamic targets are rendered via Playwright (Chromium).
 *
 * Usage: node scripts/diagnose-extraction.js
 */

const fs = require('fs');
const path = require('path');
const jsonldExtractor = require('../src/extractors/jsonld-extractor');
const heuristicExtractor = require('../src/extractors/heuristic-extractor');
const { checkDetailPageStock } = require('../src/utils/detail-stock-checker');

const TARGETS_PATH = path.join(__dirname, '..', 'data', 'product-targets.json');
const CONCURRENCY = 5;
const DETAIL_CONCURRENCY = 3;
const TIMEOUT = 15000;
const PW_TIMEOUT = 30000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let chromium = null;
try {
  chromium = require('playwright').chromium;
} catch {
  // Playwright not installed — dynamic targets will be skipped
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
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

function extractProducts(html, url) {
  const jsonldProducts = jsonldExtractor.extract(html, url);
  if (jsonldProducts.length > 0) return { method: 'jsonld', products: jsonldProducts };
  const heuristicProducts = heuristicExtractor.extract(html, url);
  if (heuristicProducts.length > 0) return { method: 'heuristic', products: heuristicProducts };
  return { method: 'none', products: [] };
}

async function diagnoseUrl(target) {
  const url = target.url;
  const result = {
    url,
    dynamic: !!target.dynamic,
    status: 'ok',
    htmlSize: 0,
    method: 'none',
    products: [],
    error: null,
  };

  if (target.dynamic && !chromium) {
    result.status = 'skipped';
    result.method = 'dynamic (Playwright not installed)';
    return result;
  }

  try {
    const html = target.dynamic ? await fetchDynamic(url) : await fetchHtml(url);
    result.htmlSize = html.length;

    const { method, products } = extractProducts(html, url);
    result.method = target.dynamic ? `dynamic+${method}` : method;

    if (target.detailStock && products.length > 0) {
      const httpClient = { fetchHtml };
      const logger = { info() {}, warn() {}, error() {}, debug() {} };
      result.products = await checkDetailPageStock(products, {
        baseUrl: url,
        httpClient,
        logger,
        concurrency: target.detailConcurrency || DETAIL_CONCURRENCY,
      });
      result.method += '+detailStock';
    } else {
      result.products = products;
    }
  } catch (err) {
    result.status = 'error';
    result.error = err.message;
  }

  return result;
}

async function runWithLimit(tasks, limit) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

async function main() {
  const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
  console.log(`\nDiagnosing ${targets.length} URLs (concurrency: ${CONCURRENCY})...\n`);

  const tasks = targets.map((t, i) => () => {
    const num = String(i + 1).padStart(2, ' ');
    const flag = t.dynamic ? ' [dynamic]' : '';
    process.stdout.write(`  [${num}/${targets.length}] ${t.url.substring(0, 65)}...${flag}\n`);
    return diagnoseUrl(t);
  });

  const results = await runWithLimit(tasks, CONCURRENCY);

  const jsonld = results.filter((r) => r.method === 'jsonld');
  const heuristic = results.filter((r) => r.method === 'heuristic');
  const dynamicOk = results.filter((r) => r.method.startsWith('dynamic+') && r.products.length > 0);
  const dynamicNone = results.filter((r) => r.method.startsWith('dynamic+') && r.products.length === 0 && r.status === 'ok');
  const none = results.filter((r) => r.method === 'none' && r.status === 'ok');
  const skipped = results.filter((r) => r.status === 'skipped');
  const errors = results.filter((r) => r.status === 'error');

  console.log('\n' + '='.repeat(100));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(100));
  console.log(`Total URLs:              ${results.length}`);
  console.log(`JSON-LD extraction:      ${jsonld.length}`);
  console.log(`Heuristic extraction:    ${heuristic.length}`);
  console.log(`Dynamic (Playwright):    ${dynamicOk.length}`);
  console.log(`No products found:       ${none.length + dynamicNone.length}`);
  if (skipped.length > 0) console.log(`Skipped (no PW):         ${skipped.length}`);
  console.log(`Fetch errors:            ${errors.length}`);
  const totalProducts = results.reduce((s, r) => s + r.products.length, 0);
  console.log(`Total products found:    ${totalProducts}`);
  console.log('='.repeat(100));

  // JSON-LD
  if (jsonld.length > 0) {
    console.log('\n--- JSON-LD EXTRACTION ---\n');
    for (const r of jsonld) {
      console.log(`  ${r.url}`);
      console.log(`    Products: ${r.products.length}`);
      for (const p of r.products.slice(0, 3)) {
        const stock = p.inStock ? 'IN STOCK' : 'OUT OF STOCK';
        console.log(`      - [${stock}] ${p.title} (${p.productId})`);
      }
      if (r.products.length > 3) console.log(`      ... and ${r.products.length - 3} more`);
      console.log();
    }
  }

  // Heuristic
  if (heuristic.length > 0) {
    console.log('\n--- HEURISTIC EXTRACTION ---\n');
    for (const r of heuristic) {
      console.log(`  ${r.url}`);
      console.log(`    Products: ${r.products.length} | HTML: ${(r.htmlSize / 1024).toFixed(0)}KB`);
      for (const p of r.products.slice(0, 3)) {
        const stock = p.inStock ? 'IN STOCK' : 'OUT OF STOCK';
        console.log(`      - [${stock}] ${p.title} (${p.productId})`);
      }
      if (r.products.length > 3) console.log(`      ... and ${r.products.length - 3} more`);
      console.log();
    }
  }

  // No products
  if (none.length > 0) {
    console.log('\n--- NO PRODUCTS FOUND ---\n');
    for (const r of none) {
      console.log(`  ${r.url}  (HTML: ${(r.htmlSize / 1024).toFixed(0)}KB)`);
    }
  }

  // Dynamic with products
  if (dynamicOk.length > 0) {
    console.log('\n--- DYNAMIC (Playwright) ---\n');
    for (const r of dynamicOk) {
      console.log(`  ${r.url}`);
      console.log(`    Products: ${r.products.length} | HTML: ${(r.htmlSize / 1024).toFixed(0)}KB | Method: ${r.method}`);
      for (const p of r.products.slice(0, 3)) {
        const stock = p.inStock ? 'IN STOCK' : 'OUT OF STOCK';
        console.log(`      - [${stock}] ${p.title} (${p.productId})`);
      }
      if (r.products.length > 3) console.log(`      ... and ${r.products.length - 3} more`);
      console.log();
    }
  }

  // Dynamic with no products
  if (dynamicNone.length > 0) {
    console.log('\n--- DYNAMIC (no products found) ---\n');
    for (const r of dynamicNone) {
      console.log(`  ${r.url}  (HTML: ${(r.htmlSize / 1024).toFixed(0)}KB)`);
    }
  }

  // Skipped (Playwright not installed)
  if (skipped.length > 0) {
    console.log('\n--- SKIPPED (Playwright not installed) ---\n');
    for (const r of skipped) {
      console.log(`  ${r.url}`);
    }
  }

  // Errors
  if (errors.length > 0) {
    console.log('\n--- FETCH ERRORS ---\n');
    for (const r of errors) {
      console.log(`  ${r.url}: ${r.error}`);
    }
  }

  // Write full results — preserve previous data for sites that returned 0 products
  const outPath = path.join(__dirname, '..', 'data', 'extraction-diagnostic.json');
  let previous = {};
  try {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    for (const entry of prev) {
      if (entry.productCount > 0) previous[entry.url] = entry;
    }
  } catch { /* no previous file */ }

  const serializable = results.map((r) => {
    const current = {
      url: r.url,
      status: r.status,
      method: r.method,
      htmlSizeKB: Math.round(r.htmlSize / 1024),
      productCount: r.products.length,
      products: r.products.map((p) => ({
        id: p.productId,
        title: p.title,
        inStock: p.inStock === 1,
        url: p.productUrl,
      })),
      error: r.error,
    };
    if (current.productCount === 0 && previous[r.url]) {
      console.log(`  [preserved] ${r.url} — 0 products now, keeping ${previous[r.url].productCount} from previous run`);
      return { ...previous[r.url], stale: true };
    }
    return current;
  });
  fs.writeFileSync(outPath, JSON.stringify(serializable, null, 2));
  console.log(`\nFull results: ${outPath}\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
