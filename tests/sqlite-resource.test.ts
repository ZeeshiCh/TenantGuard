import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { SqliteWire } from '../packages/sqlite/src/resource.js';
import { createSqliteResource } from '../packages/sqlite/src/index.js';
class WorkerFixture extends EventEmitter {
  sent: { id: number; command: string }[] = [];
  terminations = 0;
  postMessage(message: { id: number; command: string }) {
    this.sent.push(message);
  }
  async terminate() {
    this.terminations++;
    return 0;
  }
}
function fixture() {
  const worker = new WorkerFixture();
  return { worker, wire: new SqliteWire(worker as unknown as Worker) };
}
test('SQLite resource accepts existing absolute files only and bounds queue/lock configuration', () => {
  for (const filename of [
    ':memory:',
    'relative.db',
    'file:/tmp/test.db',
    '/missing-tenantguard-database',
  ])
    assert.throws(() => createSqliteResource({ filename }));
});
test('SQLite worker transport correlates replies and ignores unknown messages', async () => {
  const { worker, wire } = fixture();
  const a = wire.request('one'),
    b = wire.request('two');
  worker.emit('message', { id: 100, value: 'ignored' });
  worker.emit('message', { id: worker.sent[1]!.id, value: 2 });
  worker.emit('message', { id: worker.sent[0]!.id, value: 1 });
  assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  await wire.terminate();
});
test('SQLite transport preserves native error state for commit outcome handling', async () => {
  const { worker, wire } = fixture();
  const pending = wire.request('commit');
  worker.emit('message', {
    id: worker.sent[0]!.id,
    error: {
      message: 'busy',
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
      transaction: true,
    },
  });
  await assert.rejects(
    () => pending,
    (e) =>
      e instanceof Error &&
      'transaction' in e &&
      e.transaction === true &&
      'errcode' in e &&
      e.errcode === 5,
  );
  await wire.terminate();
});
test('SQLite worker exits reject all pending operations and block later requests', async () => {
  const { worker, wire } = fixture();
  const a = wire.request('one'),
    b = wire.request('two');
  worker.emit('exit', 1);
  await assert.rejects(() => a, /exited/);
  await assert.rejects(() => b, /exited/);
  await assert.rejects(() => wire.request('three'), /closed/);
});
test('SQLite worker retirement is terminal and idempotent', async () => {
  const { worker, wire } = fixture();
  const pending = wire.request('begin');
  await wire.terminate();
  await wire.terminate();
  await assert.rejects(() => pending, /retired/);
  assert.equal(worker.terminations, 1);
  await assert.rejects(() => wire.request('begin'), /closed/);
});
test('SQLite worker transport errors reject native work without uncaught emitter failures', async () => {
  const { worker, wire } = fixture();
  const pending = wire.request('begin');
  worker.emit('error', new Error('transport lost'));
  await assert.rejects(() => pending, /transport lost/);
  await wire.terminate();
});
