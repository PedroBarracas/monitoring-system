const { createTestDb } = require('../../helpers/mock-db');

describe('database', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('creates crypto_prices table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crypto_prices'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test('creates products table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test('creates news_articles table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='news_articles'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test('creates alert_log table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alert_log'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test('migrations are idempotent', () => {
    const { runMigrations } = require('../../../src/db/migrations');
    expect(() => runMigrations(db)).not.toThrow();
  });

  test('WAL mode is set (memory for in-memory DB)', () => {
    // In-memory databases report "memory" instead of "wal"
    const result = db.pragma('journal_mode');
    expect(['wal', 'memory']).toContain(result[0].journal_mode);
  });

  test('enforces unique constraint on crypto_prices.coin_id', () => {
    const insert = db.prepare(
      'INSERT INTO crypto_prices (coin_id, symbol, price_usd) VALUES (?, ?, ?)'
    );
    insert.run('bitcoin', 'btc', 50000);
    expect(() => insert.run('bitcoin', 'btc', 51000)).toThrow();
  });

  test('enforces unique constraint on products (source_url, product_id)', () => {
    const insert = db.prepare(
      'INSERT INTO products (source_url, product_id, title) VALUES (?, ?, ?)'
    );
    insert.run('https://example.com', 'prod-1', 'Product 1');
    expect(() => insert.run('https://example.com', 'prod-1', 'Product 1 Dup')).toThrow();
  });

  test('enforces unique constraint on news_articles (source_url, article_id)', () => {
    const insert = db.prepare(
      'INSERT INTO news_articles (source_url, article_id, title, article_url) VALUES (?, ?, ?, ?)'
    );
    insert.run('https://news.com', 'art-1', 'Article 1', 'https://news.com/art-1');
    expect(() =>
      insert.run('https://news.com', 'art-1', 'Article 1 Dup', 'https://news.com/art-1')
    ).toThrow();
  });
});
