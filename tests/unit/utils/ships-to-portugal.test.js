const { shipsToPortugal } = require('../../../src/utils/ships-to-portugal');

describe('shipsToPortugal', () => {
  test('any .pt domain auto-confirms', () => {
    expect(shipsToPortugal('https://example.pt/anything')).toBe(true);
    expect(shipsToPortugal('https://www.shop.pt/x')).toBe(true);
    expect(shipsToPortugal('https://sub.domain.pt/y')).toBe(true);
  });

  test('non-.pt hosts in data/ships-to-portugal.json return true', () => {
    expect(shipsToPortugal('https://adcardcollectibles.com/x')).toBe(true);
    expect(shipsToPortugal('https://www.zatu.com/y')).toBe(true);
  });

  test('hosts NOT in the list return false', () => {
    expect(shipsToPortugal('https://unknown-store.example/x')).toBe(false);
    expect(shipsToPortugal('https://example.org/y')).toBe(false);
  });

  test('invalid input returns false', () => {
    expect(shipsToPortugal(null)).toBe(false);
    expect(shipsToPortugal(undefined)).toBe(false);
    expect(shipsToPortugal('')).toBe(false);
    expect(shipsToPortugal('not a url')).toBe(false);
  });

  test('host matching is case-insensitive', () => {
    expect(shipsToPortugal('https://ADCARDCOLLECTIBLES.COM/x')).toBe(true);
  });
});
