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
    'SELECT COUNT(*) AS cnt FROM products WHERE source_url = ?'
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
  };
}

module.exports = { createProductRepository };
