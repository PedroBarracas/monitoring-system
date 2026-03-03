/**
 * Spot-check: inspect what stock-related text each product shows on the listing page.
 * Usage: node scripts/spot-check-stock-labels.js <url>
 */
const cheerio = require('cheerio');

const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONTAINER_SELECTORS = [
  '.product-card', '.product-grid-item', '.collection-product-card',
  'li.product.type-product', 'li.product',
  '.js-product-miniature', '.product-miniature',
  '[class*="product-card"]', '[class*="product-item"]', '[class*="ProductCard"]',
  '[data-product-id]', '[data-product]',
];

const STOCK_HINT_PATTERNS = [
  /stock/i, /disponib/i, /esgotado/i, /sold/i, /unavail/i, /épuisé/i,
  /agotado/i, /ausverkauft/i, /fuera/i, /rupture/i, /disponível/i,
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
  if (!url) { console.error('Usage: node spot-check-stock-labels.js <url>'); process.exit(1); }

  const domain = new URL(url).hostname.replace(/^www\./, '');
  console.log(`=== ${domain} ===\n`);

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  let containers = null;
  let usedSelector = '';
  for (const sel of CONTAINER_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) { containers = found; usedSelector = sel; break; }
  }

  if (!containers) { console.log('No product containers found'); return; }
  console.log(`Container: ${usedSelector} (${containers.length} elements)\n`);

  containers.each((i, el) => {
    const $el = $(el);
    const title = $el.find('h2, h3, h4, [class*="title"], [class*="name"]').first().text().trim().substring(0, 60);
    if (!title) return;

    // Collect all text snippets that look stock-related
    const fullText = $el.text();
    const lines = fullText.split(/\n/).map(l => l.trim()).filter(Boolean);
    const stockLines = lines.filter(line =>
      STOCK_HINT_PATTERNS.some(p => p.test(line))
    );

    // Also check for stock-related classes
    const allClasses = [];
    $el.find('*').each((_, child) => {
      const cls = $(child).attr('class') || '';
      if (/stock|avail|sold|oos/i.test(cls)) allClasses.push(cls);
    });

    console.log(`  "${title}"`);
    if (stockLines.length > 0) {
      for (const sl of stockLines) console.log(`    text: "${sl.substring(0, 100)}"`);
    }
    if (allClasses.length > 0) {
      for (const cls of [...new Set(allClasses)]) console.log(`    class: "${cls}"`);
    }
    if (stockLines.length === 0 && allClasses.length === 0) {
      console.log('    (no stock indicators found)');
    }
  });
}

main().catch(e => { console.error(e); process.exit(1); });
