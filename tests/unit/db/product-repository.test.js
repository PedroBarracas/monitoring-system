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
});
