const { parsePrice, detectCurrency, convertToEur, formatPriceDisplay } = require('../../../src/utils/price');

describe('price util', () => {
  describe('parsePrice', () => {
    test('parses simple dot-decimal prices', () => {
      expect(parsePrice('€29.99')).toBe('29.99');
      expect(parsePrice('100.00')).toBe('100.00');
    });

    test('parses comma-decimal prices', () => {
      expect(parsePrice('29,99 €')).toBe('29.99');
      expect(parsePrice('4,50')).toBe('4.50');
    });

    test('handles thousands separators (US format)', () => {
      expect(parsePrice('€1,299.99')).toBe('1299.99');
      expect(parsePrice('1,299,999.99')).toBe('1299999.99');
    });

    test('handles thousands separators (EU format)', () => {
      expect(parsePrice('1.299,99 €')).toBe('1299.99');
      expect(parsePrice('1.299.999,99')).toBe('1299999.99');
    });

    test('treats a single separator with 3 trailing digits as thousands', () => {
      expect(parsePrice('1,500')).toBe('1500.00');
      expect(parsePrice('1.500')).toBe('1500.00');
    });

    test('parses whole-number prices with no decimals', () => {
      expect(parsePrice('€30')).toBe('30.00');
      expect(parsePrice('30€')).toBe('30.00');
      expect(parsePrice('JPY 1500')).toBe('1500.00');
    });

    test('takes the first number when several are present', () => {
      // multi-price disambiguation (struck-through originals) is the extractor's
      // job — parsePrice just normalises whatever number it's handed first
      expect(parsePrice('Was €49.99 Now €29.99')).toBe('49.99');
    });

    test('returns null when there is no usable price', () => {
      expect(parsePrice('')).toBeNull();
      expect(parsePrice(null)).toBeNull();
      expect(parsePrice('no price here')).toBeNull();
      expect(parsePrice('Free')).toBeNull();
      expect(parsePrice('€0.00')).toBeNull();
    });
  });

  describe('detectCurrency', () => {
    const url = 'https://shop.example.com/x';

    test('detects unambiguous symbols', () => {
      expect(detectCurrency('€29.99', url)).toBe('EUR');
      expect(detectCurrency('£19.99', url)).toBe('GBP');
      expect(detectCurrency('29,99 zł', url)).toBe('PLN');
      expect(detectCurrency('199 Kč', url)).toBe('CZK');
      expect(detectCurrency('2990 Ft', url)).toBe('HUF');
      expect(detectCurrency('149 lei', url)).toBe('RON');
    });

    test('detects explicit ISO codes', () => {
      expect(detectCurrency('EUR 29.99', url)).toBe('EUR');
      expect(detectCurrency('29.99 USD', url)).toBe('USD');
      expect(detectCurrency('CHF 59.00', url)).toBe('CHF');
    });

    test('resolves ambiguous "kr" via the store TLD', () => {
      expect(detectCurrency('299 kr', 'https://shop.se/x')).toBe('SEK');
      expect(detectCurrency('299 kr', 'https://shop.dk/x')).toBe('DKK');
      expect(detectCurrency('299 kr', 'https://shop.no/x')).toBe('NOK');
    });

    test('"kr" falls back to SEK when the TLD does not disambiguate', () => {
      // Most-common krona by far — better than no detection. Per-target
      // `currency` override on the target config can correct it if needed.
      expect(detectCurrency('299 kr', 'https://shop.com/x')).toBe('SEK');
    });

    test('resolves "$" via TLD, falling back to USD', () => {
      expect(detectCurrency('$29.99', 'https://shop.ca/x')).toBe('CAD');
      expect(detectCurrency('$29.99', 'https://shop.com/x')).toBe('USD');
    });

    test('returns null when no currency can be determined', () => {
      expect(detectCurrency('29.99', url)).toBeNull();
      expect(detectCurrency('', url)).toBeNull();
      expect(detectCurrency(null, url)).toBeNull();
    });
  });

  describe('convertToEur', () => {
    const rates = { EUR: 1, GBP: 1.17, USD: 0.92 };

    test('converts a foreign currency to EUR', () => {
      expect(convertToEur('29.99', 'GBP', rates)).toBe('35.09');
    });

    test('returns the amount unchanged for EUR', () => {
      expect(convertToEur('29.99', 'EUR', rates)).toBe('29.99');
    });

    test('returns null for a currency with no rate', () => {
      expect(convertToEur('29.99', 'JPY', rates)).toBeNull();
    });

    test('returns null when inputs are missing', () => {
      expect(convertToEur(null, 'GBP', rates)).toBeNull();
      expect(convertToEur('29.99', null, rates)).toBeNull();
      expect(convertToEur('29.99', 'GBP', null)).toBeNull();
    });
  });

  describe('formatPriceDisplay', () => {
    const rates = { EUR: 1, GBP: 1.17 };

    test('appends a EUR estimate for a foreign currency', () => {
      expect(formatPriceDisplay('29.99', 'GBP', rates)).toBe('29.99 GBP (~€35.09)');
    });

    test('shows EUR prices without an estimate', () => {
      expect(formatPriceDisplay('29.99', 'EUR', rates)).toBe('29.99 EUR');
    });

    test('shows the bare price when the currency is unknown', () => {
      expect(formatPriceDisplay('29.99', null, rates)).toBe('29.99');
    });

    test('omits the EUR estimate for a currency with no rate', () => {
      expect(formatPriceDisplay('29.99', 'JPY', rates)).toBe('29.99 JPY');
    });

    test('returns null when there is no price', () => {
      expect(formatPriceDisplay(null, 'GBP', rates)).toBeNull();
    });
  });
});
