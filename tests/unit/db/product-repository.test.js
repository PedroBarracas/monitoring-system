const { createTestDb } = require('../../helpers/mock-db');
const { createProductRepository } = require('../../../src/db/product-repository');

describe('product-repository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = createTestDb();
    repo = createProductRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('getProduct returns undefined when product does not exist', () => {
    expect(repo.getProduct('https://shop.com', 'prod-001')).toBeUndefined();
  });

  test('insertProduct inserts a row', () => {
    repo.insertProduct({
      sourceUrl: 'https://shop.com',
      productId: 'prod-001',
      productUrl: 'https://shop.com/products/001',
      title: 'Widget Alpha',
      inStock: 1,
    });

    const row = repo.getProduct('https://shop.com', 'prod-001');
    expect(row).toBeDefined();
    expect(row.title).toBe('Widget Alpha');
    expect(row.in_stock).toBe(1);
    expect(row.product_url).toBe('https://shop.com/products/001');
  });

  test('updateProduct updates stock and title', () => {
    repo.insertProduct({
      sourceUrl: 'https://shop.com',
      productId: 'prod-001',
      productUrl: 'https://shop.com/products/001',
      title: 'Widget Alpha',
      inStock: 1,
    });

    repo.updateProduct({
      sourceUrl: 'https://shop.com',
      productId: 'prod-001',
      inStock: 0,
      title: 'Widget Alpha v2',
    });

    const row = repo.getProduct('https://shop.com', 'prod-001');
    expect(row.in_stock).toBe(0);
    expect(row.title).toBe('Widget Alpha v2');
  });

  test('countBySource returns 0 when no products exist', () => {
    expect(repo.countBySource('https://shop.com')).toBe(0);
  });

  test('countBySource returns correct count', () => {
    repo.insertProduct({ sourceUrl: 'https://shop.com', productId: 'p1', productUrl: '', title: 'A', inStock: 1 });
    repo.insertProduct({ sourceUrl: 'https://shop.com', productId: 'p2', productUrl: '', title: 'B', inStock: 1 });
    repo.insertProduct({ sourceUrl: 'https://other.com', productId: 'p1', productUrl: '', title: 'C', inStock: 1 });

    expect(repo.countBySource('https://shop.com')).toBe(2);
    expect(repo.countBySource('https://other.com')).toBe(1);
  });

  test('getProduct scopes by source_url', () => {
    repo.insertProduct({
      sourceUrl: 'https://shop1.com',
      productId: 'prod-001',
      productUrl: '',
      title: 'From Shop 1',
      inStock: 1,
    });
    repo.insertProduct({
      sourceUrl: 'https://shop2.com',
      productId: 'prod-001',
      productUrl: '',
      title: 'From Shop 2',
      inStock: 0,
    });

    expect(repo.getProduct('https://shop1.com', 'prod-001').title).toBe('From Shop 1');
    expect(repo.getProduct('https://shop2.com', 'prod-001').title).toBe('From Shop 2');
  });

  describe('removal hysteresis', () => {
    const seed = () =>
      repo.insertProduct({
        sourceUrl: 'https://shop.com',
        productId: 'prod-001',
        productUrl: '',
        title: 'Widget',
        inStock: 1,
      });

    test('new products start with missing_count 0 and removed 0', () => {
      seed();
      const row = repo.getProduct('https://shop.com', 'prod-001');
      expect(row.missing_count).toBe(0);
      expect(row.removed).toBe(0);
    });

    test('markMissing increments missing_count without removing below threshold', () => {
      seed();
      repo.markMissing('https://shop.com', 'prod-001', 3);
      let row = repo.getProduct('https://shop.com', 'prod-001');
      expect(row.missing_count).toBe(1);
      expect(row.removed).toBe(0);

      repo.markMissing('https://shop.com', 'prod-001', 3);
      row = repo.getProduct('https://shop.com', 'prod-001');
      expect(row.missing_count).toBe(2);
      expect(row.removed).toBe(0);
    });

    test('markMissing sets removed once threshold is reached', () => {
      seed();
      repo.markMissing('https://shop.com', 'prod-001', 3);
      repo.markMissing('https://shop.com', 'prod-001', 3);
      repo.markMissing('https://shop.com', 'prod-001', 3);
      const row = repo.getProduct('https://shop.com', 'prod-001');
      expect(row.missing_count).toBe(3);
      expect(row.removed).toBe(1);
    });

    test('updateProduct resets missing_count (a sighting clears the streak)', () => {
      seed();
      repo.markMissing('https://shop.com', 'prod-001', 3);
      repo.markMissing('https://shop.com', 'prod-001', 3);
      repo.updateProduct({
        sourceUrl: 'https://shop.com',
        productId: 'prod-001',
        inStock: 1,
        title: 'Widget',
      });
      const row = repo.getProduct('https://shop.com', 'prod-001');
      expect(row.missing_count).toBe(0);
      expect(row.removed).toBe(0);
    });

    test('reactivateProduct clears removed flag and missing_count', () => {
      seed();
      repo.markMissing('https://shop.com', 'prod-001', 2);
      repo.markMissing('https://shop.com', 'prod-001', 2);
      expect(repo.getProduct('https://shop.com', 'prod-001').removed).toBe(1);

      repo.reactivateProduct({
        sourceUrl: 'https://shop.com',
        productId: 'prod-001',
        inStock: 1,
        title: 'Widget',
      });
      const row = repo.getProduct('https://shop.com', 'prod-001');
      expect(row.removed).toBe(0);
      expect(row.missing_count).toBe(0);
    });

    test('removed products are excluded from countBySource and getProductsBySource', () => {
      seed();
      repo.markMissing('https://shop.com', 'prod-001', 1); // threshold 1 → removed immediately
      expect(repo.countBySource('https://shop.com')).toBe(0);
      expect(repo.getProductsBySource('https://shop.com')).toHaveLength(0);
    });
  });
});
