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
      missing_count   INTEGER NOT NULL DEFAULT 0,
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

    -- ETag / Last-Modified per source URL for conditional GETs. The TTL on
    -- last_full_fetch_at is what caps how long a misbehaving server (or stale
    -- CDN cache) can lie to us via a phantom 304.
    --
    -- content_hash: SHA-256 of the canonical extracted product list from the
    -- last full GET. Used to detect "lying 304s" — when the TTL fires and the
    -- new full-GET hash differs from the stored one AND we'd received any 304s
    -- since the last full fetch, we know the server was claiming "unchanged"
    -- on a body that actually had changed. Such sources get conditional_disabled
    -- set and are excluded from the conditional path going forward.
    CREATE TABLE IF NOT EXISTS source_cache (
      source_url            TEXT PRIMARY KEY,
      etag                  TEXT,
      last_modified         TEXT,
      last_full_fetch_at    TEXT NOT NULL DEFAULT (datetime('now')),
      content_hash          TEXT,
      had_304_since_last    INTEGER NOT NULL DEFAULT 0,
      conditional_disabled  INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Backfill columns added after the source_cache table shipped.
  const sourceCacheCols = db.prepare("PRAGMA table_info('source_cache')").all();
  if (!sourceCacheCols.some((c) => c.name === 'content_hash')) {
    db.exec("ALTER TABLE source_cache ADD COLUMN content_hash TEXT");
  }
  if (!sourceCacheCols.some((c) => c.name === 'had_304_since_last')) {
    db.exec("ALTER TABLE source_cache ADD COLUMN had_304_since_last INTEGER NOT NULL DEFAULT 0");
  }
  if (!sourceCacheCols.some((c) => c.name === 'conditional_disabled')) {
    db.exec("ALTER TABLE source_cache ADD COLUMN conditional_disabled INTEGER NOT NULL DEFAULT 0");
  }

  // Backfill columns added after the products table shipped.
  const cols = db.prepare("PRAGMA table_info('products')").all();
  if (!cols.some((c) => c.name === 'removed')) {
    db.exec("ALTER TABLE products ADD COLUMN removed INTEGER NOT NULL DEFAULT 0");
  }
  // Consecutive cycles a product has been absent from extraction. Used for
  // removal hysteresis so a single flaky scrape doesn't mark products removed.
  if (!cols.some((c) => c.name === 'missing_count')) {
    db.exec("ALTER TABLE products ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0");
  }
}

module.exports = { runMigrations };
