const { extract, slugify } = require('../../../src/extractors/css-extractor');
const { PRODUCT_HTML, DEFAULT_PRODUCT_SELECTORS } = require('../../helpers/fixtures');

describe('css-extractor', () => {
  const sourceUrl = 'https://shop.example.com/new-arrivals';

  describe('extract', () => {
    test('extracts products from HTML using selectors', () => {
      const products = extract(PRODUCT_HTML, DEFAULT_PRODUCT_SELECTORS, sourceUrl, ['out of stock']);

      expect(products).toHaveLength(3);
      expect(products[0]).toEqual({
        productId: 'prod-001',
        productUrl: 'https://shop.example.com/products/prod-001',
        title: 'Widget Alpha',
        inStock: 1,
        price: null,
        currency: null,
        sourceUrl,
      });
      expect(products[1].inStock).toBe(0);
      expect(products[2].inStock).toBe(1);
    });

    test('skips elements with no title', () => {
      const html = `
        <div class="product-card" data-product-id="p1">
          <h3 class="product-title"></h3>
          <span class="stock-label">In Stock</span>
        </div>
        <div class="product-card" data-product-id="p2">
          <h3 class="product-title">Real Product</h3>
          <span class="stock-label">In Stock</span>
        </div>
      `;
      const products = extract(html, DEFAULT_PRODUCT_SELECTORS, sourceUrl, ['out of stock']);
      expect(products).toHaveLength(1);
      expect(products[0].title).toBe('Real Product');
    });

    test('falls back to slugified title when no product ID attribute', () => {
      const html = `
        <div class="product-card">
          <h3 class="product-title">My Cool Product</h3>
          <span class="stock-label">In Stock</span>
          <a href="/products/cool">View</a>
        </div>
      `;
      const products = extract(html, DEFAULT_PRODUCT_SELECTORS, sourceUrl, []);
      expect(products[0].productId).toBe('my-cool-product');
    });

    test('matches multilingual out-of-stock keywords', () => {
      const html = `
        <div class="product-card" data-product-id="p1">
          <h3 class="product-title">Produto A</h3>
          <span class="stock-label">Esgotado</span>
          <a href="/a">View</a>
        </div>
        <div class="product-card" data-product-id="p2">
          <h3 class="product-title">Produto B</h3>
          <span class="stock-label">Disponível</span>
          <a href="/b">View</a>
        </div>
      `;
      const keywords = ['esgotado', 'indisponível', 'out of stock'];
      const products = extract(html, DEFAULT_PRODUCT_SELECTORS, sourceUrl, keywords);
      expect(products[0].inStock).toBe(0);
      expect(products[1].inStock).toBe(1);
    });

    test('keyword matching is case-insensitive', () => {
      const html = `
        <div class="product-card" data-product-id="p1">
          <h3 class="product-title">Item</h3>
          <span class="stock-label">SOLD OUT</span>
          <a href="/a">View</a>
        </div>
      `;
      const products = extract(html, DEFAULT_PRODUCT_SELECTORS, sourceUrl, ['sold out']);
      expect(products[0].inStock).toBe(0);
    });

    test('returns empty array for empty HTML', () => {
      const products = extract('<html><body></body></html>', DEFAULT_PRODUCT_SELECTORS, sourceUrl, []);
      expect(products).toEqual([]);
    });

    test('defaults to in-stock when no keywords provided', () => {
      const html = `
        <div class="product-card" data-product-id="p1">
          <h3 class="product-title">Item</h3>
          <span class="stock-label">Out of Stock</span>
          <a href="/a">View</a>
        </div>
      `;
      const products = extract(html, DEFAULT_PRODUCT_SELECTORS, sourceUrl, []);
      expect(products[0].inStock).toBe(1);
    });
  });

  describe('slugify', () => {
    test('converts text to slug', () => {
      expect(slugify('Widget Alpha')).toBe('widget-alpha');
    });

    test('handles special characters', () => {
      expect(slugify('USB 3.0 Cable')).toBe('usb-3-0-cable');
    });

    test('strips leading and trailing hyphens', () => {
      expect(slugify('  Hello World  ')).toBe('hello-world');
    });

    test('collapses multiple separators', () => {
      expect(slugify('a---b___c')).toBe('a-b-c');
    });
  });
});
