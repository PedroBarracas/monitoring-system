/**
 * Show what's inside matched containers — focus on title/heading elements.
 * Usage: node scripts/diagnose-titles.js <url>
 */
const cheerio = require('cheerio');

const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONTAINER_SELECTORS = [
  '.product-card', '.product-grid-item', '.collection-product-card', '.card--product',
  'li.product.type-product', 'li.product',
  '.js-product-miniature', '.product-miniature', '.product-container',
  '.grid-product',
  '[class*="product-card"]', '[class*="product-item"]', '[class*="ProductCard"]',
  '[data-product-id]', '[data-product]',
  'figure.product',
];

const TITLE_SELECTORS = [
  '.card__heading a', '.product-card__title a', '.product-card__title',
  '.woocommerce-loop-product__title',
  '.product-title a', '.product-name a',
  'h3 a', 'h2 a', 'h3', 'h2',
  '[class*="title"] a', '[class*="name"] a',
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
  if (!url) { console.error('Usage: node diagnose-titles.js <url>'); process.exit(1); }
  const domain = new URL(url).hostname.replace(/^www\./, '');
  console.log(`=== ${domain} ===\n`);

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Find which container selector matches
  let containers = null;
  let usedSel = '';
  for (const sel of CONTAINER_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) { containers = found; usedSel = sel; break; }
  }
  if (!containers) { console.log('No container matches'); return; }
  console.log(`Container: ${usedSel} (${containers.length})\n`);

  // Check first 3 containers
  containers.slice(0, 3).each((i, el) => {
    const $el = $(el);
    console.log(`[${i}] Container HTML children (tags + classes):`);

    // Show the heading/title-like elements
    const headings = $el.find('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="name"], [class*="heading"]');
    if (headings.length === 0) {
      console.log('  (no heading/title elements found)');
    }
    headings.each((_, h) => {
      const tag = h.tagName;
      const cls = $(h).attr('class') || '';
      const text = $(h).text().trim().substring(0, 80);
      console.log(`  <${tag} class="${cls}"> "${text}"`);
    });

    // Check which of our title selectors match
    console.log('  Title selector matches:');
    let anyTitle = false;
    for (const sel of TITLE_SELECTORS) {
      const found = $el.find(sel).first();
      if (found.length > 0) {
        const text = found.text().trim().substring(0, 80);
        console.log(`    ${sel} -> "${text}"`);
        anyTitle = true;
        break;
      }
    }
    if (!anyTitle) console.log('    (none match)');
    console.log('');
  });
}

main().catch(e => { console.error(e); process.exit(1); });
