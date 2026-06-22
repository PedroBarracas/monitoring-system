const { createProductMonitor } = require('../../../src/monitors/product-monitor');
const {
  PRODUCT_HTML,
  PRODUCT_HTML_WITH_NEW_ITEM,
  DEFAULT_PRODUCT_SELECTORS,
} = require('../../helpers/fixtures');

describe('product-monitor', () => {
  let mockProductRepo;
  let mockAlertRepo;
  let mockNotifier;
  let mockErrorNotifier;
  let mockHttpClient;
  let mockLogger;
  let monitor;

  const config = {
    targets: [
      {
        url: 'https://shop.example.com/new-arrivals',
        selectors: DEFAULT_PRODUCT_SELECTORS,
        extractor: 'css',
        dynamic: false,
      },
    ],
    concurrency: 5,
  };

  beforeEach(() => {
    mockProductRepo = {
      getProduct: jest.fn(),
      insertProduct: jest.fn(),
      updateProduct: jest.fn(),
      countBySource: jest.fn().mockReturnValue(5),
      getProductsBySource: jest.fn().mockReturnValue([]),
      markMissing: jest.fn(),
      reactivateProduct: jest.fn(),
    };
    mockAlertRepo = { logAlert: jest.fn() };
    mockNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
    mockErrorNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
    mockHttpClient = { fetchHtml: jest.fn() };
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    monitor = createProductMonitor({
      productRepo: mockProductRepo,
      alertRepo: mockAlertRepo,
      notifiers: { default: mockNotifier },
      errorNotifier: mockErrorNotifier,
      httpClient: mockHttpClient,
      config,
      logger: mockLogger,
    });
  });

  test('has correct name', () => {
    expect(monitor.name).toBe('product-monitor');
  });

  test('first run inserts all products silently (no alerts)', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
    mockProductRepo.getProduct.mockReturnValue(undefined);
    mockProductRepo.countBySource.mockReturnValue(0);

    const result = await monitor.run();

    expect(result.alertsSent).toBe(0);
    expect(result.errors).toEqual([]);

    expect(mockProductRepo.insertProduct).toHaveBeenCalledTimes(3);
    expect(mockProductRepo.insertProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'prod-001',
        title: 'Widget Alpha',
        inStock: 1,
      })
    );
    expect(mockProductRepo.insertProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'prod-002',
        title: 'Widget Beta',
        inStock: 0,
      })
    );

    expect(mockNotifier.sendAlert).not.toHaveBeenCalled();
  });

  test('no alerts on second run with same products', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
    mockProductRepo.getProduct
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce({ in_stock: 0 })
      .mockReturnValueOnce({ in_stock: 1 });

    const result = await monitor.run();

    expect(result.alertsSent).toBe(0);
    expect(mockNotifier.sendAlert).not.toHaveBeenCalled();
    expect(mockProductRepo.updateProduct).toHaveBeenCalledTimes(3);
  });

  test('detects stock status change', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML_WITH_NEW_ITEM);
    mockProductRepo.getProduct
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce({ in_stock: 0 })
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce(undefined);

    const result = await monitor.run();

    expect(result.alertsSent).toBe(2);

    const stockChangeCall = mockNotifier.sendAlert.mock.calls.find(
      (call) => call[0].eventType === 'STOCK_CHANGE'
    );
    expect(stockChangeCall).toBeDefined();
    expect(stockChangeCall[0].title).toBe('Widget Beta');
  });

  test('detects new product added', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML_WITH_NEW_ITEM);
    mockProductRepo.getProduct
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce(undefined);

    const result = await monitor.run();

    const newProductCall = mockNotifier.sendAlert.mock.calls.find(
      (call) => call[0].eventType === 'NEW_PRODUCT'
    );
    expect(newProductCall).toBeDefined();
    expect(newProductCall[0].title).toBe('🛒 New product added: Widget Delta');
  });

  test('new product notification always includes a Price line', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML_WITH_NEW_ITEM);
    mockProductRepo.getProduct
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce(undefined);

    await monitor.run();

    const newProductCall = mockNotifier.sendAlert.mock.calls.find(
      (call) => call[0].eventType === 'NEW_PRODUCT'
    );
    expect(newProductCall).toBeDefined();
    // DEFAULT_PRODUCT_SELECTORS has no price selector, so price is unextracted —
    // the line must still be present, with the "Unknown" fallback.
    expect(newProductCall[0].body).toContain('Price: Unknown');
  });

  test('handles fetch error gracefully', async () => {
    mockHttpClient.fetchHtml.mockRejectedValue(new Error('Connection refused'));

    const result = await monitor.run();
    expect(result.alertsSent).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Connection refused');
  });

  test('handles empty HTML gracefully', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue('<html><body></body></html>');

    const result = await monitor.run();
    expect(result.alertsSent).toBe(0);
    expect(result.errors).toEqual([]);
  });

  test('updates unchanged products via updateProduct', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
    mockProductRepo.getProduct
      .mockReturnValueOnce({ in_stock: 1 })
      .mockReturnValueOnce({ in_stock: 0 })
      .mockReturnValueOnce({ in_stock: 1 });

    await monitor.run();

    expect(mockProductRepo.updateProduct).toHaveBeenCalledTimes(3);
  });

  test('records alerts via alertRepo', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
    mockProductRepo.getProduct.mockReturnValue(undefined);

    await monitor.run();

    expect(mockAlertRepo.logAlert).toHaveBeenCalledTimes(3);
    expect(mockAlertRepo.logAlert).toHaveBeenCalledWith(
      'new_product',
      expect.objectContaining({ productId: 'prod-001' })
    );
  });

  test('handles multiple targets', async () => {
    const multiConfig = {
      targets: [
        { url: 'https://shop1.com', selectors: DEFAULT_PRODUCT_SELECTORS, extractor: 'css', dynamic: false },
        { url: 'https://shop2.com', selectors: DEFAULT_PRODUCT_SELECTORS, extractor: 'css', dynamic: false },
      ],
      concurrency: 5,
    };
    const multiMonitor = createProductMonitor({
      productRepo: mockProductRepo,
      alertRepo: mockAlertRepo,
      notifiers: { default: mockNotifier },
      errorNotifier: mockErrorNotifier,
      httpClient: mockHttpClient,
      config: multiConfig,
      logger: mockLogger,
    });

    mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
    mockProductRepo.getProduct.mockReturnValue(undefined);

    const result = await multiMonitor.run();

    expect(result.alertsSent).toBe(6);
  });

  describe('extractor dispatch', () => {
    test('uses JSON-LD extractor when extractor is "jsonld"', async () => {
      const jsonldConfig = {
        targets: [{ url: 'https://shop.example.com', extractor: 'jsonld', dynamic: false }],
        concurrency: 5,
      };
      const jsonldHtml = `<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'JSON-LD Widget',
        sku: 'JLD-1',
        offers: { availability: 'https://schema.org/InStock' },
      })}</script></head><body></body></html>`;

      mockHttpClient.fetchHtml.mockResolvedValue(jsonldHtml);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: jsonldConfig,
        logger: mockLogger,
      });

      const result = await m.run();
      expect(result.alertsSent).toBe(1);
      expect(mockProductRepo.insertProduct).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'JLD-1', title: 'JSON-LD Widget' })
      );
    });

    test('uses heuristic extractor when extractor is "heuristic"', async () => {
      const heuristicConfig = {
        targets: [{ url: 'https://shop.example.com', extractor: 'heuristic', dynamic: false }],
        concurrency: 5,
      };
      const shopifyHtml = `<html><body>
        <div class="product-card">
          <h3><a href="/products/heuristic-item">Heuristic Item</a></h3>
        </div>
      </body></html>`;

      mockHttpClient.fetchHtml.mockResolvedValue(shopifyHtml);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: heuristicConfig,
        logger: mockLogger,
      });

      const result = await m.run();
      expect(result.alertsSent).toBe(1);
      expect(mockProductRepo.insertProduct).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'heuristic-item', title: 'Heuristic Item' })
      );
    });

    test('auto mode tries JSON-LD first, falls back to heuristic', async () => {
      const autoConfig = {
        targets: [{ url: 'https://shop.example.com', dynamic: false }],
        concurrency: 5,
      };
      // HTML has no JSON-LD but has Shopify product cards
      const html = `<html><body>
        <div class="product-card">
          <h3><a href="/products/auto-item">Auto Item</a></h3>
        </div>
      </body></html>`;

      mockHttpClient.fetchHtml.mockResolvedValue(html);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: autoConfig,
        logger: mockLogger,
      });

      const result = await m.run();
      expect(result.alertsSent).toBe(1);
      expect(mockProductRepo.insertProduct).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'auto-item', title: 'Auto Item' })
      );
    });

    test('auto mode uses JSON-LD when available (skips heuristic)', async () => {
      const autoConfig = {
        targets: [{ url: 'https://shop.example.com', dynamic: false }],
        concurrency: 5,
      };
      const jsonldHtml = `<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'LD Product',
        sku: 'LD-1',
        offers: { availability: 'https://schema.org/InStock' },
      })}</script></head><body></body></html>`;

      mockHttpClient.fetchHtml.mockResolvedValue(jsonldHtml);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: autoConfig,
        logger: mockLogger,
      });

      const result = await m.run();
      expect(result.alertsSent).toBe(1);
    });
  });

  describe('zero-product protection', () => {
    test('skips update when extraction returns 0 but DB has products', async () => {
      mockHttpClient.fetchHtml.mockResolvedValue('<html><body></body></html>');
      mockProductRepo.countBySource.mockReturnValue(5);

      await monitor.run();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('skipping update')
      );
      expect(mockProductRepo.insertProduct).not.toHaveBeenCalled();
      expect(mockProductRepo.updateProduct).not.toHaveBeenCalled();
    });

    test('does not skip when extraction returns 0 and DB is empty', async () => {
      mockHttpClient.fetchHtml.mockResolvedValue('<html><body></body></html>');
      mockProductRepo.countBySource.mockReturnValue(0);

      await monitor.run();

      const warnCalls = mockLogger.warn.mock.calls.map((c) => c[0]);
      expect(warnCalls.every((msg) => !msg.includes('skipping update'))).toBe(true);
    });
  });

  describe('OOS keyword matching', () => {
    test('detects multilingual out-of-stock keywords via CSS extractor', async () => {
      const html = `<html><body>
        <div class="product-card" data-product-id="p1">
          <h3 class="product-title">Produto A</h3>
          <span class="stock-label">Esgotado</span>
          <a href="/a">View</a>
        </div>
        <div class="product-card" data-product-id="p2">
          <h3 class="product-title">Product B</h3>
          <span class="stock-label">In Stock</span>
          <a href="/b">View</a>
        </div>
      </body></html>`;

      mockHttpClient.fetchHtml.mockResolvedValue(html);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      const result = await monitor.run();

      expect(result.alertsSent).toBe(2);
      const insertCalls = mockProductRepo.insertProduct.mock.calls;
      const p1 = insertCalls.find((c) => c[0].productId === 'p1');
      const p2 = insertCalls.find((c) => c[0].productId === 'p2');
      expect(p1[0].inStock).toBe(0);
      expect(p2[0].inStock).toBe(1);
    });
  });

  describe('detailStock', () => {
    test('detail pages override listing stock status', async () => {
      const detailConfig = {
        targets: [{
          url: 'https://shop.example.com',
          extractor: 'heuristic',
          dynamic: false,
          detailStock: true,
        }],
        concurrency: 5,
      };

      const listingHtml = `<html><body>
        <div class="product-card">
          <h3><a href="/products/item-a">Item A</a></h3>
          <p class="stock-status">In stock</p>
        </div>
        <div class="product-card">
          <h3><a href="/products/item-b">Item B</a></h3>
          <p class="stock-status">In stock</p>
        </div>
      </body></html>`;

      mockHttpClient.fetchHtml
        .mockResolvedValueOnce(listingHtml)                                       // listing page
        .mockResolvedValueOnce('<html>Producto no disponible</html>')              // detail: item-a OOS
        .mockResolvedValueOnce('<html>Add to cart</html>');                        // detail: item-b in stock

      mockProductRepo.getProduct.mockReturnValue(undefined);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: detailConfig,
        logger: mockLogger,
      });

      await m.run();

      const insertCalls = mockProductRepo.insertProduct.mock.calls;
      const itemA = insertCalls.find((c) => c[0].productId === 'item-a');
      const itemB = insertCalls.find((c) => c[0].productId === 'item-b');
      expect(itemA[0].inStock).toBe(0);
      expect(itemB[0].inStock).toBe(1);
    });

    test('does not fetch detail pages when detailStock is absent', async () => {
      const noDetailConfig = {
        targets: [{
          url: 'https://shop.example.com',
          extractor: 'heuristic',
          dynamic: false,
        }],
        concurrency: 5,
      };

      const listingHtml = `<html><body>
        <div class="product-card">
          <h3><a href="/products/item-a">Item A</a></h3>
        </div>
      </body></html>`;

      mockHttpClient.fetchHtml.mockResolvedValue(listingHtml);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: noDetailConfig,
        logger: mockLogger,
      });

      await m.run();

      // Only 1 call for the listing page, no detail page fetches
      expect(mockHttpClient.fetchHtml).toHaveBeenCalledTimes(1);
    });

    test('still inserts and notifies a new product when its detail fetch fails', async () => {
      // detailStock fetch fails for a brand-new product — we still want to know
      // it exists. The listing's in-stock default is used; subsequent cycles
      // correct the stock value once the detail page is reachable.
      const detailConfig = {
        targets: [{
          url: 'https://shop.example.com',
          extractor: 'heuristic',
          dynamic: false,
          detailStock: true,
        }],
        concurrency: 5,
      };

      const listingHtml = `<html><body>
        <div class="product-card">
          <h3><a href="/products/item-a">Item A</a></h3>
          <p class="stock-status">In stock</p>
        </div>
      </body></html>`;

      mockHttpClient.fetchHtml
        .mockResolvedValueOnce(listingHtml)
        .mockRejectedValueOnce(new Error('Timeout'));

      mockProductRepo.getProduct.mockReturnValue(undefined);
      mockProductRepo.countBySource.mockReturnValue(5); // not first-run

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: detailConfig,
        logger: mockLogger,
      });

      await m.run();

      expect(mockProductRepo.insertProduct).toHaveBeenCalledTimes(1);
      expect(mockNotifier.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'NEW_PRODUCT' })
      );
    });

    test('preserves DB stock and fires no alert when detail fetch fails for an existing product', async () => {
      // The exact scenario causing false "Out of Stock -> In Stock" alerts on
      // isekai: DB has the product as OOS, this cycle's detail fetch fails,
      // the listing's in-stock default would otherwise flip the DB state.
      const detailConfig = {
        targets: [{
          url: 'https://shop.example.com',
          extractor: 'heuristic',
          dynamic: false,
          detailStock: true,
        }],
        concurrency: 5,
      };

      const listingHtml = `<html><body>
        <div class="product-card">
          <h3><a href="/products/item-a">Item A</a></h3>
        </div>
      </body></html>`;

      mockHttpClient.fetchHtml
        .mockResolvedValueOnce(listingHtml)
        .mockRejectedValueOnce(new Error('Timeout'));

      // Product exists in DB, currently recorded as OOS.
      mockProductRepo.getProduct.mockReturnValue({ in_stock: 0, removed: 0, missing_count: 0 });
      mockProductRepo.countBySource.mockReturnValue(5);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: detailConfig,
        logger: mockLogger,
      });

      await m.run();

      // updateProduct called with the DB's prior in_stock value preserved
      expect(mockProductRepo.updateProduct).toHaveBeenCalledWith(
        expect.objectContaining({ inStock: 0 })
      );
      // and crucially: no "Out of Stock -> In Stock" alert fired
      expect(mockNotifier.sendAlert).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'STOCK_CHANGE' })
      );
    });
  });

  describe('first-run silent seeding', () => {
    test('skips notifications on first run when store has no products in DB', async () => {
      mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
      mockProductRepo.getProduct.mockReturnValue(undefined);
      mockProductRepo.countBySource.mockReturnValue(0);

      const result = await monitor.run();

      // Products are inserted into DB
      expect(mockProductRepo.insertProduct).toHaveBeenCalledTimes(3);
      // No notifications sent (first run)
      expect(mockNotifier.sendAlert).not.toHaveBeenCalled();
      expect(mockAlertRepo.logAlert).not.toHaveBeenCalled();
      expect(result.alertsSent).toBe(0);
    });

    test('sends notifications for new products when store already has products in DB', async () => {
      mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML_WITH_NEW_ITEM);
      mockProductRepo.getProduct
        .mockReturnValueOnce({ in_stock: 1 })
        .mockReturnValueOnce({ in_stock: 1 })
        .mockReturnValueOnce({ in_stock: 1 })
        .mockReturnValueOnce(undefined);
      mockProductRepo.countBySource.mockReturnValue(3);

      const result = await monitor.run();

      // Only the new product triggers a notification
      expect(mockProductRepo.insertProduct).toHaveBeenCalledTimes(1);
      expect(mockNotifier.sendAlert).toHaveBeenCalledTimes(1);
      expect(mockNotifier.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'NEW_PRODUCT',
          title: '🛒 New product added: Widget Delta',
        })
      );
    });
  });

  describe('removal hysteresis', () => {
    // PRODUCT_HTML extracts prod-001/002/003; prod-099 is in the DB but absent
    // from the page, so it counts as "missing" this cycle.
    const presentInStock = () =>
      mockProductRepo.getProduct
        .mockReturnValueOnce({ in_stock: 1 })
        .mockReturnValueOnce({ in_stock: 0 })
        .mockReturnValueOnce({ in_stock: 1 });

    test('a product missing for the first time is not removed, just counted', async () => {
      mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
      presentInStock();
      mockProductRepo.getProductsBySource.mockReturnValue([
        { product_id: 'prod-099', title: 'Gone Widget', missing_count: 0 },
      ]);

      await monitor.run();

      expect(mockProductRepo.markMissing).toHaveBeenCalledWith(
        'https://shop.example.com/new-arrivals',
        'prod-099',
        3
      );
      const removedAlert = mockAlertRepo.logAlert.mock.calls.find(
        (c) => c[0] === 'products_removed'
      );
      expect(removedAlert).toBeUndefined();
    });

    test('a product missing long enough crosses the threshold and is removed', async () => {
      mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
      presentInStock();
      // missing_count 2 → this cycle's markMissing makes it 3, hitting threshold 3
      mockProductRepo.getProductsBySource.mockReturnValue([
        { product_id: 'prod-099', title: 'Gone Widget', missing_count: 2 },
      ]);

      await monitor.run();

      expect(mockProductRepo.markMissing).toHaveBeenCalledWith(
        'https://shop.example.com/new-arrivals',
        'prod-099',
        3
      );
      expect(mockAlertRepo.logAlert).toHaveBeenCalledWith(
        'products_removed',
        expect.objectContaining({
          count: 1,
          products: [{ productId: 'prod-099', title: 'Gone Widget' }],
        })
      );
    });
  });

  describe('concurrency', () => {
    test('processes targets concurrently up to limit', async () => {
      const manyTargets = {
        targets: Array.from({ length: 4 }, (_, i) => ({
          url: `https://shop${i}.com`,
          selectors: DEFAULT_PRODUCT_SELECTORS,
          extractor: 'css',
          dynamic: false,
        })),
        concurrency: 2,
      };

      mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: manyTargets,
        logger: mockLogger,
      });

      const result = await m.run();
      expect(result.alertsSent).toBe(12);
      expect(mockHttpClient.fetchHtml).toHaveBeenCalledTimes(4);
    });
  });

  describe('🇵🇹 flag prefix on title', () => {
    test('prefixes notification titles with 🇵🇹 for Portuguese (.pt) domains', async () => {
      const ptConfig = {
        targets: [{
          url: 'https://shop.example.pt/new-arrivals',
          selectors: DEFAULT_PRODUCT_SELECTORS,
          extractor: 'css',
          dynamic: false,
        }],
        concurrency: 5,
      };
      mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
      mockProductRepo.getProduct.mockReturnValue(undefined);
      mockProductRepo.countBySource.mockReturnValue(5); // not first-run → notifications fire

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: ptConfig,
        logger: mockLogger,
      });
      await m.run();

      const productAlerts = mockNotifier.sendAlert.mock.calls.filter((c) => c[0].eventType === 'NEW_PRODUCT');
      expect(productAlerts.length).toBeGreaterThan(0);
      for (const call of productAlerts) {
        expect(call[0].title).toMatch(/^🇵🇹\s/);
      }
    });

    test('does not prefix when the target host is not on a Portuguese domain', async () => {
      // default config uses 'https://shop.example.com/...' — not .pt
      mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
      mockProductRepo.getProduct.mockReturnValue(undefined);
      mockProductRepo.countBySource.mockReturnValue(5);

      await monitor.run();

      const productAlerts = mockNotifier.sendAlert.mock.calls.filter((c) => c[0].eventType === 'NEW_PRODUCT');
      expect(productAlerts.length).toBeGreaterThan(0);
      for (const call of productAlerts) {
        expect(call[0].title).not.toMatch(/^🇵🇹/);
      }
    });
  });

  describe('target.currency override', () => {
    test('forces currency on every extracted product when target.currency is set', async () => {
      const overrideConfig = {
        targets: [{
          url: 'https://shop.example.com/store',
          selectors: DEFAULT_PRODUCT_SELECTORS,
          extractor: 'css',
          dynamic: false,
          currency: 'SEK',
        }],
        concurrency: 5,
      };
      mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
      mockProductRepo.getProduct.mockReturnValue(undefined);
      mockProductRepo.countBySource.mockReturnValue(5); // not first-run

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: overrideConfig,
        logger: mockLogger,
      });
      await m.run();

      expect(mockProductRepo.insertProduct).toHaveBeenCalled();
      for (const call of mockProductRepo.insertProduct.mock.calls) {
        expect(call[0].currency).toBe('SEK');
      }
    });
  });

  describe('per-target timeout (cycle safety net)', () => {
    test('a stalled target does not wedge the cycle — it is timed out and surfaced as an error', async () => {
      // fetchHtml never resolves — without the per-target guard, run() would hang forever
      mockHttpClient.fetchHtml.mockReturnValue(new Promise(() => {}));

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: { ...config, targetTimeoutMs: 100 },
        logger: mockLogger,
      });

      const result = await m.run();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/timed out/i);
    });
  });

  describe('per-category notifier routing', () => {
    let pokemonNotifier;
    let onePieceNotifier;
    let defaultNotifier;

    function buildMonitor(targetUrl, extra = {}) {
      pokemonNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
      onePieceNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
      defaultNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
      return createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: {
          default: defaultNotifier,
          pokemon: pokemonNotifier,
          'one-piece': onePieceNotifier,
          ...(extra.notifiers || {}),
        },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: {
          targets: [{
            url: targetUrl,
            selectors: DEFAULT_PRODUCT_SELECTORS,
            extractor: 'css',
            dynamic: false,
            ...(extra.category ? { category: extra.category } : {}),
          }],
          concurrency: 5,
        },
        logger: mockLogger,
      });
    }

    beforeEach(() => {
      mockHttpClient.fetchHtml.mockResolvedValue(PRODUCT_HTML);
      mockProductRepo.getProduct.mockReturnValue(undefined); // new products → trigger alerts
    });

    test('routes a Pokemon URL to the pokemon notifier', async () => {
      const m = buildMonitor('https://shop.example.com/collections/pokemon-tcg');
      await m.run();
      expect(pokemonNotifier.sendAlert).toHaveBeenCalled();
      expect(onePieceNotifier.sendAlert).not.toHaveBeenCalled();
      expect(defaultNotifier.sendAlert).not.toHaveBeenCalled();
    });

    test('routes a One Piece URL to the one-piece notifier', async () => {
      const m = buildMonitor('https://shop.example.com/collections/one-piece-tcg');
      await m.run();
      expect(onePieceNotifier.sendAlert).toHaveBeenCalled();
      expect(pokemonNotifier.sendAlert).not.toHaveBeenCalled();
      expect(defaultNotifier.sendAlert).not.toHaveBeenCalled();
    });

    test('falls back to the default notifier for a generic URL', async () => {
      const m = buildMonitor('https://shop.example.com/collections/trading-cards');
      await m.run();
      expect(defaultNotifier.sendAlert).toHaveBeenCalled();
      expect(pokemonNotifier.sendAlert).not.toHaveBeenCalled();
      expect(onePieceNotifier.sendAlert).not.toHaveBeenCalled();
    });

    test('explicit target.category overrides URL auto-detection', async () => {
      // URL says pokemon, but the explicit category says one-piece — explicit wins
      const m = buildMonitor('https://shop.example.com/collections/pokemon-tcg', { category: 'one-piece' });
      await m.run();
      expect(onePieceNotifier.sendAlert).toHaveBeenCalled();
      expect(pokemonNotifier.sendAlert).not.toHaveBeenCalled();
    });

    test('path tokens win over query tokens', async () => {
      // path is one-piece, query contains pokemon — path should win
      const m = buildMonitor('https://shop.example.com/collections/one-piece-tcg?filter=pokemon');
      await m.run();
      expect(onePieceNotifier.sendAlert).toHaveBeenCalled();
      expect(pokemonNotifier.sendAlert).not.toHaveBeenCalled();
    });

    test('falls back to default when no dedicated notifier exists for the category', async () => {
      // Pokemon URL, but only the default notifier is configured
      defaultNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: defaultNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: {
          targets: [{
            url: 'https://shop.example.com/collections/pokemon-tcg',
            selectors: DEFAULT_PRODUCT_SELECTORS,
            extractor: 'css',
            dynamic: false,
          }],
          concurrency: 5,
        },
        logger: mockLogger,
      });
      await m.run();
      expect(defaultNotifier.sendAlert).toHaveBeenCalled();
    });
  });

  describe('title-keyword filter', () => {
    const FILTERED_HTML = `
      <html><body>
        <div class="product-card" data-product-id="prod-1">
          <h3 class="product-title">Pokemon Booster Box</h3>
          <span class="stock-label">In Stock</span>
          <a href="https://shop.example.com/products/prod-1">View</a>
        </div>
        <div class="product-card" data-product-id="prod-2">
          <h3 class="product-title">Pokemon Card Sleeves 50ct</h3>
          <span class="stock-label">In Stock</span>
          <a href="https://shop.example.com/products/prod-2">View</a>
        </div>
        <div class="product-card" data-product-id="prod-3">
          <h3 class="product-title">Charizard Playmat</h3>
          <span class="stock-label">In Stock</span>
          <a href="https://shop.example.com/products/prod-3">View</a>
        </div>
        <div class="product-card" data-product-id="prod-4">
          <h3 class="product-title">Starter Deck — Bulbasaur</h3>
          <span class="stock-label">In Stock</span>
          <a href="https://shop.example.com/products/prod-4">View</a>
        </div>
      </body></html>
    `;

    test('drops products whose title contains a blocked keyword', async () => {
      mockHttpClient.fetchHtml.mockResolvedValue(FILTERED_HTML);
      mockProductRepo.getProduct.mockReturnValue(undefined);
      mockProductRepo.countBySource.mockReturnValue(0);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: {
          targets: [{
            url: 'https://shop.example.com/x',
            selectors: DEFAULT_PRODUCT_SELECTORS,
            extractor: 'css',
            dynamic: false,
          }],
          concurrency: 5,
          excludeTitleKeywords: ['sleeves', 'playmat', 'starter deck'],
        },
        logger: mockLogger,
      });

      await m.run();
      // Only prod-1 (booster box) survives.
      expect(mockProductRepo.insertProduct).toHaveBeenCalledTimes(1);
      expect(mockProductRepo.insertProduct).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'prod-1', title: 'Pokemon Booster Box' })
      );
    });

    test('matches case-insensitively', async () => {
      const html = `
        <html><body>
          <div class="product-card" data-product-id="x">
            <h3 class="product-title">PIKACHU PLAYMAT EDITION</h3>
            <span class="stock-label">In Stock</span>
            <a href="https://shop.example.com/products/x">View</a>
          </div>
        </body></html>
      `;
      mockHttpClient.fetchHtml.mockResolvedValue(html);
      mockProductRepo.getProduct.mockReturnValue(undefined);
      mockProductRepo.countBySource.mockReturnValue(0);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: {
          targets: [{
            url: 'https://shop.example.com/x',
            selectors: DEFAULT_PRODUCT_SELECTORS,
            extractor: 'css',
            dynamic: false,
          }],
          concurrency: 5,
          excludeTitleKeywords: ['playmat'],
        },
        logger: mockLogger,
      });

      await m.run();
      expect(mockProductRepo.insertProduct).not.toHaveBeenCalled();
    });

    test('no filtering when excludeTitleKeywords is empty', async () => {
      mockHttpClient.fetchHtml.mockResolvedValue(FILTERED_HTML);
      mockProductRepo.getProduct.mockReturnValue(undefined);
      mockProductRepo.countBySource.mockReturnValue(0);

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: mockHttpClient,
        config: {
          targets: [{
            url: 'https://shop.example.com/x',
            selectors: DEFAULT_PRODUCT_SELECTORS,
            extractor: 'css',
            dynamic: false,
          }],
          concurrency: 5,
          excludeTitleKeywords: [],
        },
        logger: mockLogger,
      });

      await m.run();
      expect(mockProductRepo.insertProduct).toHaveBeenCalledTimes(4);
    });
  });

  describe('conditional GET (source cache)', () => {
    const TARGET_URL = 'https://shop.example.com/x';
    const baseTarget = {
      url: TARGET_URL,
      selectors: DEFAULT_PRODUCT_SELECTORS,
      extractor: 'css',
      dynamic: false,
    };

    function mkSourceCacheRepo(initial = null) {
      let row = initial;
      return {
        get: jest.fn(() => row),
        upsertFullFetch: jest.fn((_url, etag, lastModified, contentHash) => {
          row = {
            source_url: TARGET_URL,
            etag: etag || null,
            last_modified: lastModified || null,
            last_full_fetch_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
            content_hash: contentHash || null,
            had_304_since_last: 0,
            conditional_disabled: (row && row.conditional_disabled) || 0,
          };
        }),
        refreshValidators: jest.fn((_url, etag, lastModified) => {
          if (row) {
            row.etag = etag || null;
            row.last_modified = lastModified || null;
            row.had_304_since_last = 1;
          }
        }),
        disableConditional: jest.fn(() => {
          if (row) row.conditional_disabled = 1;
        }),
        _row: () => row,
      };
    }

    function mkClient() {
      return {
        fetchHtml: jest.fn(),
        fetchHtmlConditional: jest.fn(),
      };
    }

    test('first cycle: no validators stored, plain GET, validators captured', async () => {
      const repo = mkSourceCacheRepo(null);
      const client = mkClient();
      client.fetchHtmlConditional.mockResolvedValue({
        status: 200,
        html: PRODUCT_HTML,
        etag: 'W/"v1"',
        lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      });

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        sourceCacheRepo: repo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: client,
        config: { targets: [baseTarget], concurrency: 5 },
        logger: mockLogger,
      });

      mockProductRepo.countBySource.mockReturnValue(0);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      await m.run();

      // No conditional headers sent on the first call.
      expect(client.fetchHtmlConditional).toHaveBeenCalledWith(TARGET_URL, {});
      // Validators captured for next cycle (the 4th arg is the content hash).
      expect(repo.upsertFullFetch).toHaveBeenCalledWith(
        TARGET_URL,
        'W/"v1"',
        'Wed, 21 Oct 2026 07:28:00 GMT',
        expect.any(String)
      );
      // Extraction still ran.
      expect(mockProductRepo.insertProduct).toHaveBeenCalled();
    });

    test('cached validators within TTL: sends conditional GET', async () => {
      const repo = mkSourceCacheRepo({
        source_url: TARGET_URL,
        etag: 'W/"v1"',
        last_modified: 'Wed, 21 Oct 2026 07:28:00 GMT',
        last_full_fetch_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
      const client = mkClient();
      client.fetchHtmlConditional.mockResolvedValue({
        status: 304,
        html: null,
        etag: 'W/"v1"',
        lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      });

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        sourceCacheRepo: repo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: client,
        config: { targets: [baseTarget], concurrency: 5 },
        logger: mockLogger,
      });

      await m.run();

      expect(client.fetchHtmlConditional).toHaveBeenCalledWith(TARGET_URL, {
        etag: 'W/"v1"',
        lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      });
      // 304 → no extraction, no insert/update.
      expect(mockProductRepo.insertProduct).not.toHaveBeenCalled();
      expect(mockProductRepo.updateProduct).not.toHaveBeenCalled();
      // Validators refreshed (not full-fetch reset).
      expect(repo.refreshValidators).toHaveBeenCalled();
      expect(repo.upsertFullFetch).not.toHaveBeenCalled();
    });

    test('caught lying: TTL-forced full GET sees changed content after a 304 → disables conditional', async () => {
      const recently = new Date(Date.now() - 5 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19);
      const repo = mkSourceCacheRepo({
        source_url: TARGET_URL,
        etag: 'W/"stale"',
        last_modified: null,
        last_full_fetch_at: recently,
        // Hash of an OLD product set (different from the PRODUCT_HTML one).
        content_hash: 'previous-fake-hash',
        had_304_since_last: 1, // a 304 happened since the last full fetch
        conditional_disabled: 0,
      });
      const client = mkClient();
      // Server now returns 200 with the (different) PRODUCT_HTML content.
      client.fetchHtmlConditional.mockResolvedValue({
        status: 200,
        html: PRODUCT_HTML,
        etag: 'W/"new"',
        lastModified: 'new',
      });

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        sourceCacheRepo: repo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: client,
        config: { targets: [baseTarget], concurrency: 5 },
        logger: mockLogger,
      });

      mockProductRepo.countBySource.mockReturnValue(0);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      await m.run();

      // Lie-detection should fire: content_hash differs AND had_304_since_last.
      expect(repo.disableConditional).toHaveBeenCalledWith(TARGET_URL);
      // upsert still runs to record the new hash + reset state.
      expect(repo.upsertFullFetch).toHaveBeenCalled();
    });

    test('honest 304 stream: hash unchanged after TTL-forced GET → conditional stays enabled', async () => {
      // Pre-compute the hash the monitor will see for PRODUCT_HTML's products.
      // PRODUCT_HTML has 3 products: prod-001 (in), prod-002 (out), prod-003 (in).
      const crypto = require('crypto');
      const expectedHash = crypto.createHash('sha256').update(
        ['prod-001|1|', 'prod-002|0|', 'prod-003|1|'].sort().join('\n')
      ).digest('hex');

      const recently = new Date(Date.now() - 5 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19);
      const repo = mkSourceCacheRepo({
        source_url: TARGET_URL,
        etag: 'W/"v1"',
        last_modified: null,
        last_full_fetch_at: recently,
        content_hash: expectedHash, // hash matches what extraction will produce
        had_304_since_last: 1,
        conditional_disabled: 0,
      });
      const client = mkClient();
      client.fetchHtmlConditional.mockResolvedValue({
        status: 200,
        html: PRODUCT_HTML,
        etag: 'W/"v2"',
        lastModified: 'now',
      });

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        sourceCacheRepo: repo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: client,
        config: { targets: [baseTarget], concurrency: 5 },
        logger: mockLogger,
      });

      mockProductRepo.countBySource.mockReturnValue(0);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      await m.run();

      // Server was honest: hash unchanged after the 304s. Conditional stays on.
      expect(repo.disableConditional).not.toHaveBeenCalled();
      expect(repo.upsertFullFetch).toHaveBeenCalled();
    });

    test('conditional_disabled flag: skips conditional path entirely', async () => {
      const repo = mkSourceCacheRepo({
        source_url: TARGET_URL,
        etag: 'W/"abc"',
        last_modified: null,
        last_full_fetch_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        content_hash: 'doesnt-matter',
        had_304_since_last: 0,
        conditional_disabled: 1, // poisoned source — force plain GET
      });
      const client = mkClient();
      client.fetchHtmlConditional.mockResolvedValue({
        status: 200,
        html: PRODUCT_HTML,
        etag: 'W/"newer"',
        lastModified: 'now',
      });

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        sourceCacheRepo: repo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: client,
        config: { targets: [baseTarget], concurrency: 5 },
        logger: mockLogger,
      });

      mockProductRepo.countBySource.mockReturnValue(0);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      await m.run();

      // No conditional headers — plain GET despite stored validators.
      expect(client.fetchHtmlConditional).toHaveBeenCalledWith(TARGET_URL, {});
    });

    test('TTL expired: forces unconditional GET even when validators exist', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19);
      const repo = mkSourceCacheRepo({
        source_url: TARGET_URL,
        etag: 'W/"v1"',
        last_modified: 'old',
        last_full_fetch_at: twoHoursAgo,
      });
      const client = mkClient();
      client.fetchHtmlConditional.mockResolvedValue({
        status: 200,
        html: PRODUCT_HTML,
        etag: 'W/"v2"',
        lastModified: 'now',
      });

      const m = createProductMonitor({
        productRepo: mockProductRepo,
        alertRepo: mockAlertRepo,
        sourceCacheRepo: repo,
        notifiers: { default: mockNotifier },
        errorNotifier: mockErrorNotifier,
        httpClient: client,
        config: { targets: [baseTarget], concurrency: 5 },
        logger: mockLogger,
      });

      mockProductRepo.countBySource.mockReturnValue(0);
      mockProductRepo.getProduct.mockReturnValue(undefined);

      await m.run();

      // TTL expired → empty validators on the request.
      expect(client.fetchHtmlConditional).toHaveBeenCalledWith(TARGET_URL, {});
      // 200 → full upsert resets the TTL (4th arg = content hash).
      expect(repo.upsertFullFetch).toHaveBeenCalledWith(TARGET_URL, 'W/"v2"', 'now', expect.any(String));
    });
  });
});
