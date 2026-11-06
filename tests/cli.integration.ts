import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DiagnosticReport } from '../packages/cli/src/report.js';
import { tenantPolicySql } from '../packages/postgres/src/index.js';
import { postgresFixture } from './helpers/postgres.js';
import { sqlServerFixture } from './helpers/sqlserver.js';
import { mysqlFamilyFixture } from './helpers/mysql-family.js';
import { mongodbFixture } from './helpers/mongodb.js';
import { sqliteFixture } from './helpers/sqlite.js';
const exec = promisify(execFile),
  entry = resolve('packages/cli/src/index.ts');
const source = (engine: string, extra: Record<string, unknown> = {}) => ({
  name: 'orders',
  engine,
  mode: ['postgres', 'sqlserver'].includes(engine)
    ? 'database-policy'
    : 'application-filter',
  urlEnv: 'TG_TEST_URL',
  tls: 'disabled',
  timeoutMs: 15000,
  targets: [
    {
      table: 'orders',
      tenantColumn: engine === 'mongodb' ? 'tenantId' : 'tenant_id',
    },
  ],
  ...extra,
});
async function configuration(
  sources: unknown[],
  run: (path: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'tenantguard-cli-real-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify({ version: 1, sources }));
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function cli(
  command: string,
  path: string,
  env: Record<string, string>,
  flags: string[] = [],
): Promise<DiagnosticReport> {
  const args = [
    '--import',
    'tsx',
    entry,
    command,
    '--config',
    path,
    '--json',
    ...flags,
  ];
  let code = 0,
    stdout = '',
    stderr = '';
  try {
    const result = await exec(process.execPath, args, {
      env: { ...process.env, ...env },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const value = error as { code?: number; stdout?: string; stderr?: string };
    code = value.code ?? -1;
    stdout = value.stdout ?? '';
    stderr = value.stderr ?? '';
  }
  let report: DiagnosticReport;
  try {
    report = JSON.parse(stdout);
  } catch {
    assert.fail('CLI must produce a complete JSON envelope; stderr=' + stderr);
  }
  assert.equal(code, report!.exitCode);
  for (const value of Object.values(env))
    assert(
      !stdout.includes(value) && !stderr.includes(value),
      'Connection references must not appear in reports/errors',
    );
  assert.equal(
    report!.scope[0]?.source,
    report!.exitCode === 2 ? undefined : 'orders',
  );
  return report!;
}
function url(
  protocol: string,
  config: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  },
) {
  const value = new URL(protocol + '://localhost');
  value.hostname = config.host ?? 'localhost';
  value.port = String(config.port ?? 3306);
  value.username = config.user ?? '';
  value.password = config.password ?? '';
  value.pathname = '/' + (config.database ?? 'tenantguard');
  return value.href;
}
const codes = (report: DiagnosticReport) =>
  report.findings.map((value) => value.code);
test(
  'doctor/audit CLI uses shipped tools and inspects real PostgreSQL read-only',
  { timeout: 120000 },
  async (t) => {
    const db = await postgresFixture();
    try {
      await db.admin.query(
        "INSERT INTO orders VALUES('cli-seed','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','unchanged')",
      );
      const before = (await db.admin.query('SELECT * FROM orders ORDER BY id'))
        .rows;
      await configuration([source('postgres')], async (path) => {
        const env = { TG_TEST_URL: url('postgres', db.config) };
        await t.test(
          'healthy audit preserves data and reuses tenant-audit',
          async () => {
            const report = await cli('audit', path, env);
            assert.equal(report.exitCode, 0, JSON.stringify(report));
            assert.equal(report.complete, true);
            assert(codes(report).includes('TOOL.TENANT_AUDIT'));
            assert(codes(report).includes('PG.CATALOG_OBSERVED'));
            assert.deepEqual(
              (await db.admin.query('SELECT * FROM orders ORDER BY id')).rows,
              before,
            );
          },
        );
        await t.test(
          'connected doctor reuses db-deploy-doctor and offline doctor never connects',
          async () => {
            const report = await cli('doctor', path, env, ['--connect']);
            assert.equal(report.exitCode, 0, JSON.stringify(report));
            assert(codes(report).includes('TOOL.DEPLOY_DOCTOR'));
            const offline = await cli('doctor', path, {
              TG_TEST_URL:
                'postgres://app:MustNeverPrint@127.0.0.1:1/no_database',
            });
            assert.equal(offline.exitCode, 0);
            assert.equal(offline.connected, false);
          },
        );
        await t.test(
          'runtime administrative credentials are reported without exposing them',
          async () => {
            const report = await cli('audit', path, {
              TG_TEST_URL: db.adminConfig.connectionString,
            });
            assert.equal(report.exitCode, 1, JSON.stringify(report));
            assert(codes(report).includes('PG.ROLE_PRIVILEGED'));
          },
        );
        await t.test(
          'published tenant-audit relationship findings retain their original rule IDs and target',
          async () => {
            await db.admin.query(
              'CREATE TABLE customers(id text PRIMARY KEY,tenant_id uuid NOT NULL);GRANT SELECT,INSERT,UPDATE,DELETE ON customers TO app;ALTER TABLE orders ADD COLUMN customer_id text REFERENCES customers(id)',
            );
            await db.admin.query(tenantPolicySql('customers'));
            await configuration(
              [
                source('postgres', {
                  targets: [
                    { table: 'orders', tenantColumn: 'tenant_id' },
                    { table: 'customers', tenantColumn: 'tenant_id' },
                  ],
                }),
              ],
              async (expanded) => {
                const report = await cli('audit', expanded, env);
                assert.equal(report.exitCode, 1, JSON.stringify(report));
                assert(
                  report.findings.some(
                    (f) => f.code === 'TA-104' && f.target === 'public.orders',
                  ),
                );
              },
            );
          },
        );
        await t.test(
          'constant boundary policies and disabled RLS produce stable errors',
          async () => {
            await db.admin.query(
              'ALTER POLICY tenantguard_boundary ON orders USING(true) WITH CHECK(true)',
            );
            const constant = await cli('audit', path, env);
            assert.equal(constant.exitCode, 1, JSON.stringify(constant));
            assert(codes(constant).includes('PG.POLICY_CONSTANT'));
            await db.admin.query(
              'ALTER TABLE orders DISABLE ROW LEVEL SECURITY',
            );
            const disabled = await cli('audit', path, env);
            assert.equal(disabled.exitCode, 1);
            assert(codes(disabled).includes('PG.RLS_REQUIRED'));
          },
        );
      });
    } finally {
      await db.close();
    }
  },
);
test(
  'SQL Server CLI checks native RLS bindings, predicate visibility and unsafe roles',
  { timeout: 180000 },
  async (t) => {
    const db = await sqlServerFixture();
    try {
      const auth = db.appConfig.authentication as {
        options: { userName: string; password: string };
      };
      await configuration(
        [source('sqlserver', { tls: 'insecure', timeoutMs: 20000 })],
        async (path) => {
          const env = {
            TG_TEST_URL: url('sqlserver', {
              host: db.appConfig.server,
              port: db.appConfig.options!.port,
              user: auth.options.userName,
              password: auth.options.password,
              database: 'tenantguard',
            }),
          };
          await t.test(
            'known native policy template is observable with restricted runtime credentials',
            async () => {
              const report = await cli('audit', path, env);
              assert.equal(report.exitCode, 0, JSON.stringify(report));
              assert(codes(report).includes('MSSQL.CATALOG_OBSERVED'));
            },
          );
          await t.test(
            'elevated SQL Server runtime roles are rejected',
            async () => {
              const credentials = db.adminConfig.authentication as {
                options: { userName: string; password: string };
              };
              const report = await cli('audit', path, {
                TG_TEST_URL: url('sqlserver', {
                  host: db.adminConfig.server,
                  port: db.adminConfig.options!.port,
                  user: credentials.options.userName,
                  password: credentials.options.password,
                  database: 'tenantguard',
                }),
              });
              assert.equal(report.exitCode, 1, JSON.stringify(report));
              assert(codes(report).includes('MSSQL.ROLE_PRIVILEGED'));
            },
          );
          await t.test('disabled security policies are errors', async () => {
            await db.admin.query(
              'ALTER SECURITY POLICY [tenantguard].[dbo_orders_tenant_policy] WITH(STATE=OFF)',
            );
            const report = await cli('audit', path, env);
            assert.equal(report.exitCode, 1, JSON.stringify(report));
            assert(codes(report).includes('MSSQL.RLS_BINDING'));
          });
          await t.test(
            'invisible predicate definitions are incomplete, not passed checks',
            async () => {
              await db.admin.query(
                'REVOKE VIEW DEFINITION ON SCHEMA::tenantguard FROM [tenantguard_app]',
              );
              const report = await cli('audit', path, env);
              assert.equal(report.complete, false);
              assert.equal(report.exitCode, 3);
              assert(codes(report).includes('MSSQL.PREDICATE_UNVERIFIED'));
            },
          );
        },
      );
    } finally {
      await db.close();
    }
  },
);
for (const engine of ['mysql', 'mariadb'] as const)
  test(
    `${engine} CLI checks real transactional tables and reuses published coverage`,
    { timeout: 120000 },
    async (t) => {
      const db = await mysqlFamilyFixture(engine);
      try {
        await db.seed();
        const [before] = await db.admin.query(
          'SELECT * FROM orders ORDER BY id',
        );
        await configuration([source(engine)], async (path) => {
          const env = { TG_TEST_URL: url(engine, db.appConfig) };
          await t.test(
            'audit reports application filtering without claiming native isolation',
            async () => {
              const report = await cli('audit', path, env);
              assert.equal(report.exitCode, 0, JSON.stringify(report));
              assert(codes(report).includes('ISOLATION.APPLICATION_FILTER'));
              assert(codes(report).includes('MYSQL.CATALOG_OBSERVED'));
              assert.equal(
                codes(report).includes('TOOL.TENANT_AUDIT'),
                engine === 'mysql',
              );
            },
          );
          await t.test(
            'doctor invokes the shipped multi-database readiness checker',
            async () => {
              const report = await cli('doctor', path, env, ['--connect']);
              assert.equal(report.exitCode, 0, JSON.stringify(report));
              assert(codes(report).includes('TOOL.DEPLOY_DOCTOR'));
              const [after] = await db.admin.query(
                'SELECT * FROM orders ORDER BY id',
              );
              assert.deepEqual(after, before);
            },
          );
          await t.test(
            'direct administrative grants are observed on the connected runtime role',
            async () => {
              await db.admin.query(
                "GRANT CREATE USER ON *.* TO 'tenantguard_app'@'%'",
              );
              const report = await cli('audit', path, env);
              assert.equal(report.exitCode, 1, JSON.stringify(report));
              assert(codes(report).includes('MYSQL.ROLE_PRIVILEGED'));
            },
          );
          await t.test(
            'nontransactional engines fail the configured CRUD requirement',
            async () => {
              await db.admin.query('ALTER TABLE orders ENGINE=MyISAM');
              const report = await cli('audit', path, env);
              assert.equal(report.exitCode, 1, JSON.stringify(report));
              assert(codes(report).includes('MYSQL.TRANSACTIONAL_TABLE'));
            },
          );
        });
      } finally {
        await db.close();
      }
    },
  );
test(
  'MongoDB CLI inspects a real replica set without reading or changing tenant documents',
  { timeout: 120000 },
  async (t) => {
    const db = await mongodbFixture();
    try {
      await db.seed();
      const before = await db.admin
        .db(db.database)
        .collection('orders')
        .find({})
        .toArray();
      const value = new URL(db.uri);
      value.pathname = '/' + db.database;
      await configuration([source('mongodb')], async (path) => {
        const env = { TG_TEST_URL: value.href };
        await t.test(
          'replica set, scalar ownership declarations and binary indexes remain observations',
          async () => {
            const report = await cli('audit', path, env);
            assert.equal(report.exitCode, 0, JSON.stringify(report));
            assert(codes(report).includes('MONGO.CATALOG_OBSERVED'));
            assert.deepEqual(
              await db.admin
                .db(db.database)
                .collection('orders')
                .find({})
                .toArray(),
              before,
            );
          },
        );
        await t.test(
          'MongoDB user-management privileges are reported as errors',
          async () => {
            await db.admin
              .db('admin')
              .command({
                grantRolesToUser: 'tenantguard_app',
                roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }],
              });
            const report = await cli('audit', path, env);
            assert.equal(report.exitCode, 1, JSON.stringify(report));
            assert(codes(report).includes('MONGO.ROLE_PRIVILEGED'));
          },
        );
        await t.test(
          'missing collections fail coverage instead of disappearing from scope',
          async () => {
            await db.admin.db(db.database).collection('orders').drop();
            const report = await cli('audit', path, env);
            assert.equal(report.exitCode, 3);
            assert(codes(report).includes('MONGO.TARGET_UNAVAILABLE'));
          },
        );
      });
    } finally {
      await db.close();
    }
  },
);
test(
  'SQLite CLI opens real files read-only and validates scoped CRUD declarations',
  { timeout: 30000 },
  async (t) => {
    const db = await sqliteFixture();
    try {
      await db.seed();
      const before = await readFile(db.filename);
      const setting = {
        name: 'orders',
        engine: 'sqlite',
        mode: 'application-filter',
        filenameEnv: 'TG_TEST_FILE',
        timeoutMs: 10000,
        targets: [{ table: 'orders', tenantColumn: 'tenant_id' }],
      };
      await configuration([setting], async (path) => {
        const env = { TG_TEST_FILE: db.filename };
        await t.test(
          'audit and shipped doctor preserve file bytes and declared coverage',
          async () => {
            const report = await cli('audit', path, env);
            assert.equal(report.exitCode, 0, JSON.stringify(report));
            assert(codes(report).includes('SQLITE.CATALOG_OBSERVED'));
            const doctor = await cli('doctor', path, env, ['--connect']);
            assert.equal(doctor.exitCode, 0, JSON.stringify(doctor));
            assert(codes(doctor).includes('TOOL.DEPLOY_DOCTOR'));
            assert.deepEqual(await readFile(db.filename), before);
          },
        );
        await t.test('views are rejected as scoped CRUD tables', async () => {
          db.admin.exec(
            'DROP TABLE orders;CREATE VIEW orders AS SELECT 1 AS id,2 AS tenant_id',
          );
          const report = await cli('audit', path, env);
          assert.equal(report.exitCode, 1);
          assert(codes(report).includes('SQLITE.ORDINARY_TABLE'));
        });
      });
    } finally {
      await db.close();
    }
  },
);
test(
  'diagnostic timeout and SIGTERM close owned child connections without credential output',
  { timeout: 30000 },
  async (t) => {
    let connection: (() => void) | undefined;
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.resume();
      socket.on('close', () => sockets.delete(socket));
      connection?.();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert(address && typeof address !== 'string');
    const env = {
      TG_TEST_URL: `postgres://test:NeverPrintThisSecret@127.0.0.1:${address.port}/blocked`,
    };
    try {
      await t.test(
        'whole-source deadlines wait for actual child closure',
        async () => {
          await configuration(
            [source('postgres', { timeoutMs: 700 })],
            async (path) => {
              const report = await cli('audit', path, env);
              assert.equal(report.exitCode, 3);
              assert.equal(report.complete, false);
            },
          );
          const end = performance.now() + 2000;
          while (sockets.size && performance.now() < end) await delay(5);
          assert.equal(sockets.size, 0);
        },
      );
      await t.test(
        'SIGTERM stops admitted child I/O and preserves the signal exit',
        async () => {
          await configuration(
            [source('postgres', { timeoutMs: 10000 })],
            async (path) => {
              let connected!: () => void;
              const ready = new Promise<void>((yes) => {
                connected = yes;
              });
              connection = connected;
              const child = spawn(
                process.execPath,
                ['--import', 'tsx', entry, 'audit', '--config', path, '--json'],
                {
                  env: { ...process.env, ...env },
                  stdio: ['ignore', 'pipe', 'pipe'],
                },
              );
              let output = '';
              child.stdout.on('data', (value) => {
                output += value;
              });
              child.stderr.on('data', (value) => {
                output += value;
              });
              const closed = new Promise<number | null>((resolve) =>
                child.once('close', resolve),
              );
              try {
                await Promise.race([
                  ready,
                  closed.then(() => {
                    throw new Error(
                      'Diagnostic process exited before connection',
                    );
                  }),
                ]);
                child.kill('SIGTERM');
                const code = await closed;
                assert.equal(code, 143);
                assert(!output.includes('NeverPrintThisSecret'));
                assert.equal(output, '');
              } finally {
                connection = undefined;
                child.kill('SIGKILL');
              }
            },
          );
          const end = performance.now() + 2000;
          while (sockets.size && performance.now() < end) await delay(5);
          assert.equal(sockets.size, 0);
        },
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
