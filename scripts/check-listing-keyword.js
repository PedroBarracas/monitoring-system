/**
 * Check if a keyword appears anywhere in a listing page HTML.
 * Usage: node scripts/check-listing-keyword.js <listing-url> <keyword>
 */
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
  const keyword = process.argv[3];
  if (!url || !keyword) { console.error('Usage: ...'); process.exit(1); }

  const html = await fetchHtml(url);
  const lower = html.toLowerCase();
  const kw = keyword.toLowerCase();

  let pos = 0;
  let found = 0;
  while ((pos = lower.indexOf(kw, pos)) !== -1) {
    found++;
    const start = Math.max(0, pos - 100);
    const end = Math.min(html.length, pos + kw.length + 100);
    const snippet = html.substring(start, end).replace(/\n/g, ' ').replace(/\s+/g, ' ');
    console.log(`Match #${found} at pos ${pos}:`);
    console.log(`  ...${snippet}...`);
    console.log('');
    pos += kw.length;
  }
  console.log(`Total: ${found} matches for "${keyword}" on listing page`);
}

main().catch(e => { console.error(e); process.exit(1); });
