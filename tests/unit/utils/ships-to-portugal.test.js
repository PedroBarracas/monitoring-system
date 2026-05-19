const { shipsToPortugal } = require('../../../src/utils/ships-to-portugal');

describe('shipsToPortugal', () => {
  test('any .pt domain auto-confirms', () => {
    expect(shipsToPortugal('https://example.pt/anything')).toBe(true);
    expect(shipsToPortugal('https://www.shop.pt/x')).toBe(true);
    expect(shipsToPortugal('https://sub.domain.pt/y')).toBe(true);
  });

  test('non-.pt hosts not in the data file return false', () => {
    // data/ships-to-portugal.json starts empty — non-.pt hosts must be added
    // there manually after verification, so by default they return false.
    expect(shipsToPortugal('https://unknown-store.example/x')).toBe(false);
    expect(shipsToPortugal('https://example.org/y')).toBe(false);
  });

  test('invalid input returns false', () => {
    expect(shipsToPortugal(null)).toBe(false);
    expect(shipsToPortugal(undefined)).toBe(false);
    expect(shipsToPortugal('')).toBe(false);
    expect(shipsToPortugal('not a url')).toBe(false);
  });
});
