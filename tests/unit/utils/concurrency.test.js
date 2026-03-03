const { createLimiter } = require('../../../src/utils/concurrency');

describe('createLimiter', () => {
  test('runs tasks up to concurrency limit in parallel', async () => {
    const limit = createLimiter(2);
    const running = [];
    const maxConcurrent = [];

    function task(id) {
      return limit(() => new Promise((resolve) => {
        running.push(id);
        maxConcurrent.push(running.length);
        setTimeout(() => {
          running.splice(running.indexOf(id), 1);
          resolve(id);
        }, 50);
      }));
    }

    const results = await Promise.all([task('a'), task('b'), task('c'), task('d')]);

    expect(results).toEqual(['a', 'b', 'c', 'd']);
    expect(Math.max(...maxConcurrent)).toBe(2);
  });

  test('returns resolved values', async () => {
    const limit = createLimiter(3);
    const results = await Promise.all([
      limit(() => Promise.resolve(1)),
      limit(() => Promise.resolve(2)),
      limit(() => Promise.resolve(3)),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  test('propagates rejections', async () => {
    const limit = createLimiter(2);
    await expect(
      limit(() => Promise.reject(new Error('fail')))
    ).rejects.toThrow('fail');
  });

  test('continues processing after a rejection', async () => {
    const limit = createLimiter(1);
    const p1 = limit(() => Promise.reject(new Error('fail'))).catch(() => 'caught');
    const p2 = limit(() => Promise.resolve('ok'));
    const results = await Promise.all([p1, p2]);
    expect(results).toEqual(['caught', 'ok']);
  });

  test('handles concurrency of 1 (sequential)', async () => {
    const limit = createLimiter(1);
    const order = [];

    await Promise.all([
      limit(async () => { order.push('a-start'); order.push('a-end'); }),
      limit(async () => { order.push('b-start'); order.push('b-end'); }),
    ]);

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });
});
