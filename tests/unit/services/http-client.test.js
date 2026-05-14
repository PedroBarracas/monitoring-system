const undici = require('undici');
const { createHttpClient } = require('../../../src/services/http-client');

describe('http-client', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const realFetch = undici.fetch;
  let client;

  beforeEach(() => {
    client = createHttpClient({ logger: mockLogger, timeout: 5000 });
    // http-client uses undici.fetch (not the global) so its dispatcher/ProxyAgent
    // come from the same undici version — mock it here.
    undici.fetch = jest.fn();
  });

  afterEach(() => {
    undici.fetch = realFetch;
  });

  describe('fetchJson', () => {
    test('returns parsed JSON on success', async () => {
      const data = { bitcoin: { usd: 50000 } };
      undici.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(data),
      });

      const result = await client.fetchJson('https://api.example.com/data');
      expect(result).toEqual(data);
      expect(undici.fetch).toHaveBeenCalledTimes(1);
    });

    test('throws on non-ok response', async () => {
      undici.fetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad request'),
      });

      await expect(client.fetchJson('https://api.example.com/data')).rejects.toThrow('HTTP 400');
    });

    test('retries on network failure', async () => {
      const data = { ok: true };
      undici.fetch
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(data),
        });

      const result = await client.fetchJson('https://api.example.com/data');
      expect(result).toEqual(data);
      expect(undici.fetch).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('fetchHtml', () => {
    test('returns HTML string on success', async () => {
      undici.fetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>Hello</body></html>'),
      });

      const result = await client.fetchHtml('https://example.com');
      expect(result).toContain('<body>Hello</body>');
    });

    test('throws on non-ok response', async () => {
      undici.fetch.mockResolvedValue({
        ok: false,
        status: 503,
      });

      await expect(client.fetchHtml('https://example.com')).rejects.toThrow('HTTP 503');
    });
  });

  describe('proxy fallback', () => {
    test('retries through the proxy on a 429', async () => {
      const proxied = createHttpClient({
        logger: mockLogger,
        timeout: 5000,
        proxyUrl: 'http://localhost:9999',
      });
      undici.fetch
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('<html>ok</html>') });

      const html = await proxied.fetchHtml('https://blocked.example.com');
      expect(html).toContain('ok');
      expect(undici.fetch).toHaveBeenCalledTimes(2);
      // both attempts carry a dispatcher; the retry switches to a different
      // one (the proxy) rather than reusing the direct dispatcher
      const directDispatcher = undici.fetch.mock.calls[0][1].dispatcher;
      const retryDispatcher = undici.fetch.mock.calls[1][1].dispatcher;
      expect(directDispatcher).toBeDefined();
      expect(retryDispatcher).toBeDefined();
      expect(retryDispatcher).not.toBe(directDispatcher);
    });

    test('does not retry a 403 when no proxy is configured', async () => {
      undici.fetch.mockResolvedValue({ ok: false, status: 403 });

      await expect(client.fetchHtml('https://blocked.example.com')).rejects.toThrow('HTTP 403');
      expect(undici.fetch).toHaveBeenCalledTimes(1);
    });

    test('surfaces the block when every proxy retry is still blocked', async () => {
      const proxied = createHttpClient({
        logger: mockLogger,
        timeout: 5000,
        proxyUrl: 'http://localhost:9999',
      });
      undici.fetch.mockResolvedValue({ ok: false, status: 429 });

      await expect(proxied.fetchHtml('https://blocked.example.com')).rejects.toThrow('HTTP 429');
      expect(undici.fetch).toHaveBeenCalledTimes(3); // 1 direct + 2 proxy retries
    }, 10000);
  });
});
