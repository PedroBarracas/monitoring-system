/**
 * Diagnose if sites are JS-rendered or have parseable HTML.
 * Checks: body text length, product-like elements, scripts that suggest client-side rendering.
 * Usage: node scripts/diagnose-js-rendered.js
 */
const cheerio = require('cheerio');

const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const URLS = [
  'https://chobanovgamesltd.com/category/one-piece/booster-boxes',
  'https://versusgamecenter.pt/collections/one-piece-card-game?sort_by=created-descending',
  'https://littlerootgames.com/collections/one-piece-sealed?sort_by=created-descending',
  'https://www.mnkcollectibles.com/one-piece',
  'https://www.zuris-shop.de/one-piece-2',
  'https://www.generacionx.es/juegos-de-cartas',
  'https://dreamshop18.com/category/one-piece-cg',
  'https://duelosdehonra.weebly.com/store/c6/One_Piece.html',
  'https://www.playerspot.pt/pre-encomendas',
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

async function diagnose(url) {
  const domain = new URL(url).hostname.replace(/^www\./, '');
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${domain}`);
  console.log(`${'='.repeat(70)}`);

  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.log(`  FETCH ERROR: ${err.message}`);
    return;
  }

  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const htmlSize = (html.length / 1024).toFixed(0);

  // JS rendering signals
  const jsSignals = [];
  if (html.includes('__NEXT_DATA__')) jsSignals.push('Next.js');
  if (html.includes('__NUXT__') || html.includes('nuxt')) jsSignals.push('Nuxt.js');
  if (html.includes('react') || html.includes('React')) jsSignals.push('React');
  if (html.includes('vue') || html.includes('Vue')) jsSignals.push('Vue');
  if (html.includes('angular') || html.includes('ng-app')) jsSignals.push('Angular');
  if (html.includes('wix.com') || html.includes('wixsite')) jsSignals.push('Wix');
  if (html.includes('squarespace')) jsSignals.push('Squarespace');
  if (html.includes('weebly')) jsSignals.push('Weebly');
  if (html.includes('shopify') || html.includes('cdn.shopify')) jsSignals.push('Shopify');
  if (html.includes('prestashop') || html.includes('PrestaShop')) jsSignals.push('PrestaShop');
  if (html.includes('woocommerce') || html.includes('WooCommerce')) jsSignals.push('WooCommerce');
  if (html.includes('ecwid')) jsSignals.push('Ecwid');
  if (html.includes('bigcommerce')) jsSignals.push('BigCommerce');

  // Check if body is mostly empty (JS-rendered)
  const productMentions = (bodyText.match(/product/gi) || []).length;
  const priceMentions = (bodyText.match(/[\d,.]+\s*[€$£]/g) || []).length;

  // Check for common product container patterns (broad search)
  const allElements = [];
  $('*').each((_, el) => {
    const cls = $(el).attr('class') || '';
    if (cls && /product|item|card|grid/i.test(cls)) {
      const tag = el.tagName;
      const key = `${tag}.${cls.split(/\s+/).sort().join('.')}`.substring(0, 100);
      allElements.push(key);
    }
  });

  // Count unique class patterns
  const classCounts = {};
  allElements.forEach(k => { classCounts[k] = (classCounts[k] || 0) + 1; });
  const repeatedClasses = Object.entries(classCounts)
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  console.log(`  HTML: ${htmlSize}KB | Body text: ${bodyText.length} chars`);
  console.log(`  Platform signals: ${jsSignals.join(', ') || 'none detected'}`);
  console.log(`  Product mentions in text: ${productMentions} | Prices in text: ${priceMentions}`);

  if (bodyText.length < 1000) {
    console.log(`  >>> LIKELY JS-RENDERED (very little body text)`);
  } else if (priceMentions === 0 && productMentions < 5) {
    console.log(`  >>> LIKELY JS-RENDERED (no prices, few product mentions)`);
  } else {
    console.log(`  >>> HAS CONTENT — extraction should be possible`);
  }

  if (repeatedClasses.length > 0) {
    console.log(`  Repeated class patterns (potential containers):`);
    for (const [cls, count] of repeatedClasses) {
      console.log(`    ${count}x  ${cls}`);
    }
  }

  // Show a snippet of the first few product-like elements
  const productEls = $('[class*="product"], [class*="Product"], [class*="item"], [class*="card"]').slice(0, 2);
  if (productEls.length > 0) {
    console.log(`  Sample element HTML (first match, truncated):`);
    productEls.each((i, el) => {
      const outerHtml = $.html(el).replace(/\n/g, ' ').replace(/\s+/g, ' ').substring(0, 200);
      console.log(`    [${i}] ${outerHtml}...`);
    });
  }
}

async function main() {
  for (const url of URLS) {
    await diagnose(url);
  }
  console.log('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
