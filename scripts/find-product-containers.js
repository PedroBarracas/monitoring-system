/**
 * Find repeated elements that contain both a link and text (likely product containers).
 * Usage: node scripts/find-product-containers.js <url>
 */
const cheerio = require('cheerio');
const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const url = process.argv[2];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
  clearTimeout(t);
  const html = await r.text();
  const $ = cheerio.load(html);

  // Find all elements with classes, count them, and check if they have links+text
  const candidates = {};
  $('*[class]').each((_, el) => {
    const cls = $(el).attr('class').trim();
    if (!cls) return;
    const tag = el.tagName;
    const key = `${tag}.${cls.split(/\s+/)[0]}`;
    if (!candidates[key]) candidates[key] = { count: 0, hasLink: 0, hasText: 0 };
    candidates[key].count++;
    if ($(el).find('a[href]').length > 0) candidates[key].hasLink++;
    const text = $(el).text().trim();
    if (text.length > 10 && text.length < 500) candidates[key].hasText++;
  });

  // Filter to likely product containers (repeated, with links and text)
  const likely = Object.entries(candidates)
    .filter(([, v]) => v.count >= 3 && v.hasLink >= 3 && v.hasText >= 3)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15);

  console.log('Likely product containers:');
  for (const [key, v] of likely) {
    console.log(`  ${key}: ${v.count} elements (${v.hasLink} with links, ${v.hasText} with text)`);
    // Show first element's content
    const firstClass = key.split('.')[1];
    const firstEl = $(`.${firstClass}`).first();
    const title = firstEl.find('h1, h2, h3, h4, h5, h6, a').first().text().trim().substring(0, 80);
    const link = firstEl.find('a[href]').first().attr('href') || '';
    console.log(`    title: "${title}" | link: ${link}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
