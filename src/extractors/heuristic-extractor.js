const cheerio = require('cheerio');
const OOS_KEYWORDS = require('../utils/oos-keywords');

const OOS_CLASSES = ['sold-out', 'soldout', 'outofstock', 'out-of-stock'];

// Ordered from most specific to most generic. First selector with matches wins.
const CONTAINER_SELECTORS = [
  // Shopify
  '.product-card',
  '.product-grid-item',
  '.collection-product-card',
  '.card-wrapper',
  '.card--product',
  '.grid-view-item',
  // WooCommerce
  'li.product.type-product',
  'div.product.type-product',
  'li.product',
  // PrestaShop
  '.js-product-miniature',
  '.product-miniature',
  '.product-container',
  // Ecwid
  '.grid-product',
  // Shopkit
  'div.product[data-id]',
  'article.product-list',
  // Wix
  '[data-hook="product-item-root"]',
  // Site-specific
  '.product-slide-entry',
  'li.c-product-grid__wrapper',
  '.fileproduct',
  '.wsite-com-category-product-featured-wrap',
  'div[id^="product-card-"]',
  // Generic
  '[class*="product-card"]',
  '[class*="product-item"]',
  '[class*="ProductCard"]',
  '[data-product-id]',
  '[data-product]',
  'figure.product',
];

const TITLE_SELECTORS = [
  // Shopify
  '.card__heading a', '.product-card__title a', '.product-card__title',
  // WooCommerce
  '.woocommerce-loop-product__title',
  // PrestaShop
  '.product-title a', '.product-name a', '.product-name',
  // Ecwid
  '.grid-product__title-inner',
  // Wix
  '[data-hook="product-item-name"]',
  // Site-specific
  '.wsite-com-category-product-name',
  '.filetitle a',
  // Generic
  'h3 a', 'h2 a', 'h5 a', 'h3', 'h2', 'h5',
  '[class*="title"] a', '[class*="title"]', '[class*="name"] a',
];

const PRICE_SELECTORS = [
  // Shopify
  '.price-item--regular', '.price-item--sale', '.price__regular', '.price__sale',
  '.product-card__price', '.card__price',
  // WooCommerce
  '.woocommerce-Price-amount', '.price ins .amount', '.price .amount',
  // PrestaShop
  '.product-price-and-shipping .price', '.product-price',
  // Ecwid
  '.grid-product__price-value',
  // Wix
  '[data-hook="product-item-price-to-pay"]',
  // Generic
  '[class*="price"]', '[class*="Price"]',
];

const LINK_SELECTORS = [
  'a[href*="/products/"]',   // Shopify
  'a[href*="/product/"]',    // WooCommerce EN
  'a[href*="/producto/"]',   // WooCommerce ES
  'a[href*="/produit/"]',    // FR
  'a[href*="/prodotto/"]',   // IT
  'a[href*="/produkt/"]',    // DE
  'a[href*="/produto/"]',    // PT
  'a',                       // Fallback
];

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractProductId(url) {
  if (!url) return null;
  const patterns = [
    /\/products\/([^/?#]+)/,     // Shopify
    /\/product[oe]?s?\/([^/?#]+)/i, // WooCommerce (EN/ES/PT/IT)
    /\/produit[s]?\/([^/?#]+)/i, // FR
    /\/produkt[e]?\/([^/?#]+)/i, // DE
    /\/(\d+-[^/?#]+)\.html/,     // PrestaShop
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return slugify(match[1]);
  }
  return null;
}

function isOutOfStock(el, $) {
  const classes = ($(el).attr('class') || '').toLowerCase();
  for (const cls of OOS_CLASSES) {
    if (classes.includes(cls)) return true;
  }
  const text = $(el).text().toLowerCase();
  for (const keyword of OOS_KEYWORDS) {
    if (text.includes(keyword)) return true;
  }
  return false;
}

function findFirst($el, selectors, $) {
  for (const sel of selectors) {
    const found = $el.find(sel).first();
    if (found.length > 0) return found;
  }
  return null;
}

function parsePrice(text) {
  if (!text) return null;
  // Match price patterns like "€29.99", "$100", "29,99 €", "100.00", etc.
  const match = text.match(/[\d]+[.,]\d{2}/);
  return match ? match[0].replace(',', '.') : null;
}

function extract(html, sourceUrl) {
  const $ = cheerio.load(html);

  // Find the first container selector that matches
  let containers = null;
  for (const sel of CONTAINER_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) {
      containers = found;
      break;
    }
  }

  if (!containers || containers.length === 0) return [];

  const products = [];
  const seen = new Set();

  containers.each((_i, el) => {
    const $el = $(el);

    const titleEl = findFirst($el, TITLE_SELECTORS, $);
    const title = titleEl ? titleEl.text().trim() : '';
    if (!title) return;

    const linkEl = findFirst($el, LINK_SELECTORS, $);
    const productUrl = linkEl ? (linkEl.attr('href') || '') : '';
    if (!productUrl) return;

    const productId = extractProductId(productUrl) || slugify(title);

    if (seen.has(productId)) return;
    seen.add(productId);

    const inStock = isOutOfStock(el, $) ? 0 : 1;

    const priceEl = findFirst($el, PRICE_SELECTORS, $);
    const price = priceEl ? parsePrice(priceEl.text()) : null;

    products.push({ productId, productUrl, title, inStock, price, currency: null, sourceUrl });
  });

  return products;
}

module.exports = { extract };
