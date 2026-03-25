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
    SET in_stock = ?, title = ?, price = ?, currency = ?, last_checked_at = datetime('now')
    WHERE source_url = ? AND product_id = ?
  `);
  const countBySourceStmt = db.prepare(
    'SELECT COUNT(*) AS cnt FROM products WHERE source_url = ? AND removed = 0'
  );
  const selectBySourceStmt = db.prepare(
    'SELECT * FROM products WHERE source_url = ? AND removed = 0'
  );
  const markRemovedStmt = db.prepare(
    'UPDATE products SET removed = 1, last_checked_at = datetime(\'now\') WHERE source_url = ? AND product_id = ?'
  );
  const reactivateStmt = db.prepare(
    'UPDATE products SET removed = 0, in_stock = ?, title = ?, price = ?, currency = ?, last_checked_at = datetime(\'now\') WHERE source_url = ? AND product_id = ?'
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

    markRemoved(sourceUrl, productId) {
      markRemovedStmt.run(sourceUrl, productId);
    },

    reactivateProduct({ sourceUrl, productId, inStock, title, price, currency }) {
      reactivateStmt.run(inStock, title, price || null, currency || null, sourceUrl, productId);
    },
  };
}

module.exports = { createProductRepository };
