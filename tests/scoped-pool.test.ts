import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScopedSqlPool,
  type ScopedSqlWire,
} from '../packages/scoped-sql/src/index.js';
function wire() {
  const listeners = new Set<(error: Error) => void>();
  let destroyed = false;
  return {
    listeners,
    isDestroyed: () => destroyed,
    transport: {
      execute: async () => ({ rows: [], affectedRows: 0 }),
      begin: async () => {},
      commit: async () => {},
      rollback: async () => {},
      reset: async () => {},
      destroy: () => {
        destroyed = true;
      },
      onError: (listener: (error: Error) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } satisfies ScopedSqlWire,
  };
}
test('physical pool reuses only released leases and rejects escaped low-level sessions', async () => {
  const resource = wire();
  let connections = 0;
  const pool = createScopedSqlPool({
    database: 'saas',
    max: 1,
    connect: async () => {
      connections++;
      return resource.transport;
    },
  });
  try {
    const first = await pool.acquire();
    await first.execute('SELECT 1');
    first.release();
    await assert.rejects(() => first.execute('SELECT 1'), /closed/);
    const second = await pool.acquire();
    second.release();
    assert.equal(connections, 1);
  } finally {
    await pool.close();
  }
  assert.ok(resource.isDestroyed());
  assert.equal(resource.listeners.size, 0);
});
test('idle socket errors invalidate resources before another lease can use them', async () => {
  const resources: ReturnType<typeof wire>[] = [];
  const pool = createScopedSqlPool({
    database: 'saas',
    max: 1,
    connect: async () => {
      const resource = wire();
      resources.push(resource);
      return resource.transport;
    },
  });
  try {
    const first = await pool.acquire();
    first.release();
    for (const listener of resources[0]!.listeners)
      listener(new Error('idle socket'));
    const second = await pool.acquire();
    second.release();
    assert.equal(resources.length, 2);
    assert.ok(resources[0]!.isDestroyed());
  } finally {
    await pool.close();
  }
});
test('pool destroys connections that arrive after a creation timeout', async () => {
  let deliver: (value: ScopedSqlWire) => void = () => {};
  const resource = wire();
  const pool = createScopedSqlPool({
    database: 'saas',
    max: 1,
    connectTimeoutMs: 10,
    acquireTimeoutMs: 50,
    connect: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  });
  try {
    await assert.rejects(() => pool.acquire());
    deliver(resource.transport);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(resource.isDestroyed());
  } finally {
    await pool.close();
  }
});
test('pool destroys a new transport if permanent listener setup fails', async () => {
  const resource = wire();
  resource.transport.onError = () => {
    throw new Error('subscribe');
  };
  const pool = createScopedSqlPool({
    database: 'saas',
    max: 1,
    connect: async () => resource.transport,
  });
  try {
    await assert.rejects(() => pool.acquire(), /subscribe/);
    assert.ok(resource.isDestroyed());
  } finally {
    await pool.close();
  }
});
test('explicitly discarded resources are closed before they can be reused', async () => {
  const resources: ReturnType<typeof wire>[] = [];
  const pool = createScopedSqlPool({
    database: 'saas',
    max: 1,
    connect: async () => {
      const resource = wire();
      resources.push(resource);
      return resource.transport;
    },
  });
  try {
    const first = await pool.acquire();
    first.release(true);
    assert.ok(resources[0]!.isDestroyed());
    const second = await pool.acquire();
    second.release();
    assert.equal(resources.length, 2);
  } finally {
    await pool.close();
  }
});
