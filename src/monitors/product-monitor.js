const cssExtractor = require('../extractors/css-extractor');
const jsonldExtractor = require('../extractors/jsonld-extractor');
const heuristicExtractor = require('../extractors/heuristic-extractor');
const { createLimiter } = require('../utils/concurrency');
const OOS_KEYWORDS = require('../utils/oos-keywords');
const { checkDetailPageStock } = require('../utils/detail-stock-checker');

function resolveUrl(url, base) {
  if (!url) return base;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function createProductMonitor({ productRepo, alertRepo, notifier, httpClient, config, logger }) {
  const limit = createLimiter(config.concurrency || 5);

  // Resolve Playwright once at creation time (optional dependency)
  let chromium = null;
  const hasDynamicTargets = config.targets.some((t) => t.dynamic);
  if (hasDynamicTargets) {
    try {
      chromium = require('playwright').chromium;
    } catch {
      logger.warn('Playwright not installed — dynamic targets will be skipped');
    }
  }

  function extractProducts(html, target) {
    const mode = target.extractor || 'auto';

    if (mode === 'css') {
      return cssExtractor.extract(html, target.selectors, target.url, OOS_KEYWORDS);
    }
    if (mode === 'jsonld') {
      return jsonldExtractor.extract(html, target.url);
    }
    if (mode === 'heuristic') {
      return heuristicExtractor.extract(html, target.url);
    }

    // auto: try JSON-LD first, fall back to heuristic HTML extraction
    const jsonldProducts = jsonldExtractor.extract(html, target.url);
    if (jsonldProducts.length > 0) return jsonldProducts;

    return heuristicExtractor.extract(html, target.url);
  }

  async function processTarget(target) {
    let sent = 0;
    const errs = [];

    try {
      let html;

      if (target.dynamic) {
        if (!chromium) {
          logger.warn(`Skipping dynamic target ${target.url} — Playwright unavailable`);
          return { sent, errs };
        }
        let browser;
        try {
          browser = await chromium.launch({
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-http2',
              '--disable-blink-features=AutomationControlled',
              '--disable-dev-shm-usage',
            ],
          });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            extraHTTPHeaders: {
              'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not-A.Brand";v="99"',
              'sec-ch-ua-mobile': '?0',
              'sec-ch-ua-platform': '"Windows"',
            },
          });
          const page = await context.newPage();
          try {
            await page.goto(target.url, { waitUntil: 'networkidle', timeout: 30000 });
          } catch {
            await page.goto(target.url, { waitUntil: 'load', timeout: 30000 });
            await page.waitForTimeout(5000);
          }
          html = await page.content();
        } catch (err) {
          logger.error(`Playwright failed for ${target.url}`, { error: err.message });
          errs.push(`${target.url}: ${err.message}`);
          return { sent, errs };
        } finally {
          if (browser) await browser.close();
        }
      } else {
        html = await httpClient.fetchHtml(target.url);
      }

      let products = await extractProducts(html, target);
      logger.info(`Extracted ${products.length} products from ${target.url}`);

      if (target.detailStock && products.length > 0) {
        products = await checkDetailPageStock(products, {
          baseUrl: target.url,
          httpClient,
          logger,
          concurrency: target.detailConcurrency || 3,
        });
      }

      if (products.length === 0 && productRepo.countBySource(target.url) > 0) {
        logger.warn(`Zero products extracted from ${target.url} but ${productRepo.countBySource(target.url)} exist in DB — skipping update`);
        return { sent, errs };
      }

      for (const product of products) {
        const existing = productRepo.getProduct(product.sourceUrl, product.productId);
        const priceDisplay = product.price ? `${product.price}${product.currency ? ' ' + product.currency : ''}` : null;

        if (!existing) {
          productRepo.insertProduct({
            sourceUrl: product.sourceUrl,
            productId: product.productId,
            productUrl: product.productUrl,
            title: product.title,
            inStock: product.inStock,
            price: product.price,
            currency: product.currency,
          });

          alertRepo.logAlert('new_product', {
            productId: product.productId,
            title: product.title,
            url: product.productUrl,
            inStock: product.inStock === 1,
            price: product.price,
          });

          const absoluteProductUrl = resolveUrl(product.productUrl, product.sourceUrl);
          const bodyLines = [
            `Product: ${absoluteProductUrl}`,
            `Store: ${product.sourceUrl}`,
            `Status: ${product.inStock ? 'In Stock' : 'Out of Stock'}`,
          ];
          if (priceDisplay) bodyLines.push(`Price: ${priceDisplay}`);

          const ok = await notifier.sendAlert({
            eventType: 'NEW_PRODUCT',
            title: `🛒 New product added: ${product.title}`,
            body: bodyLines.join('\n'),
          });
          if (!ok) logger.warn(`Failed to send new product alert for ${product.productId}`);
          sent++;
        } else if (existing.in_stock !== product.inStock) {
          productRepo.updateProduct({
            sourceUrl: product.sourceUrl,
            productId: product.productId,
            inStock: product.inStock,
            title: product.title,
            price: product.price,
            currency: product.currency,
          });

          const oldStatus = existing.in_stock ? 'In Stock' : 'Out of Stock';
          const newStatus = product.inStock ? 'In Stock' : 'Out of Stock';
          alertRepo.logAlert('stock_change', {
            productId: product.productId,
            title: product.title,
            oldStatus,
            newStatus,
          });

          const absoluteChangeUrl = resolveUrl(product.productUrl, product.sourceUrl);
          const bodyLines = [
            `Status: ${oldStatus} -> ${newStatus}`,
            `Product: ${absoluteChangeUrl}`,
            `Store: ${product.sourceUrl}`,
          ];
          if (priceDisplay) bodyLines.push(`Price: ${priceDisplay}`);

          const ok = await notifier.sendAlert({
            eventType: 'STOCK_CHANGE',
            title: product.title,
            body: bodyLines.join('\n'),
          });
          if (!ok) logger.warn(`Failed to send stock change alert for ${product.productId}`);
          sent++;
        } else {
          productRepo.updateProduct({
            sourceUrl: product.sourceUrl,
            productId: product.productId,
            inStock: product.inStock,
            title: product.title,
            price: product.price,
            currency: product.currency,
          });
        }
      }
    } catch (err) {
      logger.error(`Failed to process ${target.url}`, { error: err.message });
      errs.push(`${target.url}: ${err.message}`);
    }

    return { sent, errs };
  }

  return {
    name: 'product-monitor',

    async run() {
      const results = await Promise.all(
        config.targets.map((target) => limit(() => processTarget(target)))
      );

      let alertsSent = 0;
      const errors = [];
      for (const { sent, errs } of results) {
        alertsSent += sent;
        errors.push(...errs);
      }

      return { alertsSent, errors };
    },
  };
}

module.exports = { createProductMonitor };
