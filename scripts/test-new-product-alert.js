/**
 * Test script — simulates a "new product" detection by:
 * 1. Running the product monitor for a single small target (populates DB)
 * 2. Deleting one product from the DB
 * 3. Re-running the monitor so it detects the "new" product and sends a Discord notification
 *
 * Usage: node scripts/test-new-product-alert.js
 */

require('dotenv').config();

const path = require('path');
const { createDatabase } = require('../src/db/database');
const { createProductRepository } = require('../src/db/product-repository');
const { createAlertRepository } = require('../src/db/alert-repository');
const { createHttpClient } = require('../src/services/http-client');
const { createDiscordService } = require('../src/services/discord');
const { createProductMonitor } = require('../src/monitors/product-monitor');
const { createLogger } = require('../src/logger');

const TARGET = {
  url: 'https://cardtreasure.ch/collections/one-piece-preorders',
};

const DB_PATH = path.join(__dirname, '..', 'data', 'test-alert.db');

async function main() {
  const logger = createLogger({ level: 'info' });
  const httpClient = createHttpClient({ logger });

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('DISCORD_WEBHOOK_URL not set in .env');
    process.exit(1);
  }

  const discord = createDiscordService({ webhookUrl, httpClient, logger });
  const db = createDatabase({ dbPath: DB_PATH, logger });
  const productRepo = createProductRepository(db);
  const alertRepo = createAlertRepository(db);

  const monitorConfig = { targets: [TARGET], concurrency: 1 };

  // Wrap notifier to suppress alerts during first run (seeding)
  let suppressAlerts = true;
  const silentNotifier = {
    sendAlert: async () => (suppressAlerts ? true : discord.sendAlert(...arguments)),
  };

  // --- STEP 1: Seed the DB (suppress notifications) ---
  console.log('\n=== STEP 1: Seeding DB (notifications suppressed) ===\n');

  const seedMonitor = createProductMonitor({
    productRepo, alertRepo, notifier: { sendAlert: async () => true }, httpClient, config: monitorConfig, logger,
  });
  const seedResult = await seedMonitor.run();
  const count = productRepo.countBySource(TARGET.url);
  console.log(`\nSeeded ${count} products (${seedResult.alertsSent} alerts suppressed)\n`);

  if (count === 0) {
    console.error('No products found — cannot test. Exiting.');
    db.close();
    process.exit(1);
  }

  // --- STEP 2: Delete one product from DB ---
  const victim = db.prepare('SELECT * FROM products WHERE source_url = ? LIMIT 1').get(TARGET.url);
  console.log(`=== STEP 2: Deleting "${victim.title}" (${victim.product_id}) from DB ===\n`);
  db.prepare('DELETE FROM products WHERE source_url = ? AND product_id = ?').run(TARGET.url, victim.product_id);
  console.log(`DB now has ${productRepo.countBySource(TARGET.url)} products\n`);

  // --- STEP 3: Re-run monitor with real Discord notifications ---
  console.log('=== STEP 3: Re-running monitor (Discord notification enabled) ===\n');

  const liveMonitor = createProductMonitor({
    productRepo, alertRepo, notifier: discord, httpClient, config: monitorConfig, logger,
  });
  const liveResult = await liveMonitor.run();

  console.log(`\nAlerts sent: ${liveResult.alertsSent}`);
  if (liveResult.errors.length > 0) {
    console.log('Errors:', liveResult.errors);
  }

  console.log('\nDone! Check your Discord channel.\n');

  // Cleanup test DB
  db.close();
  const fs = require('fs');
  fs.unlinkSync(DB_PATH);
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
  console.log('Test DB cleaned up.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
