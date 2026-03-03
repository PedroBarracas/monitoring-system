/**
 * Inspect a few sample pages to understand product data patterns.
 * Checks: ItemList JSON-LD, Shopify product JSON, common product card patterns.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

// Check: pokuji.fr ItemList structure
async function inspectPokuji() {
  console.log('\n=== pokuji.fr — ItemList with Product items ===\n');
  const html = await fetchHtml('https://pokuji.fr/produits/cartes-a-collectionner-tcg/one-piece/');
  const $ = cheerio.load(html);

  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data['@type'] === 'ItemList' || (Array.isArray(data) && data.some(d => d['@type'] === 'ItemList'))) {
        const list = data['@type'] === 'ItemList' ? data : data.find(d => d['@type'] === 'ItemList');
        console.log('ItemList found with', list.itemListElement?.length, 'elements');
        // Show first 3
        for (const item of (list.itemListElement || []).slice(0, 3)) {
          console.log(JSON.stringify(item, null, 2));
        }
      }
    } catch {}
  });
}

// Check: sample Shopify stores for product data patterns
async function inspectShopify(url) {
  const host = new URL(url).hostname;
  console.log(`\n=== ${host} (Shopify) ===\n`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Check for product-card elements
  const cardSelectors = ['.product-card', '.product-item', '.grid-product', '.collection-product-card',
    '[class*="product-card"]', '[class*="product-item"]', '[class*="ProductItem"]',
    '.card--product', '.product-grid-item', '.grid__item'];
  for (const sel of cardSelectors) {
    const count = $(sel).length;
    if (count > 0) {
      console.log(`  Found ${count} elements matching "${sel}"`);
      // Show first element's structure
      const first = $(sel).first();
      const title = first.find('[class*="title"], [class*="Title"], h3, h2').first().text().trim();
      const price = first.find('[class*="price"], [class*="Price"]').first().text().trim();
      const link = first.find('a').first().attr('href');
      if (title) console.log(`    First title: "${title}"`);
      if (price) console.log(`    First price: "${price}"`);
      if (link) console.log(`    First link: ${link}`);
    }
  }

  // Check for Shopify's product JSON in meta tags or script data
  const productJsonMatch = html.match(/var\s+meta\s*=\s*(\{[^;]+\})/);
  if (productJsonMatch) {
    console.log('  Has Shopify meta JSON');
  }
}

// Check: a WooCommerce store with ItemList
async function inspectWooCommerce(url) {
  const host = new URL(url).hostname;
  console.log(`\n=== ${host} (WooCommerce) ===\n`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Check product elements
  const selectors = ['.product', '.products .product', 'li.product', '.wc-block-grid__product'];
  for (const sel of selectors) {
    const count = $(sel).length;
    if (count > 0) {
      console.log(`  Found ${count} elements matching "${sel}"`);
      const first = $(sel).first();
      const title = first.find('.woocommerce-loop-product__title, h2, h3').first().text().trim();
      const price = first.find('.price, .woocommerce-Price-amount').first().text().trim();
      const link = first.find('a').first().attr('href');
      const stockBadge = first.find('[class*="stock"], [class*="badge"]').first().text().trim();
      if (title) console.log(`    Title: "${title}"`);
      if (price) console.log(`    Price: "${price}"`);
      if (link) console.log(`    Link: ${link}`);
      if (stockBadge) console.log(`    Stock badge: "${stockBadge}"`);
    }
  }
}

async function main() {
  await inspectPokuji();
  // Sample a few Shopify stores
  await inspectShopify('https://versusgamecenter.pt/collections/one-piece-card-game?sort_by=created-descending');
  await inspectShopify('https://evlutcg.com/collections/one-piece-preorders?sort_by=created-descending&filter.p.tag=Preorder&filter.v.availability=1');
  await inspectShopify('https://cardtreasure.ch/collections/one-piece-preorders');
  // Sample WooCommerce
  await inspectWooCommerce('https://lotusvalley.pt/categoria-produto/trading-card-games/one-piece-card-game/booster-box/');
  await inspectWooCommerce('https://mbox.pt/product-category/one-piece/?orderby=date&stock_status=instock');
}

main().catch(e => { console.error(e); process.exit(1); });
