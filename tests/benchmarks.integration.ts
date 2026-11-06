import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test(
  'benchmark executable measures core and real PostgreSQL/SQLite scopes with bounded samples',
  { timeout: 180000 },
  async () => {
    const { stdout } = await exec(
      process.execPath,
      [
        '--import',
        'tsx',
        'benchmarks/run.ts',
        '--engine',
        'all',
        '--iterations',
        '3',
        '--warmup',
        '1',
      ],
      { timeout: 170000, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.version, 1);
    assert.equal(report.iterations, 3);
    assert.equal(report.warmup, 1);
    assert.equal(report.results.length, 8);
    assert.equal(report.concurrency, 1);
    for (const r of report.results) {
      assert.equal(r.count, 3);
      for (const key of [
        'meanMs',
        'minMs',
        'maxMs',
        'p50Ms',
        'p95Ms',
        'operationsPerSecond',
      ])
        assert(Number.isFinite(r[key]) && r[key] >= 0);
      assert(r.minMs <= r.p50Ms && r.p50Ms <= r.p95Ms && r.p95Ms <= r.maxMs);
    }
    assert(
      report.results.some(
        (r: { name: string }) =>
          r.name === 'postgres.guarded-native-policy-scope',
      ),
    );
    assert(
      report.results.some(
        (r: { name: string }) =>
          r.name === 'sqlite.guarded-worker-transaction-scope',
      ),
    );
    assert(report.limitations.length > 0);
  },
);
