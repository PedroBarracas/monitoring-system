const { createTestDb } = require('../../helpers/mock-db');
const { createNewsRepository } = require('../../../src/db/news-repository');

describe('news-repository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = createTestDb();
    repo = createNewsRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('getArticle returns undefined when article does not exist', () => {
    expect(repo.getArticle('https://news.com', 'art-001')).toBeUndefined();
  });

  test('insertArticle inserts a row', () => {
    repo.insertArticle({
      sourceUrl: 'https://news.com',
      articleId: 'art-001',
      title: 'Breaking News',
      articleUrl: 'https://news.com/articles/001',
    });

    const row = repo.getArticle('https://news.com', 'art-001');
    expect(row).toBeDefined();
    expect(row.title).toBe('Breaking News');
    expect(row.article_url).toBe('https://news.com/articles/001');
    expect(row.first_seen_at).toBeDefined();
  });

  test('getArticle scopes by source_url', () => {
    repo.insertArticle({
      sourceUrl: 'https://news1.com',
      articleId: 'art-001',
      title: 'From Source 1',
      articleUrl: 'https://news1.com/art/001',
    });
    repo.insertArticle({
      sourceUrl: 'https://news2.com',
      articleId: 'art-001',
      title: 'From Source 2',
      articleUrl: 'https://news2.com/art/001',
    });

    expect(repo.getArticle('https://news1.com', 'art-001').title).toBe('From Source 1');
    expect(repo.getArticle('https://news2.com', 'art-001').title).toBe('From Source 2');
  });

  test('does not duplicate on repeated insert of same article id + source', () => {
    repo.insertArticle({
      sourceUrl: 'https://news.com',
      articleId: 'art-001',
      title: 'Breaking News',
      articleUrl: 'https://news.com/articles/001',
    });

    // Second insert with same key should throw (UNIQUE constraint)
    expect(() =>
      repo.insertArticle({
        sourceUrl: 'https://news.com',
        articleId: 'art-001',
        title: 'Duplicate',
        articleUrl: 'https://news.com/articles/001',
      })
    ).toThrow();
  });
});
