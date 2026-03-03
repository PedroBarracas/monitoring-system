/**
 * Dump the raw HTML of the first container match.
 * Usage: node scripts/dump-container.js <url> <selector>
 */
const cheerio = require('cheerio');
const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const url = process.argv[2];
  const sel = process.argv[3];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
  clearTimeout(t);
  const html = await r.text();
  const $ = cheerio.load(html);
  const el = $(sel).first();
  if (el.length === 0) { console.log('No match'); return; }
  const raw = $.html(el);
  // Truncate to 3000 chars for readability
  console.log(raw.substring(0, 3000));
}
main().catch(e => { console.error(e); process.exit(1); });
