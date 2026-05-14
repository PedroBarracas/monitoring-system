const cheerio = require('cheerio');
const OOS_KEYWORDS = require('../utils/oos-keywords');
const { parsePrice, detectCurrency } = require('../utils/price');

const OOS_CLASSES = ['sold-out', 'soldout', 'outofstock', 'out-of-stock', 'agotado'];

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
  // JTL-Shop
  '.product-wrapper',
  // Wix
  '[data-hook="product-item-root"]',
  // European platforms
  '.product-box',
  '.item-widget',
  // Jimdo / Shoptet
  '.js-product-container',
  '.product-gallery__item',
  // Material UI (React storefronts)
  'article.MuiCard-root',
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
  'div[data-product-id]',
  'li[data-product-id]',
  'article[data-product-id]',
  '[data-product]',
  'figure.product',
];

const TITLE_SELECTORS = [
  // Shopify
  '.card__heading a', '.product-card__title a', '.product-card__title',
  // Shopify (visually-hidden titles inside link)
  '.visually-hidden',
  'a .sr-only',
  // WooCommerce
  '.woocommerce-loop-product__title',
  // PrestaShop
  '.product-title a', '.product-name a', '.product-name',
  // Ecwid
  '.grid-product__title-inner',
  // Wix
  '[data-hook="product-item-name"]',
  // JTL-Shop
  '.productbox-title a', '.productbox-title',
  // Schema.org itemprop
  '[itemprop="name"]',
  // Jimdo / Shoptet
  '.product-gallery__title', '.product-gallery__content a',
  // Site-specific
  '.wsite-com-category-product-name',
  '.filetitle a',
  // Generic
  'h3 a', 'h2 a', 'h4 a', 'h5 a', 'h3', 'h2', 'h4', 'h5',
  '[class*="title"] a', '[class*="title"]', '[class*="name"] a',
];

const PRICE_SELECTORS = [
  // Shopify — sale price before regular so a discounted item reports the sale price
  '.price-item--sale', '.price__sale', '.price-item--regular', '.price__regular',
  '.product-card__price', '.card__price',
  // WooCommerce — <ins> wraps the sale price, so try it before the generic amount
  '.price ins .amount', '.woocommerce-Price-amount', '.price .amount',
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
  // Check class names on the container and all descendant elements
  const allClasses = [];
  allClasses.push(($(el).attr('class') || '').toLowerCase());
  $(el).find('[class]').each((_i, child) => {
    allClasses.push(($(child).attr('class') || '').toLowerCase());
  });
  const classStr = allClasses.join(' ');
  for (const cls of OOS_CLASSES) {
    if (classStr.includes(cls)) return true;
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

    const linkEl = findFirst($el, LINK_SELECTORS, $);
    const productUrl = linkEl ? (linkEl.attr('href') || '') : '';
    if (!productUrl) return;

    const titleEl = findFirst($el, TITLE_SELECTORS, $);
    let title = titleEl ? titleEl.text().trim() : '';
    // Fallback: try link's title/aria-label attributes
    if (!title && linkEl) {
      title = (linkEl.attr('title') || linkEl.attr('aria-label') || '').trim();
    }
    // Fallback: try image alt text
    if (!title) {
      const img = $el.find('img[alt]').first();
      if (img.length) title = (img.attr('alt') || '').trim();
    }
    if (!title) return;

    const productId = extractProductId(productUrl) || slugify(title);

    if (seen.has(productId)) return;
    seen.add(productId);

    const inStock = isOutOfStock(el, $) ? 0 : 1;

    const priceEl = findFirst($el, PRICE_SELECTORS, $);
    let price = null;
    let currency = null;
    if (priceEl) {
      // Drop struck-through "was" prices so we read the current/sale price,
      // not the crossed-out original.
      const priceClone = priceEl.clone();
      priceClone
        .find('s, del, .price-item--regular, .price__regular, [class*="compare"], [class*="was-price"], [class*="old-price"]')
        .remove();
      const priceText = priceClone.text().trim() || priceEl.text().trim();
      price = parsePrice(priceText);
      currency = detectCurrency(priceText, sourceUrl);
    }

    products.push({ productId, productUrl, title, inStock, price, currency, sourceUrl });
  });

  return products;
}

module.exports = { extract };
