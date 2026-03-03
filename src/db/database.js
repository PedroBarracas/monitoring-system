const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

function createDatabase({ dbPath, logger }) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  logger.info(`Opening database at ${dbPath}`);
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  logger.info('Database migrations complete');

  return db;
}

module.exports = { createDatabase };
