// Shared price-text parsing and currency detection for the extractors.

// Unambiguous currency symbols → ISO 4217 code.
const SYMBOL_RULES = [
  { test: (t) => t.includes('€'), code: 'EUR' },
  { test: (t) => t.includes('£'), code: 'GBP' },
  { test: (t) => t.includes('zł'), code: 'PLN' },
  { test: (t) => t.includes('Kč'), code: 'CZK' },
  { test: (t) => /\bFt\b/.test(t), code: 'HUF' },
  { test: (t) => /\blei\b/i.test(t), code: 'RON' },
  { test: (t) => t.includes('лв'), code: 'BGN' },
];

// Symbols shared by several currencies — resolved via the store's domain TLD,
// falling back to the most common currency for that symbol (or null if none).
const AMBIGUOUS_RULES = [
  // `kr` is shared by SEK / DKK / NOK / ISK. Scandinavian shops sometimes sit
  // on a generic .com TLD so we can't always disambiguate — default to SEK as
  // the most-common krona (largest economy by far), which is better than no
  // detection at all. Override per-target with `currency` when needed.
  { test: (t) => /\bkr\b/i.test(t), byTld: { se: 'SEK', dk: 'DKK', no: 'NOK', is: 'ISK' }, fallback: 'SEK' },
  { test: (t) => t.includes('$'), byTld: { us: 'USD', ca: 'CAD', au: 'AUD' }, fallback: 'USD' },
];

const ISO_RE = /\b(EUR|GBP|USD|CHF|PLN|CZK|HUF|RON|BGN|SEK|DKK|NOK|ISK|CAD|AUD)\b/;

function tldOf(url) {
  try {
    const host = new URL(url).hostname;
    return host.slice(host.lastIndexOf('.') + 1).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Parse a price out of arbitrary text into a normalised "N.NN" string.
 *
 * Handles both decimal conventions and thousands separators:
 *   "€29.99" → "29.99"      "29,99 €"   → "29.99"
 *   "€1,299.99" → "1299.99" "1.299,99 €" → "1299.99"
 *   "€30" → "30.00"         "1 500" is NOT joined (spaces are not parsed)
 * Returns null when no positive number is found.
 */
function parsePrice(text) {
  if (!text) return null;

  const match = String(text).match(/\d[\d.,]*\d|\d/);
  if (!match) return null;
  const raw = match[0];

  const hasDot = raw.includes('.');
  const hasComma = raw.includes(',');
  let normalized;

  if (hasDot && hasComma) {
    // both present — whichever comes last is the decimal separator
    const decimalSep = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ',';
    const thousandsSep = decimalSep === '.' ? ',' : '.';
    normalized = raw.split(thousandsSep).join('').replace(decimalSep, '.');
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const parts = raw.split(sep);
    // a single separator with 1–2 trailing digits is a decimal point;
    // anything else (3 trailing digits, or several separators) is thousands
    if (parts.length === 2 && parts[1].length <= 2) {
      normalized = parts[0] + '.' + parts[1];
    } else {
      normalized = parts.join('');
    }
  } else {
    normalized = raw;
  }

  const value = parseFloat(normalized);
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : null;
}

/**
 * Detect the ISO 4217 currency of a price string. An explicit ISO code in the
 * text wins; then unambiguous symbols; ambiguous symbols (kr, $) are resolved
 * with the store's domain TLD. Returns null when it can't be determined.
 */
function detectCurrency(text, sourceUrl) {
  if (!text) return null;

  const iso = String(text).toUpperCase().match(ISO_RE);
  if (iso) return iso[1];

  for (const rule of SYMBOL_RULES) {
    if (rule.test(text)) return rule.code;
  }

  const tld = tldOf(sourceUrl);
  for (const rule of AMBIGUOUS_RULES) {
    if (rule.test(text)) return rule.byTld[tld] || rule.fallback;
  }

  return null;
}

/**
 * Convert a price to EUR using a static { CURRENCY: rateToEur } table, where the
 * rate is how many EUR one unit of the currency is worth. Returns a "N.NN"
 * string, or null when the currency is unknown or inputs are missing.
 */
function convertToEur(price, currency, rates) {
  if (price == null || !currency || !rates) return null;
  const amount = parseFloat(price);
  if (!Number.isFinite(amount)) return null;
  if (currency === 'EUR') return amount.toFixed(2);
  const rate = rates[currency];
  if (!rate || rate <= 0) return null;
  return (amount * rate).toFixed(2);
}

/**
 * Build the price line shown in notifications, appending a rough EUR estimate
 * when the price is in another currency we have a rate for.
 *   ("29.99", "GBP", rates) → "29.99 GBP (~€35.09)"
 *   ("29.99", "EUR", rates) → "29.99 EUR"
 *   ("29.99", null,  rates) → "29.99"
 *   (null,    ...)          → null
 */
function formatPriceDisplay(price, currency, rates) {
  if (price == null) return null;
  if (!currency) return String(price);
  let display = `${price} ${currency}`;
  if (currency !== 'EUR') {
    const eur = convertToEur(price, currency, rates);
    if (eur) display += ` (~€${eur})`;
  }
  return display;
}

module.exports = { parsePrice, detectCurrency, convertToEur, formatPriceDisplay };
