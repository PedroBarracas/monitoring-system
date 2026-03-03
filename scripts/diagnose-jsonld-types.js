/**
 * Quick check: what JSON-LD @type values exist on each site?
 * Also checks for Shopify-specific product JSON embedded in pages.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const TARGETS_PATH = path.join(__dirname, '..', 'data', 'product-targets.json');
const CONCURRENCY = 5;
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

function getJsonLdTypes(html) {
  const $ = cheerio.load(html);
  const types = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const data = JSON.parse($(el).html());
      collectTypes(data, types);
    } catch {}
  });
  return [...new Set(types)];
}

function collectTypes(data, acc) {
  if (!data) return;
  if (Array.isArray(data)) { data.forEach(d => collectTypes(d, acc)); return; }
  if (data['@type']) acc.push(data['@type']);
  if (data['@graph']) collectTypes(data['@graph'], acc);
  // Check for itemListElement with Products
  if (data.itemListElement && Array.isArray(data.itemListElement)) {
    for (const item of data.itemListElement) {
      if (item['@type']) acc.push(`itemListElement:${item['@type']}`);
      if (item.item && item.item['@type']) acc.push(`itemListElement.item:${item.item['@type']}`);
    }
  }
}

function detectPlatform(html) {
  if (html.includes('Shopify.theme') || html.includes('cdn.shopify.com')) return 'Shopify';
  if (html.includes('prestashop') || html.includes('PrestaShop')) return 'PrestaShop';
  if (html.includes('woocommerce') || html.includes('WooCommerce')) return 'WooCommerce';
  if (html.includes('weebly.com')) return 'Weebly';
  if (html.includes('Squarespace')) return 'Squarespace';
  if (html.includes('BigCommerce')) return 'BigCommerce';
  if (html.includes('wp-content')) return 'WordPress';
  return 'Unknown';
}

async function runWithLimit(tasks, limit) {
  const results = []; let idx = 0;
  async function worker() { while (idx < tasks.length) { const i = idx++; results[i] = await tasks[i](); } }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

async function main() {
  const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
  console.log(`Checking JSON-LD types on ${targets.length} URLs...\n`);

  const tasks = targets.map((t, i) => async () => {
    try {
      const html = await fetchHtml(t.url);
      const types = getJsonLdTypes(html);
      const platform = detectPlatform(html);
      return { url: t.url, types, platform, error: null };
    } catch (e) {
      return { url: t.url, types: [], platform: 'Error', error: e.message };
    }
  });

  const results = await runWithLimit(tasks, CONCURRENCY);

  // Group by platform
  const byPlatform = {};
  for (const r of results) {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
    byPlatform[r.platform].push(r);
  }

  for (const [platform, sites] of Object.entries(byPlatform).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n=== ${platform} (${sites.length} sites) ===`);
    for (const s of sites) {
      const typesStr = s.types.length > 0 ? s.types.join(', ') : '(none)';
      const domain = new URL(s.url).hostname;
      console.log(`  ${domain.padEnd(35)} LD types: ${typesStr}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
