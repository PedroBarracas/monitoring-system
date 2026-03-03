const { createLogger } = require('../../src/logger');

describe('createLogger', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = {
      log: jest.spyOn(console, 'log').mockImplementation(),
      warn: jest.spyOn(console, 'warn').mockImplementation(),
      error: jest.spyOn(console, 'error').mockImplementation(),
    };
  });

  test('info logs with correct format', () => {
    const logger = createLogger('test-component');
    logger.info('hello world');

    expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    const output = consoleSpy.log.mock.calls[0][0];
    expect(output).toMatch(/\[INFO\] \[test-component\] hello world/);
  });

  test('warn logs with correct format', () => {
    const logger = createLogger('test');
    logger.warn('warning message');

    expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
    expect(consoleSpy.warn.mock.calls[0][0]).toMatch(/\[WARN\] \[test\] warning message/);
  });

  test('error logs with correct format', () => {
    const logger = createLogger('test');
    logger.error('error message');

    expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    expect(consoleSpy.error.mock.calls[0][0]).toMatch(/\[ERROR\] \[test\] error message/);
  });

  test('includes data as JSON when provided', () => {
    const logger = createLogger('test');
    logger.info('with data', { key: 'value' });

    const output = consoleSpy.log.mock.calls[0][0];
    expect(output).toContain('{"key":"value"}');
  });

  test('debug is suppressed at info level', () => {
    const logger = createLogger('test', { level: 'info' });
    logger.debug('should not appear');

    expect(consoleSpy.log).not.toHaveBeenCalled();
  });

  test('debug is visible at debug level', () => {
    const logger = createLogger('test', { level: 'debug' });
    logger.debug('should appear');

    expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    expect(consoleSpy.log.mock.calls[0][0]).toMatch(/\[DEBUG\] \[test\] should appear/);
  });

  test('includes ISO timestamp', () => {
    const logger = createLogger('test');
    logger.info('time check');

    const output = consoleSpy.log.mock.calls[0][0];
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
