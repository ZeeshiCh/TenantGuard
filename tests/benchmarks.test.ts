import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, count, measure } from '../benchmarks/stats.js';
test('benchmark summaries use nearest-rank percentiles and reject invalid measurements', () => {
  const input = [5, 1, 3, 2, 4];
  assert.deepEqual(summarize(input), {
    count: 5,
    meanMs: 3,
    p50Ms: 3,
    p95Ms: 5,
    minMs: 1,
    maxMs: 5,
    operationsPerSecond: 1000 / 3,
  });
  assert.deepEqual(input, [5, 1, 3, 2, 4]);
  for (const value of [[], [NaN], [-1], [Infinity]])
    assert.throws(() => summarize(value));
  for (const value of ['0', '-1', '1.5', '10001', 'Infinity', '2junk'])
    assert.throws(() => count(value, 10));
  assert.equal(count(undefined, 10), 10);
});
test('benchmarks exclude warmup samples and await complete operations', async () => {
  let completed = 0;
  const result = await measure(
    'sample',
    async () => {
      await Promise.resolve();
      completed++;
    },
    3,
    2,
  );
  assert.equal(completed, 5);
  assert.equal(result.count, 3);
  assert(result.meanMs >= 0);
});
