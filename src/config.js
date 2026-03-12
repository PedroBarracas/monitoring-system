// dotenv is loaded by the entry point (index.js), not here,
// to avoid side effects on module import during testing.

const fs = require('fs');
const path = require('path');

const VALID_CHANNELS = ['telegram', 'discord'];
const TARGETS_PATH = path.join(__dirname, '..', 'data', 'product-targets.json');

function loadConfig(env = process.env) {
  const channel = (env.NOTIFICATION_CHANNEL || 'telegram').toLowerCase();
  if (!VALID_CHANNELS.includes(channel)) {
    throw new Error(
      `Invalid NOTIFICATION_CHANNEL "${channel}". Must be one of: ${VALID_CHANNELS.join(', ')}`
    );
  }

  // Validate channel-specific required vars
  if (channel === 'telegram') {
    requireVars(env, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  } else if (channel === 'discord') {
    requireVars(env, ['DISCORD_WEBHOOK_URL']);
  }

  return Object.freeze({
    notificationChannel: channel,
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || '',
      chatId: env.TELEGRAM_CHAT_ID || '',
    },
    discord: {
      webhookUrl: env.DISCORD_WEBHOOK_URL || '',
      errorWebhookUrl: env.DISCORD_ERROR_WEBHOOK_URL || '',
    },
    // crypto: {
    //   enabled: env.CRYPTO_ENABLED !== 'false',
    //   coins: (env.CRYPTO_COINS || 'bitcoin').split(',').map((s) => s.trim()),
    //   thresholdPercent: parseFloat(env.CRYPTO_THRESHOLD_PERCENT) || 5.0,
    //   apiKey: env.COINGECKO_API_KEY || '',
    // },
    products: {
      enabled: env.PRODUCTS_ENABLED !== 'false',
      targets: parseJsonArray(env.PRODUCT_TARGETS) || loadTargetsFile(),
      concurrency: parseInt(env.PRODUCT_CONCURRENCY, 10) || 5,
    },
    // news: {
    //   enabled: env.NEWS_ENABLED !== 'false',
    //   sources: parseJsonArray(env.NEWS_SOURCES, []),
    // },
    schedule: {
      cronExpression: env.CRON_EXPRESSION || '*/30 * * * *',
    },
    db: {
      path: env.DB_PATH || './data/monitoring.db',
    },
    logLevel: env.LOG_LEVEL || 'info',
  });
}

function requireVars(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function parseJsonArray(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadTargetsFile() {
  try {
    const raw = fs.readFileSync(TARGETS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = { loadConfig };
