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

  describe('fetchHtmlConditional', () => {
    function mockResponse({ status, body = '', headers = {} } = {}) {
      const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body),
        headers: { get: (name) => headerMap.get(name.toLowerCase()) || null },
      };
    }

    test('sends If-None-Match / If-Modified-Since when validators are supplied', async () => {
      undici.fetch.mockResolvedValue(mockResponse({ status: 304, headers: { etag: 'W/"abc"' } }));

      await client.fetchHtmlConditional('https://example.com', {
        etag: 'W/"abc"',
        lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      });

      const call = undici.fetch.mock.calls[0];
      expect(call[1].headers['If-None-Match']).toBe('W/"abc"');
      expect(call[1].headers['If-Modified-Since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
    });

    test('returns { status: 304, html: null } when server says unchanged', async () => {
      undici.fetch.mockResolvedValue(mockResponse({ status: 304, headers: { etag: 'W/"new"' } }));

      const result = await client.fetchHtmlConditional('https://example.com', { etag: 'W/"old"' });
      expect(result.status).toBe(304);
      expect(result.html).toBeNull();
      expect(result.etag).toBe('W/"new"');
    });

    test('falls back to the sent ETag when 304 omits it', async () => {
      undici.fetch.mockResolvedValue(mockResponse({ status: 304 }));

      const result = await client.fetchHtmlConditional('https://example.com', { etag: 'W/"old"' });
      expect(result.etag).toBe('W/"old"');
    });

    test('returns { status: 200, html, etag, lastModified } on fresh content', async () => {
      undici.fetch.mockResolvedValue(mockResponse({
        status: 200,
        body: '<html>fresh</html>',
        headers: { etag: 'W/"v2"', 'last-modified': 'Thu, 22 Oct 2026 08:00:00 GMT' },
      }));

      const result = await client.fetchHtmlConditional('https://example.com', { etag: 'W/"v1"' });
      expect(result.status).toBe(200);
      expect(result.html).toBe('<html>fresh</html>');
      expect(result.etag).toBe('W/"v2"');
      expect(result.lastModified).toBe('Thu, 22 Oct 2026 08:00:00 GMT');
    });

    test('throws on a non-304 / non-2xx response', async () => {
      undici.fetch.mockResolvedValue(mockResponse({ status: 500 }));
      await expect(client.fetchHtmlConditional('https://example.com', {})).rejects.toThrow('HTTP 500');
    });

    test('works with no validators (acts as a plain GET)', async () => {
      undici.fetch.mockResolvedValue(mockResponse({
        status: 200,
        body: '<html>first</html>',
        headers: { etag: 'W/"v1"' },
      }));

      const result = await client.fetchHtmlConditional('https://example.com');
      expect(result.status).toBe(200);
      expect(result.html).toBe('<html>first</html>');
      // No conditional headers should be sent on a no-validator call.
      const call = undici.fetch.mock.calls[0];
      expect(call[1].headers['If-None-Match']).toBeUndefined();
      expect(call[1].headers['If-Modified-Since']).toBeUndefined();
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
