function createCryptoRepository(db) {
  const selectStmt = db.prepare(
    'SELECT * FROM crypto_prices WHERE coin_id = ?'
  );
  const upsertStmt = db.prepare(`
    INSERT INTO crypto_prices (coin_id, symbol, price_usd, checked_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(coin_id) DO UPDATE SET
      price_usd = excluded.price_usd,
      checked_at = excluded.checked_at
  `);

  return {
    getPrice(coinId) {
      return selectStmt.get(coinId);
    },

    upsertPrice(coinId, symbol, priceUsd) {
      upsertStmt.run(coinId, symbol, priceUsd);
    },
  };
}

module.exports = { createCryptoRepository };
