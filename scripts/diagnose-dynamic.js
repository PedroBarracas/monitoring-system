/**
 * Diagnose dynamic (Playwright-rendered) sites that return 0 products.
 * For each URL: launches Chromium, renders the page, saves HTML, and
 * uses Cheerio to find product containers, price patterns, and repeated
 * class structures.
 *
 * Usage: node scripts/diagnose-dynamic.js
 */
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const URLS = [
  { url: 'https://www.geekleaguestore.com/category/one-piece?order_by=stock_desc', label: 'geekleaguestore' },
  { url: 'https://www.lostforgestore.pt/category/none-piece-todos-os-produtos?order_by=newest', label: 'lostforgestore' },
  { url: 'https://www.zuris-shop.de/one-piece-2', label: 'zuris-shop (Wix)' },
  { url: 'https://dreamshop18.com/category/one-piece-cg', label: 'dreamshop18 (React)' },
  { url: 'https://lotusvalley.pt/categoria-produto/trading-card-games/one-piece-card-game/booster-box/', label: 'lotusvalley (WooCommerce)' },
];

const TIMEOUT = 45000;
const WIX_EXTRA_WAIT = 15000; // Wix sites need extra rendering time
const TMP_DIR = path.join(__dirname, '..', 'tmp', 'dynamic-html');

// Common product-container selectors to probe
const PRODUCT_SELECTORS = [
  '[class*="product"]',
  '[class*="Product"]',
  '[class*="item"]',
  '[class*="Item"]',
  '[class*="card"]',
  '[class*="Card"]',
  '[class*="grid"]',
  '[class*="Grid"]',
  '[class*="listing"]',
  '[class*="Listing"]',
  '[class*="gallery"]',
  '[class*="Gallery"]',
  '[data-product]',
  '[data-product-id]',
  '[data-item-id]',
  '[data-hook]',
  'article',
  'li[class]',
];

// Price regex patterns
const PRICE_RE = /(?:\d[\d.,]*)\s*[€$£]|[€$£]\s*(?:\d[\d.,]*)/g;

async function analyseWithCheerio(html, label) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const htmlSize = (html.length / 1024).toFixed(0);

  // --- Platform signals ---
  const jsSignals = [];
  if (html.includes('__NEXT_DATA__')) jsSignals.push('Next.js');
  if (html.includes('__NUXT__') || html.includes('nuxt')) jsSignals.push('Nuxt.js');
  if (/react|React|_react/i.test(html)) jsSignals.push('React');
  if (/vue|Vue/i.test(html) && !html.includes('revenue')) jsSignals.push('Vue');
  if (html.includes('angular') || html.includes('ng-app')) jsSignals.push('Angular');
  if (html.includes('wix.com') || html.includes('wixsite') || html.includes('wix-warmup-data')) jsSignals.push('Wix');
  if (html.includes('squarespace')) jsSignals.push('Squarespace');
  if (html.includes('shopify') || html.includes('cdn.shopify')) jsSignals.push('Shopify');
  if (html.includes('prestashop') || html.includes('PrestaShop')) jsSignals.push('PrestaShop');
  if (html.includes('woocommerce') || html.includes('WooCommerce') || html.includes('wc-')) jsSignals.push('WooCommerce');
  if (html.includes('ecwid')) jsSignals.push('Ecwid');
  if (html.includes('bigcommerce')) jsSignals.push('BigCommerce');

  // --- Body text stats ---
  const productMentions = (bodyText.match(/product/gi) || []).length;
  const priceMatches = bodyText.match(PRICE_RE) || [];

  // --- Probe each selector ---
  console.log(`\n  Selector probe results:`);
  const selectorHits = [];
  for (const sel of PRODUCT_SELECTORS) {
    const count = $(sel).length;
    if (count > 0) {
      console.log(`    ${sel.padEnd(30)} => ${count} elements`);
      selectorHits.push({ sel, count });
    }
  }
  if (selectorHits.length === 0) {
    console.log(`    (no product-like selectors found)`);
  }

  // --- Repeated class patterns (broad) ---
  const classBucket = {};
  $('*').each((_, el) => {
    const cls = $(el).attr('class') || '';
    if (!cls) return;
    // Include anything with 2+ siblings of same class (product grids etc.)
    const tag = el.tagName || el.name;
    const key = `${tag}.${cls.split(/\s+/).sort().join('.')}`.substring(0, 120);
    classBucket[key] = (classBucket[key] || 0) + 1;
  });
  const repeated = Object.entries(classBucket)
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  console.log(`\n  Repeated class patterns (>=3 occurrences, top 15):`);
  if (repeated.length > 0) {
    for (const [cls, count] of repeated) {
      console.log(`    ${String(count).padStart(3)}x  ${cls}`);
    }
  } else {
    console.log(`    (none found)`);
  }

  // --- Show first 2 product-like elements' outer HTML ---
  const broadSel = '[class*="product"], [class*="Product"], [class*="item"], [class*="Item"], [class*="card"], [class*="Card"], [data-product], [data-hook*="product"]';
  const sampleEls = $(broadSel).slice(0, 4);
  console.log(`\n  Sample product-like elements (first ${Math.min(sampleEls.length, 4)}, truncated 300 chars):`);
  if (sampleEls.length > 0) {
    sampleEls.each((i, el) => {
      const outerHtml = $.html(el).replace(/\n/g, ' ').replace(/\s+/g, ' ').substring(0, 300);
      console.log(`    [${i}] ${outerHtml}`);
    });
  } else {
    console.log(`    (none found -- trying any <a> with images)`);
    const linkImgEls = $('a:has(img)').slice(0, 3);
    linkImgEls.each((i, el) => {
      const outerHtml = $.html(el).replace(/\n/g, ' ').replace(/\s+/g, ' ').substring(0, 300);
      console.log(`    [${i}] ${outerHtml}`);
    });
  }

  // --- Look for title-like elements inside product containers ---
  console.log(`\n  Title/name candidates inside product containers:`);
  const containerSel = selectorHits.length > 0 ? selectorHits[0].sel : null;
  if (containerSel) {
    const firstContainer = $(containerSel).first();
    const titleCandidates = firstContainer.find('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="Title"], [class*="name"], [class*="Name"], a[href]');
    titleCandidates.slice(0, 5).each((i, el) => {
      const tag = el.tagName || el.name;
      const cls = $(el).attr('class') || '';
      const txt = $(el).text().trim().substring(0, 80);
      const href = $(el).attr('href') || '';
      console.log(`    <${tag} class="${cls}"${href ? ` href="${href.substring(0, 60)}"` : ''}> text: "${txt}"`);
    });
  } else {
    console.log(`    (no container found to inspect)`);
  }

  // --- Price patterns ---
  console.log(`\n  Price patterns found: ${priceMatches.length}`);
  if (priceMatches.length > 0) {
    console.log(`    Samples: ${priceMatches.slice(0, 8).join(' | ')}`);
  }

  // --- Summary ---
  console.log(`\n  SUMMARY:`);
  console.log(`    HTML size: ${htmlSize}KB | Body text: ${bodyText.length} chars`);
  console.log(`    Platform: ${jsSignals.join(', ') || 'unknown'}`);
  console.log(`    Product mentions: ${productMentions} | Prices: ${priceMatches.length}`);
  if (bodyText.length < 500) {
    console.log(`    VERDICT: Very little body text even after rendering -- still JS-blocked or empty`);
  } else if (priceMatches.length === 0 && productMentions < 3) {
    console.log(`    VERDICT: Rendered but no product data detected`);
  } else {
    console.log(`    VERDICT: HAS CONTENT -- extraction should work`);
  }
}

async function main() {
  // Ensure tmp directory exists
  fs.mkdirSync(TMP_DIR, { recursive: true });

  console.log('Launching Playwright Chromium...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  for (const { url, label } of URLS) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  ${label}`);
    console.log(`  ${url}`);
    console.log(`${'='.repeat(80)}`);

    const page = await context.newPage();
    const isWix = label.toLowerCase().includes('wix');
    try {
      // Wix sites never fully reach networkidle due to persistent connections,
      // so use domcontentloaded + extra wait instead.
      const waitEvent = isWix ? 'domcontentloaded' : 'networkidle';
      console.log(`  Navigating (${waitEvent}, ${TIMEOUT / 1000}s timeout)...`);
      await page.goto(url, { waitUntil: waitEvent, timeout: TIMEOUT });

      // Give extra time for lazy-loaded / SPA content
      const extraWait = isWix ? WIX_EXTRA_WAIT : 3000;
      console.log(`  Waiting ${extraWait / 1000}s for dynamic content...`);
      await page.waitForTimeout(extraWait);

      // Scroll down to trigger lazy-load, then back up
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(2000);

      const html = await page.content();
      const htmlSize = (html.length / 1024).toFixed(0);
      console.log(`  Rendered HTML: ${htmlSize}KB`);

      // Save to temp file
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
      const tmpFile = path.join(TMP_DIR, `${safeLabel}.html`);
      fs.writeFileSync(tmpFile, html, 'utf-8');
      console.log(`  Saved to: ${tmpFile}`);

      // Analyse with Cheerio
      await analyseWithCheerio(html, label);

    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log(`\n${'='.repeat(80)}`);
  console.log('Done. HTML files saved in: ' + TMP_DIR);
}

main().catch(e => { console.error(e); process.exit(1); });
