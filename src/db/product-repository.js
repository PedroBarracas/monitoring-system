function createProductRepository(db) {
  const selectStmt = db.prepare(
    'SELECT * FROM products WHERE source_url = ? AND product_id = ?'
  );
  const insertStmt = db.prepare(`
    INSERT INTO products (source_url, product_id, product_url, title, in_stock, price, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE products
    SET in_stock = ?, title = ?, price = ?, currency = ?, missing_count = 0, last_checked_at = datetime('now')
    WHERE source_url = ? AND product_id = ?
  `);
  const countBySourceStmt = db.prepare(
    'SELECT COUNT(*) AS cnt FROM products WHERE source_url = ? AND removed = 0'
  );
  const selectBySourceStmt = db.prepare(
    'SELECT * FROM products WHERE source_url = ? AND removed = 0'
  );
  // Removal hysteresis: bump the absence counter and only flip `removed` once
  // the product has been missing for `threshold` consecutive cycles.
  const markMissingStmt = db.prepare(`
    UPDATE products
    SET missing_count = missing_count + 1,
        removed = CASE WHEN missing_count + 1 >= ? THEN 1 ELSE 0 END,
        last_checked_at = datetime('now')
    WHERE source_url = ? AND product_id = ?
  `);
  const reactivateStmt = db.prepare(
    'UPDATE products SET removed = 0, missing_count = 0, in_stock = ?, title = ?, price = ?, currency = ?, last_checked_at = datetime(\'now\') WHERE source_url = ? AND product_id = ?'
  );

  return {
    getProduct(sourceUrl, productId) {
      return selectStmt.get(sourceUrl, productId);
    },

    insertProduct({ sourceUrl, productId, productUrl, title, inStock, price, currency }) {
      insertStmt.run(sourceUrl, productId, productUrl, title, inStock, price || null, currency || null);
    },

    updateProduct({ sourceUrl, productId, inStock, title, price, currency }) {
      updateStmt.run(inStock, title, price || null, currency || null, sourceUrl, productId);
    },

    countBySource(sourceUrl) {
      return countBySourceStmt.get(sourceUrl).cnt;
    },

    getProductsBySource(sourceUrl) {
      return selectBySourceStmt.all(sourceUrl);
    },

    // Records that a product was absent from this cycle's extraction.
    // It is only flagged `removed` once it has been missing `threshold`
    // consecutive cycles; any sighting (update/reactivate) resets the counter.
    markMissing(sourceUrl, productId, threshold) {
      markMissingStmt.run(threshold, sourceUrl, productId);
    },

    reactivateProduct({ sourceUrl, productId, inStock, title, price, currency }) {
      reactivateStmt.run(inStock, title, price || null, currency || null, sourceUrl, productId);
    },
  };
}

module.exports = { createProductRepository };
