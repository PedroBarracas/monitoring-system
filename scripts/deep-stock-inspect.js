/**
 * Deep inspection: for each product on the listing page, fetch the detail page
 * and show what stock-related text appears on BOTH pages side by side.
 * Usage: node scripts/deep-stock-inspect.js <url> [max_products]
 */
const cheerio = require('cheerio');
const { resolveProductUrl } = require('../src/utils/detail-stock-checker');
const OOS_KEYWORDS = require('../src/utils/oos-keywords');

const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONTAINER_SELECTORS = [
  '.product-card', '.product-grid-item', '.collection-product-card',
  'li.product.type-product', 'li.product',
  '.js-product-miniature', '.product-miniature',
  '[class*="product-card"]', '[class*="product-item"]', '[class*="ProductCard"]',
  '[data-product-id]', '[data-product]',
];

const TITLE_SELECTORS = [
  '.card__heading a', '.product-card__title a', '.product-card__title',
  '.woocommerce-loop-product__title',
  '.product-title a', '.product-name a',
  'h3 a', 'h2 a', 'h3', 'h2',
  '[class*="title"] a', '[class*="name"] a',
];

const LINK_SELECTORS = [
  'a[href*="/products/"]', 'a[href*="/product/"]', 'a[href*="/producto/"]',
  'a[href*="/produit/"]', 'a[href*="/prodotto/"]', 'a[href*="/produkt/"]',
  'a[href*="/produto/"]', 'a',
];

const STOCK_HINT_RE = /stock|disponib|esgotado|sold|unavail|épuisé|agotado|ausverkauft|fuera|rupture|disponível|añadir|add.to.cart|comprar|buy|notify|avís|avail/i;

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

function findFirst($el, selectors, $) {
  for (const sel of selectors) {
    const found = $el.find(sel).first();
    if (found.length > 0) return found;
  }
  return null;
}

function extractStockHints(html) {
  const lines = html.split(/\n/).map(l => l.trim()).filter(Boolean);
  const hints = [];
  for (const line of lines) {
    // Strip HTML tags for text analysis
    const text = line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0 && text.length < 200 && STOCK_HINT_RE.test(text)) {
      hints.push(text);
    }
  }
  // Deduplicate and limit
  return [...new Set(hints)].slice(0, 10);
}

function matchesOosKeyword(text) {
  const lower = text.toLowerCase();
  for (const kw of OOS_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

async function main() {
  const url = process.argv[2];
  const maxProducts = parseInt(process.argv[3] || '5', 10);
  if (!url) { console.error('Usage: node deep-stock-inspect.js <url> [max]'); process.exit(1); }

  const domain = new URL(url).hostname.replace(/^www\./, '');
  console.log(`=== ${domain} (checking up to ${maxProducts} products) ===\n`);

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  let containers = null;
  for (const sel of CONTAINER_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) { containers = found; break; }
  }
  if (!containers) { console.log('No product containers found'); return; }

  const products = [];
  containers.each((i, el) => {
    if (products.length >= maxProducts) return;
    const $el = $(el);
    const titleEl = findFirst($el, TITLE_SELECTORS, $);
    const title = titleEl ? titleEl.text().trim() : '';
    if (!title) return;
    const linkEl = findFirst($el, LINK_SELECTORS, $);
    const productUrl = linkEl ? (linkEl.attr('href') || '') : '';
    const containerText = $el.text();
    products.push({ title, productUrl, containerText });
  });

  for (const p of products) {
    console.log(`"${p.title.substring(0, 70)}"`);

    // Listing page analysis
    const listingMatch = matchesOosKeyword(p.containerText);
    if (listingMatch) {
      console.log(`  LISTING: OOS keyword found -> "${listingMatch}"`);
    } else {
      console.log(`  LISTING: No OOS keyword match (shows as in-stock)`);
    }

    // Detail page analysis
    const resolved = resolveProductUrl(p.productUrl, url);
    if (!resolved) {
      console.log(`  DETAIL:  No URL to check`);
      console.log('');
      continue;
    }

    try {
      const detailHtml = await fetchHtml(resolved);
      const detailMatch = matchesOosKeyword(detailHtml);
      const hints = extractStockHints(detailHtml);
      const stockHints = hints.filter(h => STOCK_HINT_RE.test(h)).slice(0, 5);

      if (detailMatch) {
        console.log(`  DETAIL:  OOS keyword found -> "${detailMatch}"`);
      } else {
        console.log(`  DETAIL:  No OOS keyword match (appears in-stock)`);
      }
      if (stockHints.length > 0) {
        console.log(`  DETAIL stock-related text:`);
        for (const h of stockHints) console.log(`    "${h.substring(0, 120)}"`);
      }
    } catch (err) {
      console.log(`  DETAIL:  Fetch error: ${err.message}`);
    }
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
