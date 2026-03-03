/**
 * Get the first product URL from a listing page and find keyword context on its detail page.
 * Usage: node scripts/get-first-product-url.js <listing-url> <keyword>
 */
const cheerio = require('cheerio');
const { resolveProductUrl } = require('../src/utils/detail-stock-checker');

const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONTAINER_SELECTORS = [
  '.product-card', '.product-grid-item', '.collection-product-card',
  'li.product.type-product', 'li.product',
  '.js-product-miniature', '.product-miniature',
  '[class*="product-card"]', '[class*="product-item"]', '[class*="ProductCard"]',
  '[data-product-id]', '[data-product]',
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
  const listingUrl = process.argv[2];
  const keyword = process.argv[3];
  if (!listingUrl || !keyword) { console.error('Usage: node get-first-product-url.js <listing-url> <keyword>'); process.exit(1); }

  const html = await fetchHtml(listingUrl);
  const $ = cheerio.load(html);

  let containers = null;
  for (const sel of CONTAINER_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) { containers = found; break; }
  }
  if (!containers) { console.log('No containers'); return; }

  // Get first product link
  const firstLink = $(containers[0]).find('a').first().attr('href');
  const resolved = resolveProductUrl(firstLink, listingUrl);
  console.log('Detail URL: ' + resolved);
  console.log('');

  const detailHtml = await fetchHtml(resolved);
  const lower = detailHtml.toLowerCase();
  const kw = keyword.toLowerCase();

  let pos = 0;
  let found = 0;
  while ((pos = lower.indexOf(kw, pos)) !== -1) {
    found++;
    const start = Math.max(0, pos - 100);
    const end = Math.min(detailHtml.length, pos + kw.length + 100);
    const snippet = detailHtml.substring(start, end).replace(/\n/g, ' ').replace(/\s+/g, ' ');
    console.log(`Match #${found} at pos ${pos}:`);
    console.log(`  ...${snippet}...`);
    console.log('');
    pos += kw.length;
  }
  console.log(`Total: ${found} matches for "${keyword}"`);
}

main().catch(e => { console.error(e); process.exit(1); });
