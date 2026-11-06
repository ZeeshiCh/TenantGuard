import { parseArgs } from 'node:util';
import { arch, platform, cpus } from 'node:os';
import assert from 'node:assert/strict';
import {
  createTenantGuard,
  createTenantRouter,
  type DatabaseAdapter,
} from '../packages/core/src/index.js';
import { createNodeContextCarrier } from '../packages/node/src/index.js';
import { count, measure } from './stats.js';
const p = parseArgs({
  options: {
    engine: { type: 'string' },
    iterations: { type: 'string' },
    warmup: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (p.values.help) {
  console.log(
    'pnpm benchmark --engine core|postgres|sqlite|all --iterations 100 --warmup 10',
  );
} else {
  try {
    const engine = p.values.engine ?? 'core';
    if (!['core', 'postgres', 'sqlite', 'all'].includes(engine))
      throw new TypeError('Unknown engine');
    const iterations = count(p.values.iterations, 100),
      warmup = count(p.values.warmup, 10);
    const results: Awaited<ReturnType<typeof measure>>[] = [];
    const sample = (name: string, work: () => unknown | Promise<unknown>) =>
      measure(name, work, iterations, warmup).then((r) => {
        results.push(r);
      });
    if (engine === 'core' || engine === 'all') {
      const context = { tenantId: 'Org_A' },
        carrier = createNodeContextCarrier();
      let checksum = 0;
      await sample('core.direct-callback', () => {
        checksum++;
      });
      await sample('core.node-context-scope', () =>
        carrier.run(context, () => {
          assert.equal(carrier.get()?.tenantId, 'Org_A');
          checksum++;
        }),
      );
      const guard = createTenantGuard({ authorize: () => context, carrier });
      await sample('core.authorization-and-context', () =>
        guard.run({}, async (c) => {
          assert.equal(c.tenantId, 'Org_A');
          checksum++;
        }),
      );
      const adapter: DatabaseAdapter<{ value: number }> = {
        name: 'memory',
        capabilities: {
          transactions: false,
          isolationModes: ['application-filter'],
        },
        run: async (_c, _r, work) => work({ value: 1 }),
      };
      const router = createTenantRouter({
        sources: { orders: { adapter, mode: 'application-filter' } },
        registry: {
          resolve: async (c) => ({
            tenantId: c.tenantId,
            source: 'orders',
            adapter: 'memory',
            resource: 'memory',
            revision: '1',
            status: 'active',
            mode: 'application-filter',
          }),
        },
      });
      await sample('core.authorized-routed-memory-scope', () =>
        guard.run({}, (c) =>
          router.run(c, 'orders', async (client) => {
            assert.equal(client.value, 1);
            checksum++;
          }),
        ),
      );
      assert.equal(checksum, (iterations + warmup) * 4);
    }
    if (engine === 'postgres' || engine === 'all') {
      const { postgresFixture, tenantA } =
        await import('../tests/helpers/postgres.js');
      const { createPgAdapter } =
        await import('../packages/postgres/src/pg.js');
      const db = await postgresFixture();
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ ...db.config, max: 1 });
      try {
        await db.admin.query('INSERT INTO orders VALUES($1,$2,$3)', [
          'bench-a',
          tenantA.tenantId,
          'sample',
        ]);
        const adapter = createPgAdapter({
          resolvePool: () => pool,
          tables: [{ schema: 'public', table: 'orders' }],
        });
        const sql = 'SELECT id FROM public.orders WHERE id=$1';
        await sample('postgres.manual-transaction-context-read', async () => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            await c.query("SELECT set_config('app.tenant_id',$1,true)", [
              tenantA.tenantId,
            ]);
            const result = await c.query(sql, ['bench-a']);
            assert.equal(result.rows[0]?.id, 'bench-a');
            await c.query('COMMIT');
          } catch (e) {
            await c.query('ROLLBACK');
            throw e;
          } finally {
            c.release();
          }
        });
        await sample('postgres.guarded-native-policy-scope', () =>
          adapter.run(
            tenantA,
            {
              tenantId: tenantA.tenantId,
              source: 'orders',
              adapter: 'pg',
              resource: 'benchmark',
              revision: '1',
              status: 'active',
              mode: 'database-policy',
            },
            async (c) => {
              assert.equal(
                (await c.query(sql, ['bench-a'])).rows[0]?.id,
                'bench-a',
              );
            },
          ),
        );
      } finally {
        await pool.end();
        await db.close();
      }
    }
    if (engine === 'sqlite' || engine === 'all') {
      const { sqliteFixture, sqliteTables, sqliteTenantA } =
        await import('../tests/helpers/sqlite.js');
      const { createSqliteResource, createSqliteAdapter } =
        await import('../packages/sqlite/src/index.js');
      const db = await sqliteFixture();
      const resource = createSqliteResource({ filename: db.filename });
      try {
        await db.seed();
        const query = db.admin.prepare(
          'SELECT id FROM orders WHERE id=? AND tenant_id COLLATE BINARY=?',
        );
        const adapter = createSqliteAdapter({
          resolveResource: () => resource,
          tables: sqliteTables,
        });
        await sample('sqlite.prepared-direct-read', () => {
          assert.equal(
            query.get('seed-a', sqliteTenantA.tenantId)?.id,
            'seed-a',
          );
        });
        await sample('sqlite.guarded-worker-transaction-scope', () =>
          adapter.run(
            sqliteTenantA,
            {
              tenantId: sqliteTenantA.tenantId,
              source: 'orders',
              adapter: 'sqlite',
              resource: 'benchmark',
              revision: '1',
              status: 'active',
              mode: 'application-filter',
            },
            async (c) => {
              assert.equal(
                (await c.table('orders').find({ id: 'seed-a' }))[0]?.id,
                'seed-a',
              );
            },
          ),
        );
      } finally {
        await resource.close();
        await db.close();
      }
    }
    console.log(
      JSON.stringify(
        {
          version: 1,
          runtime: {
            node: process.version,
            platform: platform(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            cpuCount: cpus().length,
          },
          iterations,
          warmup,
          concurrency: 1,
          results,
          limitations: [
            'Serial local measurements include assertions, await and complete scope lifecycle; not isolated query costs or production capacity.',
            'SQLite baseline is a prepared synchronous read; guarded scopes include worker creation, schema verification and transactions. PostgreSQL baseline includes its own transaction/context.',
            'Warmup is excluded; nearest-rank percentiles are descriptive, with no regression thresholds or cross-engine speed claims.',
          ],
        },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      'Benchmark failed; verify arguments and disposable database availability. No performance report was emitted.',
    );
    process.exitCode = 1;
  }
}
