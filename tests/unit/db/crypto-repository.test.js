const { createTestDb } = require('../../helpers/mock-db');
const { createCryptoRepository } = require('../../../src/db/crypto-repository');

describe('crypto-repository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = createTestDb();
    repo = createCryptoRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('getPrice returns undefined when coin does not exist', () => {
    expect(repo.getPrice('bitcoin')).toBeUndefined();
  });

  test('upsertPrice inserts a new row', () => {
    repo.upsertPrice('bitcoin', 'btc', 50000);

    const row = repo.getPrice('bitcoin');
    expect(row).toBeDefined();
    expect(row.coin_id).toBe('bitcoin');
    expect(row.symbol).toBe('btc');
    expect(row.price_usd).toBe(50000);
    expect(row.checked_at).toBeDefined();
  });

  test('upsertPrice updates existing row on conflict', () => {
    repo.upsertPrice('bitcoin', 'btc', 50000);
    repo.upsertPrice('bitcoin', 'btc', 55000);

    const row = repo.getPrice('bitcoin');
    expect(row.price_usd).toBe(55000);

    // Should still be a single row
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM crypto_prices').get();
    expect(count.cnt).toBe(1);
  });

  test('handles multiple coins independently', () => {
    repo.upsertPrice('bitcoin', 'btc', 50000);
    repo.upsertPrice('ethereum', 'eth', 3000);

    expect(repo.getPrice('bitcoin').price_usd).toBe(50000);
    expect(repo.getPrice('ethereum').price_usd).toBe(3000);
  });
});
