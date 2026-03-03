/**
 * Diagnose sites that return no products.
 * Checks: HTTP status, HTML size, presence of product-like elements, JSON-LD.
 * Usage: node scripts/diagnose-no-data.js
 */
const cheerio = require('cheerio');

const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const URLS = [
  'https://versusgamecenter.pt/collections/one-piece-card-game?sort_by=created-descending',
  'https://www.mnkcollectibles.com/one-piece',
  'https://chobanovgamesltd.com/category/one-piece/booster-boxes',
  'https://venturacardgames.com/collections/one-piece-card-game?filter.v.price.gte=&filter.v.price.lte=&sort_by=created-descending',
  'https://kamehousecards.com/ONE-PIECE-CARD-GAME-c133251255',
  'https://www.triplacegames.com/search?q=one+piece+card+game&page=1',
  'https://duelosdehonra.weebly.com/store/c6/One_Piece.html',
  'https://www.lerepairedudragon.fr/2093-one-piece-card-game',
  'https://www.zuris-shop.de/one-piece-2',
  'https://www.supercollectors.es/categoria-producto/boxes-packs/one-piece/',
  'https://www.generacionx.es/juegos-de-cartas',
  'https://dreamshop18.com/category/one-piece-cg',
  'https://littlerootgames.com/collections/one-piece-sealed?sort_by=created-descending',
  'https://aquitaz.se/collections/forbestallning?filter.p.vendor=One+Piece&',
  'https://www.playerspot.pt/pre-encomendas',
];

async function fetchWithInfo(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    const text = await r.text();
    return { status: r.status, size: text.length, html: text, error: null };
  } catch (err) {
    return { status: null, size: 0, html: '', error: err.message };
  } finally { clearTimeout(t); }
}

async function diagnose(url) {
  const domain = new URL(url).hostname.replace(/^www\./, '');
  const res = await fetchWithInfo(url);

  if (res.error) {
    console.log(`${domain}: FETCH ERROR — ${res.error}`);
    return;
  }

  const $ = cheerio.load(res.html);

  // Check for JSON-LD
  const jsonldScripts = $('script[type="application/ld+json"]').length;

  // Check for common product patterns in the full HTML
  const htmlLower = res.html.toLowerCase();
  const signals = [];
  if (htmlLower.includes('product')) signals.push('has "product" text');
  if (htmlLower.includes('add to cart') || htmlLower.includes('añadir') || htmlLower.includes('adicionar')) signals.push('has add-to-cart text');
  if (htmlLower.includes('price') || htmlLower.includes('precio') || htmlLower.includes('preço')) signals.push('has price text');

  // Check for elements that look like product containers but don't match our selectors
  const candidateSelectors = [
    '.product', '[class*="product"]', '[class*="Product"]',
    '[class*="item"]', '[class*="card"]',
    '[data-product]', '[data-item]',
    'article', '.grid-item', '.collection-item',
  ];
  const matches = {};
  for (const sel of candidateSelectors) {
    const count = $(sel).length;
    if (count > 0) matches[sel] = count;
  }

  // Check if it's a Shopify site with no visible products (might need JS)
  const isShopify = htmlLower.includes('shopify') || htmlLower.includes('cdn.shopify');
  const hasNoScript = $('noscript').length > 0;
  const bodyTextLength = $('body').text().trim().length;

  console.log(`\n${domain}`);
  console.log(`  HTTP ${res.status} | ${(res.size / 1024).toFixed(0)}KB HTML | body text: ${bodyTextLength} chars`);
  console.log(`  JSON-LD scripts: ${jsonldScripts} | Shopify: ${isShopify}`);
  if (signals.length > 0) console.log(`  Signals: ${signals.join(', ')}`);
  if (Object.keys(matches).length > 0) {
    const top = Object.entries(matches).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  Matching selectors: ${top.map(([s, c]) => `${s}(${c})`).join(', ')}`);
  } else {
    console.log(`  No matching product-like selectors found`);
  }
  if (bodyTextLength < 500) console.log(`  ⚠ Very little body text — likely JS-rendered`);
}

async function main() {
  for (const url of URLS) {
    await diagnose(url);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
