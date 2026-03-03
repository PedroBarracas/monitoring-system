const Database = require('better-sqlite3');
const { runMigrations } = require('../../src/db/migrations');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

module.exports = { createTestDb };
