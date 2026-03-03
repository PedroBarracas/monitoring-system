const OOS_KEYWORDS = require('./oos-keywords');
const { createLimiter } = require('./concurrency');
const jsonldExtractor = require('../extractors/jsonld-extractor');

function resolveProductUrl(productUrl, baseUrl) {
  if (!productUrl) return null;
  try {
    return new URL(productUrl, baseUrl).href;
  } catch {
    return null;
  }
}

function isDetailPageOutOfStock(html) {
  const lower = html.toLowerCase();
  for (const keyword of OOS_KEYWORDS) {
    if (lower.includes(keyword)) return true;
  }
  return false;
}

/**
 * Extract stock status from JSON-LD Product schema on a detail page.
 * Returns 0 (out of stock), 1 (in stock), or null (no JSON-LD product found).
 */
function getJsonLdDetail(html, url) {
  const products = jsonldExtractor.extract(html, url);
  if (products.length === 0) return null;
  return products[0];
}

function getJsonLdStock(html, url) {
  const detail = getJsonLdDetail(html, url);
  return detail ? detail.inStock : null;
}

async function checkDetailPageStock(products, { baseUrl, httpClient, logger, concurrency = 3 }) {
  const limit = createLimiter(concurrency);

  const tasks = products.map((product) =>
    limit(async () => {
      const url = resolveProductUrl(product.productUrl, baseUrl);
      if (!url) return product;

      try {
        const html = await httpClient.fetchHtml(url);

        // Prefer JSON-LD structured data (most reliable, bidirectional)
        const jsonLdDetail = getJsonLdDetail(html, url);
        if (jsonLdDetail) {
          if (jsonLdDetail.inStock !== product.inStock) {
            logger.info(`Detail page JSON-LD stock for "${product.title}": ${jsonLdDetail.inStock ? 'In Stock' : 'OOS'} (${url})`);
          }
          const updated = { ...product, inStock: jsonLdDetail.inStock };
          if (jsonLdDetail.price != null) updated.price = jsonLdDetail.price;
          if (jsonLdDetail.currency != null) updated.currency = jsonLdDetail.currency;
          return updated;
        }

        // Fall back to keyword search (can only override to OOS)
        if (isDetailPageOutOfStock(html)) {
          logger.info(`Detail page OOS keyword override for "${product.title}" (${url})`);
          return { ...product, inStock: 0 };
        }
        return product;
      } catch (err) {
        logger.warn(`Detail page fetch failed for "${product.title}" (${url}): ${err.message}`);
        return product;
      }
    })
  );

  return Promise.all(tasks);
}

module.exports = { resolveProductUrl, isDetailPageOutOfStock, getJsonLdStock, checkDetailPageStock };
