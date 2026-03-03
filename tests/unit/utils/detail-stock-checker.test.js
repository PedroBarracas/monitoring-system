const {
  resolveProductUrl,
  isDetailPageOutOfStock,
  getJsonLdStock,
  checkDetailPageStock,
} = require('../../../src/utils/detail-stock-checker');

describe('detail-stock-checker', () => {
  describe('resolveProductUrl', () => {
    test('resolves relative URL against base', () => {
      expect(resolveProductUrl('/product/123', 'https://shop.com/catalog'))
        .toBe('https://shop.com/product/123');
    });

    test('returns absolute URL as-is', () => {
      expect(resolveProductUrl('https://shop.com/product/123', 'https://other.com'))
        .toBe('https://shop.com/product/123');
    });

    test('returns null for empty productUrl', () => {
      expect(resolveProductUrl('', 'https://shop.com')).toBe(null);
    });

    test('returns null for null productUrl', () => {
      expect(resolveProductUrl(null, 'https://shop.com')).toBe(null);
    });

    test('returns null for invalid URL', () => {
      expect(resolveProductUrl('://broken', '://also-broken')).toBe(null);
    });
  });

  describe('isDetailPageOutOfStock', () => {
    test('detects English out of stock', () => {
      expect(isDetailPageOutOfStock('<div>This product is Out of Stock</div>')).toBe(true);
    });

    test('detects Spanish "producto no disponible"', () => {
      expect(isDetailPageOutOfStock('<p>Producto no disponible</p>')).toBe(true);
    });

    test('detects Portuguese "esgotado"', () => {
      expect(isDetailPageOutOfStock('<span>Esgotado</span>')).toBe(true);
    });

    test('detects French "épuisé"', () => {
      expect(isDetailPageOutOfStock('<div>Épuisé</div>')).toBe(true);
    });

    test('returns false for in-stock page', () => {
      expect(isDetailPageOutOfStock('<div>Add to cart</div><p>In stock</p>')).toBe(false);
    });

    test('returns false for empty HTML', () => {
      expect(isDetailPageOutOfStock('')).toBe(false);
    });
  });

  describe('getJsonLdStock', () => {
    test('returns 1 for InStock availability', () => {
      const html = `<html><head><script type="application/ld+json">
        {"@type":"Product","name":"Test","offers":{"@type":"Offer","availability":"https://schema.org/InStock"}}
      </script></head><body></body></html>`;
      expect(getJsonLdStock(html, 'https://shop.com/p/1')).toBe(1);
    });

    test('returns 0 for OutOfStock availability', () => {
      const html = `<html><head><script type="application/ld+json">
        {"@type":"Product","name":"Test","offers":{"@type":"Offer","availability":"https://schema.org/OutOfStock"}}
      </script></head><body></body></html>`;
      expect(getJsonLdStock(html, 'https://shop.com/p/1')).toBe(0);
    });

    test('returns 0 for Discontinued availability', () => {
      const html = `<html><head><script type="application/ld+json">
        {"@type":"Product","name":"Test","offers":{"@type":"Offer","availability":"https://schema.org/Discontinued"}}
      </script></head><body></body></html>`;
      expect(getJsonLdStock(html, 'https://shop.com/p/1')).toBe(0);
    });

    test('handles AggregateOffer with nested offers', () => {
      const html = `<html><head><script type="application/ld+json">
        {"@type":"Product","name":"Test","offers":{"@type":"AggregateOffer","offers":{"@type":"Offer","availability":"https://schema.org/OutOfStock"}}}
      </script></head><body></body></html>`;
      expect(getJsonLdStock(html, 'https://shop.com/p/1')).toBe(0);
    });

    test('returns null when no Product JSON-LD exists', () => {
      const html = '<html><head><script type="application/ld+json">{"@type":"Organization","name":"Shop"}</script></head><body></body></html>';
      expect(getJsonLdStock(html, 'https://shop.com/p/1')).toBe(null);
    });

    test('returns null for empty HTML', () => {
      expect(getJsonLdStock('', 'https://shop.com/p/1')).toBe(null);
    });
  });

  describe('checkDetailPageStock', () => {
    let mockHttpClient;
    let mockLogger;

    beforeEach(() => {
      mockHttpClient = { fetchHtml: jest.fn() };
      mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    });

    test('overrides inStock to 0 when detail page has OOS keyword', async () => {
      const products = [
        { productId: 'p1', productUrl: '/product/p1', title: 'Product 1', inStock: 1, sourceUrl: 'https://shop.com' },
      ];

      mockHttpClient.fetchHtml.mockResolvedValue('<html><body>Producto no disponible</body></html>');

      const result = await checkDetailPageStock(products, {
        baseUrl: 'https://shop.com',
        httpClient: mockHttpClient,
        logger: mockLogger,
        concurrency: 3,
      });

      expect(result).toHaveLength(1);
      expect(result[0].inStock).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Detail page OOS keyword override'));
    });

    test('uses JSON-LD to set inStock when Product schema exists', async () => {
      const products = [
        { productId: 'p1', productUrl: '/product/p1', title: 'Product 1', inStock: 1, sourceUrl: 'https://shop.com' },
      ];

      const html = `<html><head><script type="application/ld+json">
        {"@type":"Product","name":"Product 1","offers":{"@type":"Offer","availability":"https://schema.org/OutOfStock"}}
      </script></head><body>Add to cart</body></html>`;
      mockHttpClient.fetchHtml.mockResolvedValue(html);

      const result = await checkDetailPageStock(products, {
        baseUrl: 'https://shop.com',
        httpClient: mockHttpClient,
        logger: mockLogger,
      });

      expect(result).toHaveLength(1);
      expect(result[0].inStock).toBe(0);
    });

    test('JSON-LD takes priority over keyword search', async () => {
      const products = [
        { productId: 'p1', productUrl: '/product/p1', title: 'Product 1', inStock: 1, sourceUrl: 'https://shop.com' },
      ];

      // JSON-LD says InStock but body text has OOS keyword — JSON-LD should win
      const html = `<html><head><script type="application/ld+json">
        {"@type":"Product","name":"Product 1","offers":{"@type":"Offer","availability":"https://schema.org/InStock"}}
      </script></head><body>Producto no disponible</body></html>`;
      mockHttpClient.fetchHtml.mockResolvedValue(html);

      const result = await checkDetailPageStock(products, {
        baseUrl: 'https://shop.com',
        httpClient: mockHttpClient,
        logger: mockLogger,
      });

      expect(result).toHaveLength(1);
      expect(result[0].inStock).toBe(1);
    });

    test('keeps inStock 1 when detail page is in stock', async () => {
      const products = [
        { productId: 'p1', productUrl: '/product/p1', title: 'Product 1', inStock: 1, sourceUrl: 'https://shop.com' },
      ];

      mockHttpClient.fetchHtml.mockResolvedValue('<html><body>Add to cart</body></html>');

      const result = await checkDetailPageStock(products, {
        baseUrl: 'https://shop.com',
        httpClient: mockHttpClient,
        logger: mockLogger,
      });

      expect(result).toHaveLength(1);
      expect(result[0].inStock).toBe(1);
    });

    test('falls back to listing status on fetch error', async () => {
      const products = [
        { productId: 'p1', productUrl: '/product/p1', title: 'Product 1', inStock: 1, sourceUrl: 'https://shop.com' },
      ];

      mockHttpClient.fetchHtml.mockRejectedValue(new Error('Timeout'));

      const result = await checkDetailPageStock(products, {
        baseUrl: 'https://shop.com',
        httpClient: mockHttpClient,
        logger: mockLogger,
      });

      expect(result).toHaveLength(1);
      expect(result[0].inStock).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Detail page fetch failed'));
    });

    test('skips products with no URL', async () => {
      const products = [
        { productId: 'p1', productUrl: '', title: 'Product 1', inStock: 1, sourceUrl: 'https://shop.com' },
      ];

      const result = await checkDetailPageStock(products, {
        baseUrl: 'https://shop.com',
        httpClient: mockHttpClient,
        logger: mockLogger,
      });

      expect(result).toHaveLength(1);
      expect(result[0].inStock).toBe(1);
      expect(mockHttpClient.fetchHtml).not.toHaveBeenCalled();
    });

    test('handles mix of OOS and in-stock detail pages', async () => {
      const products = [
        { productId: 'p1', productUrl: '/product/p1', title: 'Product 1', inStock: 1, sourceUrl: 'https://shop.com' },
        { productId: 'p2', productUrl: '/product/p2', title: 'Product 2', inStock: 1, sourceUrl: 'https://shop.com' },
        { productId: 'p3', productUrl: '/product/p3', title: 'Product 3', inStock: 1, sourceUrl: 'https://shop.com' },
      ];

      mockHttpClient.fetchHtml
        .mockResolvedValueOnce('<html><body>Producto no disponible</body></html>')
        .mockResolvedValueOnce('<html><body>Add to cart</body></html>')
        .mockRejectedValueOnce(new Error('500'));

      const result = await checkDetailPageStock(products, {
        baseUrl: 'https://shop.com',
        httpClient: mockHttpClient,
        logger: mockLogger,
      });

      expect(result).toHaveLength(3);
      expect(result[0].inStock).toBe(0); // OOS from keyword
      expect(result[1].inStock).toBe(1); // in stock from detail
      expect(result[2].inStock).toBe(1); // fallback on error
    });

    test('handles mix of JSON-LD and keyword detection across products', async () => {
      const products = [
        { productId: 'p1', productUrl: '/product/p1', title: 'Product 1', inStock: 1, sourceUrl: 'https://shop.com' },
        { productId: 'p2', productUrl: '/product/p2', title: 'Product 2', inStock: 1, sourceUrl: 'https://shop.com' },
      ];

      // p1: JSON-LD says OutOfStock
      const htmlJsonLd = `<html><head><script type="application/ld+json">
        {"@type":"Product","name":"Product 1","offers":{"@type":"Offer","availability":"https://schema.org/OutOfStock"}}
      </script></head><body></body></html>`;
      // p2: No JSON-LD, keyword says OOS
      const htmlKeyword = '<html><body>Agotado</body></html>';

      mockHttpClient.fetchHtml
        .mockResolvedValueOnce(htmlJsonLd)
        .mockResolvedValueOnce(htmlKeyword);

      const result = await checkDetailPageStock(products, {
        baseUrl: 'https://shop.com',
        httpClient: mockHttpClient,
        logger: mockLogger,
      });

      expect(result).toHaveLength(2);
      expect(result[0].inStock).toBe(0); // OOS from JSON-LD
      expect(result[1].inStock).toBe(0); // OOS from keyword
    });
  });
});
