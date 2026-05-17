// dotenv is loaded by the entry point (index.js), not here,
// to avoid side effects on module import during testing.

const fs = require('fs');
const path = require('path');

const VALID_CHANNELS = ['telegram', 'discord'];
const TARGETS_PATH = path.join(__dirname, '..', 'data', 'product-targets.json');

// Approximate EUR conversion rates (1 unit of CURRENCY = N EUR). Floating rates
// drift over time — override any of them via the CURRENCY_RATES_EUR env var.
const DEFAULT_EUR_RATES = {
  EUR: 1,
  GBP: 1.17,
  USD: 0.92,
  CHF: 1.06,
  PLN: 0.23,
  CZK: 0.040,
  HUF: 0.0025,
  RON: 0.20,
  BGN: 0.5113, // pegged to EUR
  DKK: 0.134, // pegged to EUR
  SEK: 0.088,
  NOK: 0.086,
  ISK: 0.0066,
  CAD: 0.67,
  AUD: 0.60,
  JPY: 0.0060,
};

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
      // Optional per-category webhooks. Product alerts for that category go to
      // the dedicated channel; everything else (and any category without a
      // dedicated webhook) falls back to DISCORD_WEBHOOK_URL.
      webhookUrlPokemon: env.DISCORD_WEBHOOK_URL_POKEMON || '',
      webhookUrlOnePiece: env.DISCORD_WEBHOOK_URL_ONE_PIECE || '',
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
      concurrency: parseInt(env.PRODUCT_CONCURRENCY, 10) || 15,
      // Consecutive cycles a product must be absent before it's marked removed.
      // Absorbs flaky scrapes (esp. JS-rendered targets) so they don't churn
      // products in/out of the DB and fire spurious "back in stock" alerts.
      removalThreshold: parseInt(env.PRODUCT_REMOVAL_THRESHOLD, 10) || 3,
      // Static currency→EUR rate table for the price line in notifications.
      // CURRENCY_RATES_EUR (JSON object) overrides individual default rates.
      eurRates: { ...DEFAULT_EUR_RATES, ...parseJsonObject(env.CURRENCY_RATES_EUR) },
      // Optional proxy. Store fetches that hit 403/429/503 (or a network error)
      // are retried through it; leave PROXY_URL unset to disable.
      proxyUrl: env.PROXY_URL || '',
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

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
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
