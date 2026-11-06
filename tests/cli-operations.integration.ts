import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { DiagnosticReport } from '../packages/cli/src/report.js';
import { postgresFixture, tenantA, tenantB } from './helpers/postgres.js';
import {
  sqlServerFixture,
  sqlTenantA,
  sqlTenantB,
} from './helpers/sqlserver.js';
import {
  mysqlFamilyFixture,
  familyTenantA,
  familyTenantB,
} from './helpers/mysql-family.js';
import {
  mongodbFixture,
  mongoTenantA,
  mongoTenantB,
} from './helpers/mongodb.js';
import {
  sqliteFixture,
  sqliteTenantA,
  sqliteTenantB,
} from './helpers/sqlite.js';
const exec = promisify(execFile),
  entry = resolve('packages/cli/src/index.ts');
async function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<DiagnosticReport> {
  let code = 0,
    stdout = '',
    stderr = '';
  try {
    ({ stdout, stderr } = await exec(
      process.execPath,
      ['--import', 'tsx', entry, ...args, '--json'],
      {
        env: { ...process.env, ...env },
        timeout: 45000,
        maxBuffer: 2 * 1024 * 1024,
      },
    ));
  } catch (e) {
    const v = e as { code: number; stdout: string; stderr: string };
    code = v.code;
    stdout = v.stdout;
    stderr = v.stderr;
  }
  for (const value of Object.values(env))
    assert(
      !stdout.includes(value) && !stderr.includes(value),
      'No connection, tenant or fixture values may be emitted',
    );
  const result = JSON.parse(stdout) as DiagnosticReport;
  assert.equal(result.exitCode, code);
  return result;
}
async function config(engine: string, work: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'tg-operations-'));
  try {
    const path = join(dir, 'config.json');
    assert.equal(
      (
        await cli([
          'init',
          '--engine',
          engine,
          '--output',
          path,
          ...(engine === 'mongodb' ? ['--tenant-column', 'tenantId'] : []),
        ])
      ).exitCode,
      0,
    );
    const v = JSON.parse(await readFile(path, 'utf8'));
    if (engine !== 'sqlite')
      v.sources[0].tls = engine === 'sqlserver' ? 'insecure' : 'disabled';
    v.sources[0].timeoutMs = 30000;
    await writeFile(path, JSON.stringify(v));
    await work(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function connection(
  protocol: string,
  c: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  },
) {
  const u = new URL(protocol + '://localhost');
  u.hostname = c.host ?? 'localhost';
  u.port = String(c.port ?? 3306);
  u.username = c.user ?? '';
  u.password = c.password ?? '';
  u.pathname = '/' + c.database;
  return u.href;
}
function probe(path: string, target: string) {
  return [
    'test-isolation',
    '--config',
    path,
    '--source',
    'main',
    '--target',
    target,
    '--tenant-a-env',
    'TA',
    '--tenant-b-env',
    'TB',
    '--row-a-env',
    'RA',
    '--row-b-env',
    'RB',
  ];
}
const fixtures = (a: string, b: string) => ({
  TA: a,
  TB: b,
  RA: 'seed-a',
  RB: 'seed-b',
});
function observed(r: DiagnosticReport) {
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.complete, true);
  assert(r.findings.some((f) => f.code === 'ISOLATION.READ_BOUNDARY_OBSERVED'));
}
test(
  'generated PostgreSQL policies and read probes detect real RLS regressions without writes',
  { timeout: 180000 },
  async (t) => {
    const db = await postgresFixture();
    try {
      await db.admin.query('INSERT INTO orders VALUES($1,$2,$3),($4,$5,$6)', [
        'seed-a',
        tenantA.tenantId,
        'a',
        'seed-b',
        tenantB.tenantId,
        'b',
      ]);
      await config('postgres', async (path) => {
        const env = {
            TG_DATABASE_URL: connection('postgres', db.config),
            ...fixtures(tenantA.tenantId, tenantB.tenantId),
          },
          args = probe(path, 'public.orders');
        await t.test(
          'generated migration batches execute on the real owner connection',
          async () => {
            await db.admin.query(
              'DROP POLICY tenantguard_access ON orders;DROP POLICY tenantguard_boundary ON orders',
            );
            const generated = await cli(['generate-policy', '--config', path]);
            for (const batch of generated.artifact!.batches)
              await db.admin.query(batch);
            observed(await cli(args, env));
          },
        );
        await t.test(
          'missing own fixtures are incomplete rather than a false pass',
          async () => {
            const r = await cli(args, { ...env, RA: 'missing-fixture' });
            assert.equal(r.exitCode, 3);
            assert(
              r.findings.some(
                (f) => f.code === 'ISOLATION.FIXTURE_UNAVAILABLE',
              ),
            );
          },
        );
        await t.test(
          'disabled RLS exposes fixtures and fails both missing-context and foreign-read checks',
          async () => {
            await db.admin.query(
              'ALTER TABLE orders DISABLE ROW LEVEL SECURITY',
            );
            const r = await cli(args, env);
            assert.equal(r.exitCode, 1);
            assert(
              r.findings.some(
                (f) => f.code === 'ISOLATION.CROSS_TENANT_VISIBLE',
              ),
            );
            assert(
              r.findings.some(
                (f) => f.code === 'ISOLATION.MISSING_CONTEXT_VISIBLE',
              ),
            );
          },
        );
        assert.deepEqual(
          (await db.admin.query('SELECT id,value FROM orders ORDER BY id'))
            .rows,
          [
            { id: 'seed-a', value: 'a' },
            { id: 'seed-b', value: 'b' },
          ],
        );
      });
    } finally {
      await db.close();
    }
  },
);
test(
  'generated SQL Server batches and read probes enforce native RLS on real sessions',
  { timeout: 240000 },
  async (t) => {
    const db = await sqlServerFixture();
    try {
      for (const [id, tenant] of [
        ['seed-a', sqlTenantA.tenantId],
        ['seed-b', sqlTenantB.tenantId],
      ] as const)
        await db.admin.query(
          "EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=@tenant;INSERT INTO orders VALUES(@id,CONVERT(uniqueidentifier,@tenant),N'fixture');EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=NULL",
          { id, tenant },
        );
      await config('sqlserver', async (path) => {
        const auth = db.appConfig.authentication!.options as {
          userName: string;
          password: string;
        };
        const env = {
            TG_DATABASE_URL: connection('mssql', {
              host: db.appConfig.server,
              port: db.appConfig.options!.port,
              user: auth.userName,
              password: auth.password,
              database: db.appConfig.options!.database,
            }),
            ...fixtures(sqlTenantA.tenantId, sqlTenantB.tenantId),
          },
          args = probe(path, 'dbo.orders');
        await t.test(
          'generated batch boundaries execute correctly',
          async () => {
            await db.admin.query(
              'DROP SECURITY POLICY tenantguard.dbo_orders_tenant_policy;DROP FUNCTION tenantguard.dbo_orders_tenant_predicate',
            );
            const generated = await cli(['generate-policy', '--config', path]);
            for (const batch of generated.artifact!.batches)
              await db.admin.query(batch);
            observed(await cli(args, env));
          },
        );
        await t.test(
          'disabled policy exposes foreign fixtures and fails closed',
          async () => {
            await db.admin.query(
              'ALTER SECURITY POLICY tenantguard.dbo_orders_tenant_policy WITH(STATE=OFF)',
            );
            const r = await cli(args, env);
            assert.equal(r.exitCode, 1);
            assert(
              r.findings.some(
                (f) => f.code === 'ISOLATION.CROSS_TENANT_VISIBLE',
              ),
            );
          },
        );
        assert.equal(
          (await db.admin.query('SELECT COUNT(*) AS n FROM orders')).rows[0]!.n,
          2,
        );
      });
    } finally {
      await db.close();
    }
  },
);
for (const engine of ['mysql', 'mariadb'] as const)
  test(
    `${engine} read probes use the actual scoped adapter with byte-exact tenant identities`,
    { timeout: 180000 },
    async (t) => {
      const db = await mysqlFamilyFixture(engine);
      try {
        await db.seed();
        await config(engine, async (path) => {
          const env = {
              TG_DATABASE_URL: connection(engine, db.appConfig),
              ...fixtures(familyTenantA.tenantId, familyTenantB.tenantId),
            },
            args = probe(path, 'orders');
          await t.test(
            'own fixtures exist and foreign fixtures stay hidden',
            async () => {
              observed(await cli(args, env));
            },
          );
          await t.test('missing fixture is incomplete', async () => {
            assert.equal(
              (await cli(args, { ...env, RB: 'missing-probe-row-b' })).exitCode,
              3,
            );
          });
        });
      } finally {
        await db.close();
      }
    },
  );
test(
  'MongoDB replica-set probes use scoped transactions and preserve fixture documents',
  { timeout: 180000 },
  async (t) => {
    const db = await mongodbFixture();
    try {
      await db.seed();
      const raw = db.admin.db(db.database).collection('orders');
      const before = await raw.find().sort({ id: 1 }).toArray();
      await config('mongodb', async (path) => {
        const u = new URL(db.uri);
        u.pathname = '/' + db.database;
        const env = {
            TG_DATABASE_URL: u.href,
            ...fixtures(mongoTenantA.tenantId, mongoTenantB.tenantId),
          },
          args = probe(path, 'orders');
        await t.test(
          'scoped reads observe both case-sensitive tenants',
          async () => {
            observed(await cli(args, env));
          },
        );
        await t.test(
          'incorrect fixture ownership cannot produce success',
          async () => {
            assert.equal(
              (await cli(args, { ...env, TA: 'other-tenant' })).exitCode,
              3,
            );
          },
        );
      });
      assert.deepEqual(await raw.find().sort({ id: 1 }).toArray(), before);
    } finally {
      await db.close();
    }
  },
);
test(
  'SQLite probes execute real scoped worker transactions and preserve file bytes',
  { timeout: 120000 },
  async (t) => {
    const db = await sqliteFixture();
    try {
      await db.seed();
      const before = await readFile(db.filename);
      await config('sqlite', async (path) => {
        const env = {
            TG_SQLITE_FILE: db.filename,
            ...fixtures(sqliteTenantA.tenantId, sqliteTenantB.tenantId),
          },
          args = probe(path, 'main.orders');
        await t.test(
          'A/B/A scopes do not leak case-insensitive ownership',
          async () => {
            observed(await cli(args, env));
          },
        );
        await t.test('missing fixtures are incomplete', async () => {
          assert.equal(
            (await cli(args, { ...env, RA: 'missing-probe-row-a' })).exitCode,
            3,
          );
        });
        await t.test(
          'strict warning threshold preserves explicit application-path limits',
          async () => {
            assert.equal(
              (await cli([...args, '--fail-on', 'warning'], env)).exitCode,
              1,
            );
          },
        );
      });
      assert.deepEqual(await readFile(db.filename), before);
    } finally {
      await db.close();
    }
  },
);
