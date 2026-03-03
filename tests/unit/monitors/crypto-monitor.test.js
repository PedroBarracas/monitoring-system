const { createCryptoMonitor } = require('../../../src/monitors/crypto-monitor');
const { COINGECKO_RESPONSE } = require('../../helpers/fixtures');

describe('crypto-monitor', () => {
  let mockCryptoRepo;
  let mockAlertRepo;
  let mockNotifier;
  let mockCoingecko;
  let mockLogger;
  let monitor;
  const config = { coins: ['bitcoin', 'ethereum'], thresholdPercent: 5.0 };

  beforeEach(() => {
    mockCryptoRepo = {
      getPrice: jest.fn(),
      upsertPrice: jest.fn(),
    };
    mockAlertRepo = { logAlert: jest.fn() };
    mockNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
    mockCoingecko = { getSimplePrices: jest.fn() };
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    monitor = createCryptoMonitor({
      cryptoRepo: mockCryptoRepo,
      alertRepo: mockAlertRepo,
      notifier: mockNotifier,
      coingecko: mockCoingecko,
      config,
      logger: mockLogger,
    });
  });

  test('has correct name', () => {
    expect(monitor.name).toBe('crypto-monitor');
  });

  test('first run inserts prices and sends tracking alerts', async () => {
    mockCoingecko.getSimplePrices.mockResolvedValue(COINGECKO_RESPONSE);
    mockCryptoRepo.getPrice.mockReturnValue(undefined);

    const result = await monitor.run();

    expect(result.alertsSent).toBe(2);
    expect(result.errors).toEqual([]);
    expect(mockNotifier.sendAlert).toHaveBeenCalledTimes(2);

    // Verify repo calls
    expect(mockCryptoRepo.upsertPrice).toHaveBeenCalledWith('bitcoin', 'bitcoin', 50000);
    expect(mockCryptoRepo.upsertPrice).toHaveBeenCalledWith('ethereum', 'ethereum', 3000);

    // Verify alert log
    expect(mockAlertRepo.logAlert).toHaveBeenCalledTimes(2);
    expect(mockAlertRepo.logAlert).toHaveBeenCalledWith('crypto_first_track', expect.objectContaining({
      coinId: 'bitcoin',
      price: 50000,
    }));
  });

  test('no alerts when price is unchanged', async () => {
    mockCoingecko.getSimplePrices.mockResolvedValue(COINGECKO_RESPONSE);
    mockCryptoRepo.getPrice
      .mockReturnValueOnce({ coin_id: 'bitcoin', symbol: 'bitcoin', price_usd: 50000 })
      .mockReturnValueOnce({ coin_id: 'ethereum', symbol: 'ethereum', price_usd: 3000 });

    const result = await monitor.run();

    expect(result.alertsSent).toBe(0);
    expect(mockNotifier.sendAlert).not.toHaveBeenCalled();
  });

  test('no alert when change is below threshold', async () => {
    // 2% increase (below 5% threshold)
    mockCoingecko.getSimplePrices.mockResolvedValue({
      bitcoin: { usd: 51000, usd_24h_change: 2.0 },
      ethereum: { usd: 3060, usd_24h_change: 2.0 },
    });
    mockCryptoRepo.getPrice
      .mockReturnValueOnce({ coin_id: 'bitcoin', symbol: 'bitcoin', price_usd: 50000 })
      .mockReturnValueOnce({ coin_id: 'ethereum', symbol: 'ethereum', price_usd: 3000 });

    const result = await monitor.run();
    expect(result.alertsSent).toBe(0);
    expect(mockNotifier.sendAlert).not.toHaveBeenCalled();

    // Price should still be updated
    expect(mockCryptoRepo.upsertPrice).toHaveBeenCalledWith('bitcoin', 'bitcoin', 51000);
  });

  test('sends alert when change exceeds threshold', async () => {
    // 10% increase
    mockCoingecko.getSimplePrices.mockResolvedValue({
      bitcoin: { usd: 55000, usd_24h_change: 10.0 },
      ethereum: { usd: 3000, usd_24h_change: 0 },
    });
    mockCryptoRepo.getPrice
      .mockReturnValueOnce({ coin_id: 'bitcoin', symbol: 'bitcoin', price_usd: 50000 })
      .mockReturnValueOnce({ coin_id: 'ethereum', symbol: 'ethereum', price_usd: 3000 });

    const result = await monitor.run();
    expect(result.alertsSent).toBe(1);
    expect(mockNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PRICE_CHANGE',
        title: expect.stringMatching(/bitcoin.*increased/),
      })
    );
  });

  test('detects price decrease correctly', async () => {
    // 10% decrease
    mockCoingecko.getSimplePrices.mockResolvedValue({
      bitcoin: { usd: 45000, usd_24h_change: -10.0 },
      ethereum: { usd: 3000, usd_24h_change: 0 },
    });
    mockCryptoRepo.getPrice
      .mockReturnValueOnce({ coin_id: 'bitcoin', symbol: 'bitcoin', price_usd: 50000 })
      .mockReturnValueOnce({ coin_id: 'ethereum', symbol: 'ethereum', price_usd: 3000 });

    const result = await monitor.run();
    expect(result.alertsSent).toBe(1);
    expect(mockNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('decreased'),
      })
    );
  });

  test('handles rate limiting gracefully', async () => {
    mockCoingecko.getSimplePrices.mockResolvedValue(null);

    const result = await monitor.run();
    expect(result.alertsSent).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mockNotifier.sendAlert).not.toHaveBeenCalled();
  });

  test('handles fetch error gracefully', async () => {
    mockCoingecko.getSimplePrices.mockRejectedValue(new Error('Network error'));

    const result = await monitor.run();
    expect(result.alertsSent).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Network error');
  });

  test('skips coins with missing price data', async () => {
    mockCoingecko.getSimplePrices.mockResolvedValue({
      bitcoin: { usd: 50000 },
      // ethereum is missing
    });
    mockCryptoRepo.getPrice.mockReturnValue(undefined);

    const result = await monitor.run();
    expect(result.alertsSent).toBe(1); // Only bitcoin tracked
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('ethereum'));
  });

  test('mixed changes: one above threshold, one below', async () => {
    mockCoingecko.getSimplePrices.mockResolvedValue({
      bitcoin: { usd: 56000, usd_24h_change: 12.0 }, // 12% change
      ethereum: { usd: 3030, usd_24h_change: 1.0 },  // 1% change
    });
    mockCryptoRepo.getPrice
      .mockReturnValueOnce({ coin_id: 'bitcoin', symbol: 'bitcoin', price_usd: 50000 })
      .mockReturnValueOnce({ coin_id: 'ethereum', symbol: 'ethereum', price_usd: 3000 });

    const result = await monitor.run();
    expect(result.alertsSent).toBe(1);
  });
});
