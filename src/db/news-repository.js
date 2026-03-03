function createNewsRepository(db) {
  const selectStmt = db.prepare(
    'SELECT * FROM news_articles WHERE source_url = ? AND article_id = ?'
  );
  const insertStmt = db.prepare(`
    INSERT INTO news_articles (source_url, article_id, title, article_url)
    VALUES (?, ?, ?, ?)
  `);

  return {
    getArticle(sourceUrl, articleId) {
      return selectStmt.get(sourceUrl, articleId);
    },

    insertArticle({ sourceUrl, articleId, title, articleUrl }) {
      insertStmt.run(sourceUrl, articleId, title, articleUrl);
    },
  };
}

module.exports = { createNewsRepository };
