const fs = require('fs');
const { loadConfig } = require('../../src/config');

// Mock fs so file fallback returns [] in tests
jest.mock('fs');
fs.readFileSync.mockImplementation(() => { throw new Error('no file'); });

describe('loadConfig', () => {
  const telegramEnv = {
    NOTIFICATION_CHANNEL: 'telegram',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_ID: '12345',
    PRODUCT_TARGETS: JSON.stringify([{ url: 'https://example.com', selectors: {} }]),
    CRON_EXPRESSION: '*/15 * * * *',
    DB_PATH: './test.db',
    LOG_LEVEL: 'debug',
  };

  const discordEnv = {
    NOTIFICATION_CHANNEL: 'discord',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
  };

  test('returns correct config with telegram channel', () => {
    const config = loadConfig(telegramEnv);

    expect(config.notificationChannel).toBe('telegram');
    expect(config.telegram.botToken).toBe('test-token');
    expect(config.telegram.chatId).toBe('12345');
    expect(config.products.targets).toHaveLength(1);
    expect(config.schedule.cronExpression).toBe('*/15 * * * *');
    expect(config.db.path).toBe('./test.db');
    expect(config.logLevel).toBe('debug');
  });

  test('returns correct config with discord channel', () => {
    const config = loadConfig(discordEnv);

    expect(config.notificationChannel).toBe('discord');
    expect(config.discord.webhookUrl).toBe('https://discord.com/api/webhooks/123/abc');
  });

  test('defaults to telegram channel when not specified', () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'tok',
      TELEGRAM_CHAT_ID: '1',
    });
    expect(config.notificationChannel).toBe('telegram');
  });

  test('throws on invalid notification channel', () => {
    expect(() =>
      loadConfig({ NOTIFICATION_CHANNEL: 'email' })
    ).toThrow('Invalid NOTIFICATION_CHANNEL "email"');
  });

  test('throws when telegram vars are missing for telegram channel', () => {
    expect(() => loadConfig({ NOTIFICATION_CHANNEL: 'telegram' })).toThrow(
      'Missing required environment variables'
    );
    expect(() =>
      loadConfig({ NOTIFICATION_CHANNEL: 'telegram', TELEGRAM_BOT_TOKEN: 'x' })
    ).toThrow('TELEGRAM_CHAT_ID');
  });

  test('throws when discord webhook URL is missing for discord channel', () => {
    expect(() =>
      loadConfig({ NOTIFICATION_CHANNEL: 'discord' })
    ).toThrow('DISCORD_WEBHOOK_URL');
  });

  test('does not require telegram vars when using discord', () => {
    expect(() => loadConfig(discordEnv)).not.toThrow();
    const config = loadConfig(discordEnv);
    expect(config.telegram.botToken).toBe('');
    expect(config.telegram.chatId).toBe('');
  });

  test('does not require discord vars when using telegram', () => {
    expect(() => loadConfig(telegramEnv)).not.toThrow();
    const config = loadConfig(telegramEnv);
    expect(config.discord.webhookUrl).toBe('');
  });

  test('applies defaults for optional variables', () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'tok',
      TELEGRAM_CHAT_ID: '1',
    });

    expect(config.products.targets).toEqual([]);
    expect(config.schedule.cronExpression).toBe('*/30 * * * *');
    expect(config.db.path).toBe('./data/monitoring.db');
  });

  test('handles invalid JSON in PRODUCT_TARGETS gracefully', () => {
    const config = loadConfig({
      ...telegramEnv,
      PRODUCT_TARGETS: 'not-json',
    });
    expect(config.products.targets).toEqual([]);
  });

  test('config object is frozen', () => {
    const config = loadConfig(telegramEnv);
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('enabled flags default to true', () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'tok',
      TELEGRAM_CHAT_ID: '1',
    });
    expect(config.products.enabled).toBe(true);
  });

  test('enabled flags can be disabled', () => {
    const config = loadConfig({
      ...telegramEnv,
      PRODUCTS_ENABLED: 'false',
    });
    expect(config.products.enabled).toBe(false);
  });

  test('products.concurrency defaults to 15', () => {
    const config = loadConfig(telegramEnv);
    expect(config.products.concurrency).toBe(15);
  });

  test('products.concurrency reads from PRODUCT_CONCURRENCY', () => {
    const config = loadConfig({ ...telegramEnv, PRODUCT_CONCURRENCY: '10' });
    expect(config.products.concurrency).toBe(10);
  });

  test('products.removalThreshold defaults to 3', () => {
    const config = loadConfig(telegramEnv);
    expect(config.products.removalThreshold).toBe(3);
  });

  test('products.removalThreshold reads from PRODUCT_REMOVAL_THRESHOLD', () => {
    const config = loadConfig({ ...telegramEnv, PRODUCT_REMOVAL_THRESHOLD: '5' });
    expect(config.products.removalThreshold).toBe(5);
  });

  test('channel selection is case-insensitive', () => {
    const config = loadConfig({
      NOTIFICATION_CHANNEL: 'DISCORD',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
    });
    expect(config.notificationChannel).toBe('discord');
  });
});
