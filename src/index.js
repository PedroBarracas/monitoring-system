require('dotenv').config();

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createDatabase } = require('./db/database');
const { createHttpClient } = require('./services/http-client');
const { createTelegramService } = require('./services/telegram');
const { createDiscordService } = require('./services/discord');
// const { createCoinGeckoService } = require('./services/coingecko');
const { createAlertRepository } = require('./db/alert-repository');
// const { createCryptoRepository } = require('./db/crypto-repository');
const { createProductRepository } = require('./db/product-repository');
// const { createNewsRepository } = require('./db/news-repository');
// const { createCryptoMonitor } = require('./monitors/crypto-monitor');
const { createProductMonitor } = require('./monitors/product-monitor');
// const { createNewsMonitor } = require('./monitors/news-monitor');
const { createScheduler } = require('./scheduler');

const config = loadConfig();
const logger = createLogger('main', { level: config.logLevel });

// Initialize infrastructure
const db = createDatabase({
  dbPath: config.db.path,
  logger: createLogger('db', { level: config.logLevel }),
});

const httpClient = createHttpClient({
  logger: createLogger('http', { level: config.logLevel }),
  timeout: 15000,
});

// Store fetches retry through the proxy on blocks; notification traffic
// (Telegram/Discord) stays on the direct client. Falls back to the direct
// client when no proxy is configured.
const productHttpClient = config.products.proxyUrl
  ? createHttpClient({
      logger: createLogger('http-proxy', { level: config.logLevel }),
      timeout: 15000,
      proxyUrl: config.products.proxyUrl,
    })
  : httpClient;

// Initialize notification service based on config
let notifier;
let errorNotifier;
if (config.notificationChannel === 'discord') {
  notifier = createDiscordService({
    webhookUrl: config.discord.webhookUrl,
    httpClient,
    logger: createLogger('discord', { level: config.logLevel }),
  });
  errorNotifier = config.discord.errorWebhookUrl
    ? createDiscordService({
        webhookUrl: config.discord.errorWebhookUrl,
        httpClient,
        logger: createLogger('discord-errors', { level: config.logLevel }),
      })
    : notifier;
  logger.info('Using Discord for notifications');
} else {
  notifier = createTelegramService({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    httpClient,
    logger: createLogger('telegram', { level: config.logLevel }),
  });
  errorNotifier = notifier;
  logger.info('Using Telegram for notifications');
}

// Initialize repositories
const alertRepo = createAlertRepository(db);

// Initialize monitors (only enabled ones)
const monitors = [];

// if (config.crypto.enabled) {
//   const coingecko = createCoinGeckoService({
//     httpClient,
//     apiKey: config.crypto.apiKey,
//     logger: createLogger('coingecko', { level: config.logLevel }),
//   });
//   monitors.push(
//     createCryptoMonitor({
//       cryptoRepo: createCryptoRepository(db),
//       alertRepo,
//       notifier,
//       coingecko,
//       config: config.crypto,
//       logger: createLogger('crypto-monitor', { level: config.logLevel }),
//     })
//   );
//   logger.info('Crypto monitor enabled');
// }

if (config.products.enabled && config.products.targets.length > 0) {
  monitors.push(
    createProductMonitor({
      productRepo: createProductRepository(db),
      alertRepo,
      notifier,
      errorNotifier,
      httpClient: productHttpClient,
      config: config.products,
      logger: createLogger('product-monitor', { level: config.logLevel }),
    })
  );
  logger.info(`Product monitor enabled with ${config.products.targets.length} target(s)`);
}

// if (config.news.enabled && config.news.sources.length > 0) {
//   monitors.push(
//     createNewsMonitor({
//       newsRepo: createNewsRepository(db),
//       alertRepo,
//       notifier,
//       httpClient,
//       config: config.news,
//       logger: createLogger('news-monitor', { level: config.logLevel }),
//     })
//   );
//   logger.info(`News monitor enabled with ${config.news.sources.length} source(s)`);
// }

if (monitors.length === 0) {
  logger.warn('No monitors enabled. Check your configuration.');
}

// Start scheduler
const scheduler = createScheduler({
  monitors,
  cronExpression: config.schedule.cronExpression,
  logger: createLogger('scheduler', { level: config.logLevel }),
});

scheduler.start();
logger.info(`Monitoring system started with ${monitors.length} monitor(s)`);

// Graceful shutdown
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  scheduler.stop();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
