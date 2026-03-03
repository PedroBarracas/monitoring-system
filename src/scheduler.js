const cron = require('node-cron');

function createScheduler({ monitors, cronExpression, logger }) {
  let task = null;

  async function runOnce() {
    logger.info(`Starting monitoring cycle with ${monitors.length} monitor(s)`);

    for (const monitor of monitors) {
      try {
        logger.info(`Running monitor: ${monitor.name}`);
        const result = await monitor.run();
        logger.info(`Monitor ${monitor.name} completed`, {
          alertsSent: result.alertsSent,
          errors: result.errors.length,
        });
      } catch (err) {
        logger.error(`Monitor ${monitor.name} failed`, {
          message: err.message,
          stack: err.stack,
        });
      }
    }

    logger.info('Monitoring cycle complete');
  }

  return {
    start() {
      if (!cron.validate(cronExpression)) {
        throw new Error(`Invalid cron expression: ${cronExpression}`);
      }

      logger.info(`Scheduler starting with expression: ${cronExpression}`);

      // Run immediately on startup — catch to avoid unhandled rejection
      runOnce().catch((err) => {
        logger.error('Initial monitoring cycle failed', { error: err.message });
      });

      // Then schedule periodic runs
      task = cron.schedule(cronExpression, () => {
        runOnce().catch((err) => {
          logger.error('Scheduled monitoring cycle failed', { error: err.message });
        });
      });
    },

    stop() {
      if (task) {
        task.stop();
        task = null;
        logger.info('Scheduler stopped');
      }
    },

    runOnce,
  };
}

module.exports = { createScheduler };
