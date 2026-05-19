// Tells whether a target URL is on a store we've confirmed ships to Portugal.
//
// Two rules, in order:
//   1. Any host on a `.pt` domain — auto-true.
//   2. Hosts explicitly listed in data/ships-to-portugal.json (curated from the
//      shipping audit; see docs/shipping-status.md).
//
// Used by the product monitor to flag the notification title with 🇵🇹.

const fs = require('fs');
const path = require('path');

let CONFIRMED;
try {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'ships-to-portugal.json'), 'utf8');
  const parsed = JSON.parse(raw);
  CONFIRMED = new Set(Array.isArray(parsed) ? parsed.map((h) => String(h).toLowerCase()) : []);
} catch {
  CONFIRMED = new Set();
}

function shipsToPortugal(url) {
  if (!url) return false;
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }
  if (host.endsWith('.pt')) return true;
  return CONFIRMED.has(host);
}

module.exports = { shipsToPortugal, CONFIRMED_HOSTS: CONFIRMED };
