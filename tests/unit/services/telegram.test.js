const { createTelegramService, escapeHtml } = require('../../../src/services/telegram');

describe('telegram service', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  let mockHttpClient;
  let telegram;

  beforeEach(() => {
    mockHttpClient = {
      fetchJson: jest.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    };
    telegram = createTelegramService({
      botToken: 'test-token',
      chatId: '12345',
      httpClient: mockHttpClient,
      logger: mockLogger,
    });
  });

  describe('sendMessage', () => {
    test('sends message successfully', async () => {
      const result = await telegram.sendMessage('Hello');
      expect(result).toBe(true);
      expect(mockHttpClient.fetchJson).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-token/sendMessage',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"text":"Hello"'),
        })
      );
    });

    test('returns false on API error', async () => {
      mockHttpClient.fetchJson.mockRejectedValue(new Error('HTTP 400'));
      const result = await telegram.sendMessage('Hello');
      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('truncates messages exceeding 4096 characters and drops parse mode', async () => {
      const longMessage = '<b>' + 'x'.repeat(5000) + '</b>';
      await telegram.sendMessage(longMessage);

      const body = JSON.parse(mockHttpClient.fetchJson.mock.calls[0][1].body);
      expect(body.text.length).toBeLessThanOrEqual(4096);
      expect(body.text.endsWith('...')).toBe(true);
      // HTML parse mode is dropped to avoid broken tags after truncation
      expect(body.parse_mode).toBeUndefined();
      // HTML tags should be stripped
      expect(body.text).not.toContain('<b>');
    });

    test('uses HTML parse mode by default', async () => {
      await telegram.sendMessage('test');
      const body = JSON.parse(mockHttpClient.fetchJson.mock.calls[0][1].body);
      expect(body.parse_mode).toBe('HTML');
    });
  });

  describe('sendAlert', () => {
    test('formats alert message correctly', async () => {
      await telegram.sendAlert({
        eventType: 'PRICE_CHANGE',
        title: 'Bitcoin Price Alert',
        body: 'Price changed from $50,000 to $55,000',
      });

      const body = JSON.parse(mockHttpClient.fetchJson.mock.calls[0][1].body);
      expect(body.text).toContain('[PRICE_CHANGE]');
      expect(body.text).toContain('Bitcoin Price Alert');
      expect(body.text).toContain('Price changed from $50,000 to $55,000');
    });

    test('escapes HTML in alert content', async () => {
      await telegram.sendAlert({
        eventType: 'TEST',
        title: '<script>alert("xss")</script>',
        body: 'Normal body',
      });

      const body = JSON.parse(mockHttpClient.fetchJson.mock.calls[0][1].body);
      expect(body.text).not.toContain('<script>');
      expect(body.text).toContain('&lt;script&gt;');
    });
  });

  describe('escapeHtml', () => {
    test('escapes special characters', () => {
      expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    });
  });
});
