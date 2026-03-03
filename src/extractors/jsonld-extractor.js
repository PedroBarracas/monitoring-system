const cheerio = require('cheerio');

const IN_STOCK_TYPES = new Set([
  'https://schema.org/InStock',
  'http://schema.org/InStock',
  'https://schema.org/LimitedAvailability',
  'http://schema.org/LimitedAvailability',
  'https://schema.org/OnlineOnly',
  'http://schema.org/OnlineOnly',
  'https://schema.org/PreOrder',
  'http://schema.org/PreOrder',
  'https://schema.org/PreSale',
  'http://schema.org/PreSale',
  'https://schema.org/InStoreOnly',
  'http://schema.org/InStoreOnly',
  'https://schema.org/BackOrder',
  'http://schema.org/BackOrder',
]);

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractIdFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length > 0 ? slugify(parts[parts.length - 1]) : null;
  } catch {
    return null;
  }
}

function resolveOffers(offers) {
  if (!offers) return { inStock: 1, price: null, currency: null };

  const offerList = Array.isArray(offers) ? offers : [offers];

  for (const offer of offerList) {
    if (offer.offers) {
      return resolveOffers(offer.offers);
    }
    const avail = offer.availability || '';
    const inStock = avail && !IN_STOCK_TYPES.has(avail) ? 0 : 1;
    const price = offer.price != null ? String(offer.price) : (offer.lowPrice != null ? String(offer.lowPrice) : null);
    const currency = offer.priceCurrency || null;
    return { inStock, price, currency };
  }

  return { inStock: 1, price: null, currency: null };
}

function resolveProductId(item, sourceUrl) {
  if (item.sku) return String(item.sku);
  if (item.productID) return String(item.productID);
  if (item.url) {
    const urlId = extractIdFromUrl(item.url);
    if (urlId) return urlId;
  }
  if (item.name) return slugify(item.name);
  const sourceId = extractIdFromUrl(sourceUrl);
  if (sourceId) return sourceId;
  return 'unknown';
}

function normalizeProduct(item, sourceUrl) {
  if (!item.name) return null;

  const { inStock, price, currency } = resolveOffers(item.offers);
  return {
    productId: resolveProductId(item, sourceUrl),
    productUrl: item.url || '',
    title: item.name,
    inStock,
    price,
    currency,
    sourceUrl,
  };
}

function extract(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];

  $('script[type="application/ld+json"]').each((_i, el) => {
    let data;
    try {
      data = JSON.parse($(el).html());
    } catch {
      return;
    }

    const items = collectProducts(data);
    for (const item of items) {
      const product = normalizeProduct(item, sourceUrl);
      if (product) products.push(product);
    }
  });

  return products;
}

function collectProducts(data) {
  if (!data) return [];

  // Direct Product
  if (data['@type'] === 'Product') return [data];

  // Array of items
  if (Array.isArray(data)) {
    const results = [];
    for (const item of data) {
      results.push(...collectProducts(item));
    }
    return results;
  }

  // @graph container
  if (data['@graph'] && Array.isArray(data['@graph'])) {
    return collectProducts(data['@graph']);
  }

  // ItemList with ListItem elements containing Product items
  if (data['@type'] === 'ItemList' && Array.isArray(data.itemListElement)) {
    const results = [];
    for (const listItem of data.itemListElement) {
      if (listItem.item) {
        results.push(...collectProducts(listItem.item));
      }
    }
    return results;
  }

  return [];
}

module.exports = { extract };
