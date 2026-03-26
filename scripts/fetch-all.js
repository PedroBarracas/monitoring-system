const fs = require('fs');
const path = require('path');
const jsonldExtractor = require('../src/extractors/jsonld-extractor');
const heuristicExtractor = require('../src/extractors/heuristic-extractor');
const { createHttpClient } = require('../src/services/http-client');
const { checkDetailPageStock } = require('../src/utils/detail-stock-checker');

const TARGETS_PATH = path.join(__dirname, '..', 'data', 'product-targets.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'fetch-results.json');

const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

const httpClient = createHttpClient({ logger, timeout: 20000 });

function resolveUrl(url, base) {
  if (!url) return '';
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function extractProducts(html, target) {
  const jsonldProducts = jsonldExtractor.extract(html, target.url);
  if (jsonldProducts.length > 0) return jsonldProducts;
  return heuristicExtractor.extract(html, target.url);
}

async function fetchTarget(target) {
  const result = {
    url: target.url,
    numberOfProducts: 0,
    products: [],
    error: null,
  };

  try {
    if (target.dynamic) {
      let chromium;
      try {
        chromium = require('playwright').chromium;
      } catch {
        result.error = 'Playwright not installed — skipping dynamic target';
        return result;
      }

      let browser;
      try {
        browser = await chromium.launch({
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-http2'],
        });
        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        });
        const page = await context.newPage();
        try {
          await page.goto(target.url, { waitUntil: 'networkidle', timeout: 30000 });
        } catch {
          await page.goto(target.url, { waitUntil: 'load', timeout: 30000 });
          await page.waitForTimeout(5000);
        }
        const html = await page.content();
        let products = extractProducts(html, target);
        if (target.detailStock && products.length > 0) {
          products = await checkDetailPageStock(products, {
            baseUrl: target.url, httpClient, logger, concurrency: target.detailConcurrency || 3,
          });
        }
        result.numberOfProducts = products.length;
        result.products = products.map((p) => ({
          name: p.title,
          url: resolveUrl(p.productUrl, target.url),
          status: p.inStock ? 'In Stock' : 'Out of Stock',
        }));
      } finally {
        if (browser) await browser.close();
      }
    } else {
      const html = await httpClient.fetchHtml(target.url);
      let products = extractProducts(html, target);
      if (target.detailStock && products.length > 0) {
        products = await checkDetailPageStock(products, {
          baseUrl: target.url, httpClient, logger, concurrency: target.detailConcurrency || 3,
        });
      }
      result.numberOfProducts = products.length;
      result.products = products.map((p) => ({
        name: p.title,
        url: resolveUrl(p.productUrl, target.url),
        status: p.inStock ? 'In Stock' : 'Out of Stock',
      }));
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

async function main() {
  const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
  logger.info(`Fetching ${targets.length} targets...`);

  const CONCURRENCY = 5;
  const results = [];
  let completed = 0;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((t) => fetchTarget(t)));
    results.push(...batchResults);
    completed += batch.length;
    logger.info(`Progress: ${completed}/${targets.length}`);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf8');
  logger.info(`Results written to ${OUTPUT_PATH}`);

  const totalProducts = results.reduce((sum, r) => sum + r.numberOfProducts, 0);
  const errorCount = results.filter((r) => r.error).length;
  logger.info(`Total: ${totalProducts} products from ${results.length - errorCount} stores (${errorCount} errors)`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
