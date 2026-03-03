/**
 * Runs the product monitor once with a no-op notifier to populate the database,
 * then compares DB contents with extraction-diagnostic.json.
 *
 * Usage: node scripts/populate-db.js
 */

const fs = require('fs');
const path = require('path');
const { createDatabase } = require('../src/db/database');
const { createProductRepository } = require('../src/db/product-repository');
const { createAlertRepository } = require('../src/db/alert-repository');
const { createHttpClient } = require('../src/services/http-client');
const { createProductMonitor } = require('../src/monitors/product-monitor');

const TARGETS_PATH = path.join(__dirname, '..', 'data', 'product-targets.json');
const DIAG_PATH = path.join(__dirname, '..', 'data', 'extraction-diagnostic.json');
const DB_PATH = path.join(__dirname, '..', 'data', 'monitoring.db');

const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.log('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: () => {},
};

const noopNotifier = { sendAlert: async () => true };

async function main() {
  const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));

  // 1. Initialize database
  const db = createDatabase({ dbPath: DB_PATH, logger });
  const productRepo = createProductRepository(db);
  const alertRepo = createAlertRepository(db);
  const httpClient = createHttpClient({ logger, timeout: 20000 });

  const config = { targets, concurrency: 5 };

  const monitor = createProductMonitor({
    productRepo,
    alertRepo,
    notifier: noopNotifier,
    httpClient,
    config,
    logger,
  });

  // 2. Run the monitor
  console.log(`\nRunning product monitor for ${targets.length} targets...\n`);
  const result = await monitor.run();
  console.log(`\nMonitor complete: ${result.alertsSent} alerts, ${result.errors.length} errors`);
  if (result.errors.length > 0) {
    for (const err of result.errors) console.log(`  ERROR: ${err}`);
  }

  // 3. Query all products from DB
  const allProducts = db.prepare('SELECT * FROM products ORDER BY source_url, product_id').all();
  console.log(`\nDatabase now has ${allProducts.length} products\n`);

  // Group DB products by source_url
  const dbByUrl = {};
  for (const p of allProducts) {
    if (!dbByUrl[p.source_url]) dbByUrl[p.source_url] = [];
    dbByUrl[p.source_url].push(p);
  }

  // 4. Load diagnostic JSON
  let diag = [];
  try {
    diag = JSON.parse(fs.readFileSync(DIAG_PATH, 'utf8'));
  } catch {
    console.log('No extraction-diagnostic.json found — skipping comparison');
    db.close();
    return;
  }

  // 5. Compare
  console.log('='.repeat(90));
  console.log('COMPARISON: Database vs extraction-diagnostic.json');
  console.log('='.repeat(90));
  console.log(`${'Site'.padEnd(40)} ${'DB'.padStart(5)} ${'Diag'.padStart(5)} ${'Match'.padStart(6)}`);
  console.log('-'.repeat(90));

  let totalDb = 0;
  let totalDiag = 0;
  let mismatches = 0;

  for (const entry of diag) {
    const url = entry.url;
    const dbProducts = dbByUrl[url] || [];
    const diagCount = entry.productCount;
    const dbCount = dbProducts.length;
    totalDb += dbCount;
    totalDiag += diagCount;

    const domain = new URL(url).hostname.replace(/^www\./, '');
    const match = dbCount === diagCount ? 'OK' : 'DIFF';
    if (match === 'DIFF') mismatches++;

    const flag = match === 'DIFF' ? ' <--' : '';
    console.log(`${domain.padEnd(40)} ${String(dbCount).padStart(5)} ${String(diagCount).padStart(5)} ${match.padStart(6)}${flag}`);
  }

  console.log('-'.repeat(90));
  console.log(`${'TOTAL'.padEnd(40)} ${String(totalDb).padStart(5)} ${String(totalDiag).padStart(5)} ${mismatches === 0 ? '  ALL OK' : `  ${mismatches} diffs`}`);
  console.log('='.repeat(90));

  db.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
