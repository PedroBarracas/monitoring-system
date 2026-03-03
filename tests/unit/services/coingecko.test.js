const { createCoinGeckoService } = require('../../../src/services/coingecko');

describe('coingecko service', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  let mockHttpClient;
  let coingecko;

  beforeEach(() => {
    mockHttpClient = { fetchJson: jest.fn() };
    coingecko = createCoinGeckoService({
      httpClient: mockHttpClient,
      apiKey: 'demo-key',
      logger: mockLogger,
    });
  });

  test('fetches prices for given coins', async () => {
    const mockData = {
      bitcoin: { usd: 50000, usd_24h_change: 2.5 },
      ethereum: { usd: 3000, usd_24h_change: -1.2 },
    };
    mockHttpClient.fetchJson.mockResolvedValue(mockData);

    const result = await coingecko.getSimplePrices(['bitcoin', 'ethereum']);

    expect(result).toEqual(mockData);
    expect(mockHttpClient.fetchJson).toHaveBeenCalledWith(
      expect.stringContaining('ids=bitcoin%2Cethereum'),
      expect.objectContaining({
        headers: { 'x-cg-demo-api-key': 'demo-key' },
      })
    );
  });

  test('returns empty object for empty coin list', async () => {
    const result = await coingecko.getSimplePrices([]);
    expect(result).toEqual({});
    expect(mockHttpClient.fetchJson).not.toHaveBeenCalled();
  });

  test('returns null on rate limit (429)', async () => {
    mockHttpClient.fetchJson.mockRejectedValue(new Error('HTTP 429 from api.coingecko.com'));

    const result = await coingecko.getSimplePrices(['bitcoin']);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('rate limited')
    );
  });

  test('re-throws non-rate-limit errors', async () => {
    mockHttpClient.fetchJson.mockRejectedValue(new Error('HTTP 500'));

    await expect(coingecko.getSimplePrices(['bitcoin'])).rejects.toThrow('HTTP 500');
  });

  test('does not send API key header when key is empty', async () => {
    const service = createCoinGeckoService({
      httpClient: mockHttpClient,
      apiKey: '',
      logger: mockLogger,
    });
    mockHttpClient.fetchJson.mockResolvedValue({});

    await service.getSimplePrices(['bitcoin']);

    const headers = mockHttpClient.fetchJson.mock.calls[0][1].headers;
    expect(headers['x-cg-demo-api-key']).toBeUndefined();
  });
});
