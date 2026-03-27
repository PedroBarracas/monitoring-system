const {
  createDiscordService,
  parseBodyToFields,
  EVENT_COLORS,
} = require('../../../src/services/discord');

describe('discord service', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  let mockHttpClient;
  let discord;
  let fetchSpy;

  beforeEach(() => {
    mockHttpClient = {
      fetchHtml: jest.fn().mockResolvedValue(undefined),
    };
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(),
    });
    discord = createDiscordService({
      webhookUrl: 'https://discord.com/api/webhooks/123/abc',
      httpClient: mockHttpClient,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function getLastPayload() {
    const call = fetchSpy.mock.calls[0];
    return JSON.parse(call[1].body);
  }

  describe('sendMessage', () => {
    test('sends plain text via webhook', async () => {
      const result = await discord.sendMessage('Hello Discord');
      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/123/abc',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"content":"Hello Discord"'),
        })
      );
    });

    test('truncates text to 2000 characters', async () => {
      const longText = 'x'.repeat(3000);
      await discord.sendMessage(longText);

      const body = getLastPayload();
      expect(body.content.length).toBe(2000);
    });

    test('returns false on error', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));
      const result = await discord.sendMessage('test');
      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('sendAlert', () => {
    test('sends rich embed with correct structure', async () => {
      await discord.sendAlert({
        eventType: 'PRICE_CHANGE',
        title: 'Bitcoin price increased',
        body: 'Old: $50,000\nNew: $55,000\nChange: +10.00%',
      });

      const payload = getLastPayload();
      expect(payload.embeds).toHaveLength(1);

      const embed = payload.embeds[0];
      expect(embed.title).toBe('Bitcoin price increased');
      expect(embed.color).toBe(EVENT_COLORS.PRICE_CHANGE);
      expect(embed.footer.text).toBe('Monitoring System');
      expect(embed.timestamp).toBeDefined();
    });

    test('parses body lines into fields', async () => {
      await discord.sendAlert({
        eventType: 'NEW_PRODUCT',
        title: 'Widget Alpha',
        body: 'URL: https://shop.example.com/widget\nStatus: In Stock',
      });

      const embed = getLastPayload().embeds[0];
      expect(embed.fields).toHaveLength(2);
      expect(embed.fields[0]).toEqual(
        expect.objectContaining({ name: 'URL', value: 'https://shop.example.com/widget' })
      );
      expect(embed.fields[1]).toEqual(
        expect.objectContaining({ name: 'Status', value: 'In Stock', inline: true })
      );
    });

    test('sets embed URL from URL field when valid', async () => {
      await discord.sendAlert({
        eventType: 'NEW_ARTICLE',
        title: 'Breaking News',
        body: 'URL: https://news.example.com/article-1',
      });

      const embed = getLastPayload().embeds[0];
      expect(embed.url).toBe('https://news.example.com/article-1');
    });

    test('does not set embed URL for invalid URLs', async () => {
      await discord.sendAlert({
        eventType: 'PRICE_CHANGE',
        title: 'Test',
        body: 'URL: not-a-url',
      });

      const embed = getLastPayload().embeds[0];
      expect(embed.url).toBeUndefined();
    });

    test('uses correct color per event type', async () => {
      const types = [
        ['CRYPTO_TRACKING', 0x3498db],
        ['PRICE_CHANGE', 0xf39c12],
        ['NEW_PRODUCT', 0xfee75c],
        ['STOCK_CHANGE', 0xe67e22],
        ['NEW_ARTICLE', 0x9b59b6],
      ];

      for (const [eventType, expectedColor] of types) {
        fetchSpy.mockClear();
        await discord.sendAlert({ eventType, title: 'test', body: 'test: value' });
        const embed = getLastPayload().embeds[0];
        expect(embed.color).toBe(expectedColor);
      }
    });

    test('uses default gray color for unknown event types', async () => {
      await discord.sendAlert({
        eventType: 'UNKNOWN_TYPE',
        title: 'test',
        body: 'test: value',
      });

      const embed = getLastPayload().embeds[0];
      expect(embed.color).toBe(0x95a5a6);
    });

    test('truncates title to 256 characters', async () => {
      await discord.sendAlert({
        eventType: 'TEST',
        title: 'A'.repeat(300),
        body: 'body: text',
      });

      const embed = getLastPayload().embeds[0];
      expect(embed.title.length).toBeLessThanOrEqual(256);
    });

    test('returns false on API error', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 500, headers: new Map() });
      const result = await discord.sendAlert({
        eventType: 'TEST',
        title: 'test',
        body: 'body: text',
      });
      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('includes timestamp in ISO format', async () => {
      const before = new Date().toISOString();
      await discord.sendAlert({
        eventType: 'TEST',
        title: 'test',
        body: 'body: text',
      });
      const after = new Date().toISOString();

      const embed = getLastPayload().embeds[0];
      expect(embed.timestamp >= before).toBe(true);
      expect(embed.timestamp <= after).toBe(true);
    });

    test('retries on 429 rate limit and respects retry-after header', async () => {
      const headers = new Map([['retry-after', '0.1']]);
      fetchSpy
        .mockResolvedValueOnce({ ok: false, status: 429, headers })
        .mockResolvedValueOnce({ ok: true, status: 200, headers: new Map() });

      const result = await discord.sendAlert({
        eventType: 'TEST',
        title: 'test',
        body: 'body: text',
      });

      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
    });

    test('returns false after exhausting rate limit retries', async () => {
      const headers = new Map([['retry-after', '0.01']]);
      fetchSpy.mockResolvedValue({ ok: false, status: 429, headers });

      const result = await discord.sendAlert({
        eventType: 'TEST',
        title: 'test',
        body: 'body: text',
      });

      expect(result).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });
  });

  describe('parseBodyToFields', () => {
    test('parses key:value lines into fields', () => {
      const fields = parseBodyToFields('Name: Widget\nPrice: $100\nStatus: In Stock');
      expect(fields).toHaveLength(3);
      expect(fields[0]).toEqual({ name: 'Name', value: 'Widget', inline: true });
      expect(fields[1]).toEqual({ name: 'Price', value: '$100', inline: true });
    });

    test('marks long values as not inline', () => {
      const longValue = 'A'.repeat(50);
      const fields = parseBodyToFields(`Description: ${longValue}`);
      expect(fields[0].inline).toBe(false);
    });

    test('handles lines without colon as description fields', () => {
      const fields = parseBodyToFields('Just a plain line');
      expect(fields).toHaveLength(1);
      expect(fields[0].name).toBe('\u200b');
      expect(fields[0].value).toBe('Just a plain line');
    });

    test('handles empty body', () => {
      const fields = parseBodyToFields('');
      expect(fields).toEqual([]);
    });

    test('handles URLs with colons in value', () => {
      const fields = parseBodyToFields('URL: https://example.com/path');
      expect(fields[0].name).toBe('URL');
      expect(fields[0].value).toBe('https://example.com/path');
    });

    test('skips blank lines', () => {
      const fields = parseBodyToFields('Name: Widget\n\nPrice: $100');
      expect(fields).toHaveLength(2);
    });
  });
});
