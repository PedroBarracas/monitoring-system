const { createTestDb } = require('../../helpers/mock-db');
const { createAlertRepository } = require('../../../src/db/alert-repository');

describe('alert-repository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = createTestDb();
    repo = createAlertRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('logAlert inserts a row with serialized details', () => {
    const details = { coinId: 'bitcoin', price: 50000 };
    repo.logAlert('crypto_first_track', details);

    const row = db.prepare('SELECT * FROM alert_log').get();
    expect(row.event_type).toBe('crypto_first_track');
    expect(JSON.parse(row.details)).toEqual(details);
    expect(row.sent_at).toBeDefined();
  });

  test('logAlert inserts multiple rows', () => {
    repo.logAlert('event_a', { a: 1 });
    repo.logAlert('event_b', { b: 2 });

    const rows = db.prepare('SELECT * FROM alert_log').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].event_type).toBe('event_a');
    expect(rows[1].event_type).toBe('event_b');
  });
});
