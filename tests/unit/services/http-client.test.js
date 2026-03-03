const { createHttpClient } = require('../../../src/services/http-client');

describe('http-client', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  let client;

  beforeEach(() => {
    client = createHttpClient({ logger: mockLogger, timeout: 5000 });
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  describe('fetchJson', () => {
    test('returns parsed JSON on success', async () => {
      const data = { bitcoin: { usd: 50000 } };
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(data),
      });

      const result = await client.fetchJson('https://api.example.com/data');
      expect(result).toEqual(data);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('throws on non-ok response', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad request'),
      });

      await expect(client.fetchJson('https://api.example.com/data')).rejects.toThrow('HTTP 400');
    });

    test('retries on network failure', async () => {
      const data = { ok: true };
      global.fetch
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(data),
        });

      const result = await client.fetchJson('https://api.example.com/data');
      expect(result).toEqual(data);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('fetchHtml', () => {
    test('returns HTML string on success', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>Hello</body></html>'),
      });

      const result = await client.fetchHtml('https://example.com');
      expect(result).toContain('<body>Hello</body>');
    });

    test('throws on non-ok response', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 503,
      });

      await expect(client.fetchHtml('https://example.com')).rejects.toThrow('HTTP 503');
    });
  });
});
