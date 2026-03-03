function createAlertRepository(db) {
  const insertStmt = db.prepare(
    'INSERT INTO alert_log (event_type, details) VALUES (?, ?)'
  );

  return {
    logAlert(eventType, details) {
      insertStmt.run(eventType, JSON.stringify(details));
    },
  };
}

module.exports = { createAlertRepository };
