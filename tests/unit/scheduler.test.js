const { createScheduler } = require('../../src/scheduler');

describe('scheduler', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  function makeScheduler(monitors) {
    return createScheduler({ monitors, cronExpression: '* * * * *', logger: mockLogger });
  }

  test('runOnce runs each monitor', async () => {
    const monitor = { name: 'm1', run: jest.fn().mockResolvedValue({ alertsSent: 0, errors: [] }) };
    await makeScheduler([monitor]).runOnce();
    expect(monitor.run).toHaveBeenCalledTimes(1);
  });

  test('skips a tick while the previous cycle is still running', async () => {
    let release;
    const firstRun = new Promise((resolve) => {
      release = () => resolve({ alertsSent: 0, errors: [] });
    });
    const monitor = {
      name: 'slow',
      run: jest.fn().mockReturnValueOnce(firstRun).mockResolvedValue({ alertsSent: 0, errors: [] }),
    };
    const scheduler = makeScheduler([monitor]);

    const first = scheduler.runOnce(); // starts; monitor.run is now pending
    await scheduler.runOnce(); // should be skipped — first is still running
    expect(monitor.run).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('still running'));

    release();
    await first;

    // once the first cycle finishes, a new run proceeds normally
    await scheduler.runOnce();
    expect(monitor.run).toHaveBeenCalledTimes(2);
  });

  test('a failing monitor still clears the running flag (no permanent stall)', async () => {
    const monitor = { name: 'bad', run: jest.fn().mockRejectedValue(new Error('boom')) };
    const scheduler = makeScheduler([monitor]);

    await scheduler.runOnce();
    await scheduler.runOnce(); // would be skipped forever if `finally` didn't reset the flag

    expect(monitor.run).toHaveBeenCalledTimes(2);
  });
});
