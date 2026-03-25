function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crypto_prices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      coin_id     TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      price_usd   REAL NOT NULL,
      checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(coin_id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url      TEXT NOT NULL,
      product_id      TEXT NOT NULL,
      product_url     TEXT,
      title           TEXT NOT NULL,
      in_stock        INTEGER NOT NULL DEFAULT 1,
      price           TEXT,
      currency        TEXT,
      first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
      removed         INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_url, product_id)
    );

    CREATE TABLE IF NOT EXISTS news_articles (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url      TEXT NOT NULL,
      article_id      TEXT NOT NULL,
      title           TEXT NOT NULL,
      article_url     TEXT NOT NULL,
      published_at    TEXT,
      first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_url, article_id)
    );

    CREATE TABLE IF NOT EXISTS alert_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT NOT NULL,
      details     TEXT NOT NULL,
      sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Add 'removed' column to existing products table
  const cols = db.prepare("PRAGMA table_info('products')").all();
  if (!cols.some((c) => c.name === 'removed')) {
    db.exec("ALTER TABLE products ADD COLUMN removed INTEGER NOT NULL DEFAULT 0");
  }
}

module.exports = { runMigrations };
