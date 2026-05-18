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

    test('falls back to listing status on detail fetch error', async () => {
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
      expect(insertCalls[0][0].inStock).toBe(1); // kept listing status
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
});
