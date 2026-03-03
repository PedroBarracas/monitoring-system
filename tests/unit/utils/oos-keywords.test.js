const OOS_KEYWORDS = require('../../../src/utils/oos-keywords');

describe('oos-keywords', () => {
  test('exports a non-empty array', () => {
    expect(Array.isArray(OOS_KEYWORDS)).toBe(true);
    expect(OOS_KEYWORDS.length).toBeGreaterThan(0);
  });

  test('contains expected multilingual keywords', () => {
    expect(OOS_KEYWORDS).toContain('out of stock');
    expect(OOS_KEYWORDS).toContain('sold out');
    expect(OOS_KEYWORDS).toContain('esgotado');
    expect(OOS_KEYWORDS).toContain('agotado');
    expect(OOS_KEYWORDS).toContain('producto no disponible');
    expect(OOS_KEYWORDS).toContain('épuisé');
    expect(OOS_KEYWORDS).toContain('ausverkauft');
    expect(OOS_KEYWORDS).toContain('esaurito');
    expect(OOS_KEYWORDS).toContain('niet beschikbaar');
  });

  test('all entries are lowercase strings', () => {
    for (const kw of OOS_KEYWORDS) {
      expect(typeof kw).toBe('string');
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  test('has no duplicates', () => {
    const unique = new Set(OOS_KEYWORDS);
    expect(unique.size).toBe(OOS_KEYWORDS.length);
  });
});
