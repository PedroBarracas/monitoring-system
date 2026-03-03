/**
 * For each NO DATA site, find the most likely product container selector
 * and show what's inside the first few containers.
 * Usage: node scripts/diagnose-containers.js <url>
 */
const cheerio = require('cheerio');

const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Our current selectors
const CONTAINER_SELECTORS = [
  '.product-card', '.product-grid-item', '.collection-product-card',
  'li.product.type-product', 'li.product',
  '.js-product-miniature', '.product-miniature',
  '[class*="product-card"]', '[class*="product-item"]', '[class*="ProductCard"]',
  '[data-product-id]', '[data-product]',
];

// Extended candidates for diagnosis
const EXTRA_SELECTORS = [
  '.product-block', '.product-container', '.product-layout',
  '.product-thumb', '.product-wrapper', '.product-box',
  '.product-list-item', '.product-tile',
  '.card-product', '.card-wrapper', '.card--product',
  '.grid-product', '.grid__item',
  'article.product', 'article[class*="product"]',
  '.woocommerce-LoopProduct-link',
  '.collection-product', '.product-index',
  // Very generic
  '.product', 'article',
];

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('Usage: node diagnose-containers.js <url>'); process.exit(1); }

  const domain = new URL(url).hostname.replace(/^www\./, '');
  console.log(`=== ${domain} ===\n`);

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Check which of our current selectors match
  console.log('Current selectors that match:');
  let anyMatch = false;
  for (const sel of CONTAINER_SELECTORS) {
    const count = $(sel).length;
    if (count > 0) {
      console.log(`  ${sel}: ${count} elements`);
      anyMatch = true;
    }
  }
  if (!anyMatch) console.log('  (none)');

  // Check extended selectors
  console.log('\nExtended selectors that match:');
  const extended = [];
  for (const sel of EXTRA_SELECTORS) {
    const count = $(sel).length;
    if (count > 1) {  // At least 2 to be meaningful
      extended.push({ sel, count });
    }
  }
  extended.sort((a, b) => b.count - a.count);
  if (extended.length === 0) console.log('  (none)');
  for (const { sel, count } of extended.slice(0, 8)) {
    console.log(`  ${sel}: ${count} elements`);
  }

  // For the best candidate, show first 3 containers
  const bestSel = extended[0]?.sel;
  if (bestSel) {
    console.log(`\nFirst 3 elements for "${bestSel}":`);
    $(bestSel).slice(0, 3).each((i, el) => {
      const $el = $(el);
      const classes = $el.attr('class') || '';
      const tag = el.tagName;
      const titles = $el.find('h1, h2, h3, h4, h5, a').map((_, a) => $(a).text().trim()).get().filter(Boolean).slice(0, 3);
      const links = $el.find('a[href]').map((_, a) => $(a).attr('href')).get().filter(Boolean).slice(0, 2);
      const prices = $el.text().match(/[\d,.]+\s*[€$£]/g) || [];

      console.log(`\n  [${i}] <${tag} class="${classes.substring(0, 80)}">`);
      console.log(`    Titles: ${titles.map(t => t.substring(0, 60)).join(' | ') || '(none)'}`);
      console.log(`    Links:  ${links.join(' , ') || '(none)'}`);
      console.log(`    Prices: ${prices.join(', ') || '(none)'}`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
