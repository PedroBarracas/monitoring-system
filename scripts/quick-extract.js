/**
 * Quick extract: run the standard extractors on a URL and show results.
 * Usage: node scripts/quick-extract.js <url>
 */
const jsonldExtractor = require('../src/extractors/jsonld-extractor');
const heuristicExtractor = require('../src/extractors/heuristic-extractor');

const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
  if (!url) { console.error('Usage: node quick-extract.js <url>'); process.exit(1); }

  const domain = new URL(url).hostname.replace(/^www\./, '');
  const html = await fetchHtml(url);

  let products = jsonldExtractor.extract(html, url);
  let method = 'jsonld';
  if (products.length === 0) {
    products = heuristicExtractor.extract(html, url);
    method = 'heuristic';
  }

  const inStock = products.filter(p => p.inStock === 1).length;
  const oos = products.filter(p => p.inStock === 0).length;

  console.log(`${domain} [${method}] — ${products.length} products (${inStock} in stock, ${oos} OOS)\n`);
  for (const p of products) {
    const stock = p.inStock === 1 ? '\x1b[32mIN STOCK\x1b[0m' : '\x1b[31mOOS     \x1b[0m';
    console.log(`  ${stock}  ${p.title}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
