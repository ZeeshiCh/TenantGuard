import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDiagnosticConfig,
  resolveDiagnosticSources,
  ConfigError,
} from '../packages/cli/src/config.js';
import { diagnose, main } from '../packages/cli/src/api.js';
import { makeReport, renderReport } from '../packages/cli/src/report.js';
import { policyTemplate } from '../packages/cli/src/postgres.js';
import { sqlServerTemplate } from '../packages/cli/src/sqlserver.js';
const source = {
  name: 'orders',
  engine: 'postgres',
  mode: 'database-policy',
  urlEnv: 'TG_URL',
  tls: 'disabled',
  targets: [{ table: 'orders', tenantColumn: 'tenant_id' }],
};
const config = () => ({ version: 1, sources: [structuredClone(source)] });
async function file(value: unknown, work: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'tenantguard-cli-unit-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    await work(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test('doctor validates offline and reports explicit engine/mode scope without credentials', async () => {
  await file(config(), async (path) => {
    const report = await diagnose(['doctor', '--config', path, '--json'], {
      TG_URL: 'postgres://alice:NeverPrintThis@127.0.0.1:1/db',
    });
    assert(!('help' in report));
    assert.equal(report.connected, false);
    assert.equal(report.exitCode, 0);
    assert.equal(report.scope[0]!.engine, 'postgres');
    assert.equal(report.scope[0]!.mode, 'database-policy');
    assert.equal(JSON.stringify(report).includes('NeverPrintThis'), false);
    assert(Object.isFrozen(report.findings));
  });
});
test('configuration snapshots caller-owned arrays and normalizes scope', () => {
  const input = config(),
    value = parseDiagnosticConfig(input);
  input.sources[0]!.targets[0]!.table = 'mutated';
  assert.equal(value.sources[0]!.targets[0]!.table, 'orders');
  assert.equal(value.sources[0]!.targets[0]!.schema, 'public');
  assert(Object.isFrozen(value.sources[0]!.targets));
});
test('unknown fields, native-mode overclaims and strict application-filter configs are rejected', () => {
  for (const value of [
    { ...config(), password: 'secret' },
    { version: 2, sources: [source] },
    { version: 1, sources: [{ ...source, extra: 'hidden' }] },
    { version: 1, sources: [{ ...source, mode: 'database-per-tenant' }] },
    {
      version: 1,
      strict: true,
      sources: [{ ...source, engine: 'mysql', mode: 'application-filter' }],
    },
  ])
    assert.throws(() => parseDiagnosticConfig(value), ConfigError);
});
test('source, target, identifier, path and timeout bounds fail before inspection', () => {
  for (const patch of [
    { name: 'bad\nsource' },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { timeoutMs: 60001 },
    { urlEnv: 'BAD=ENV' },
    { targets: [] },
    {
      targets: [
        { table: 'orders; DROP TABLE orders', tenantColumn: 'tenant_id' },
      ],
    },
    { targets: [{ table: 'orders', tenantColumn: 'id', idColumn: 'id' }] },
  ])
    assert.throws(
      () =>
        parseDiagnosticConfig({
          version: 1,
          sources: [{ ...source, ...patch }],
        }),
      ConfigError,
    );
  assert.throws(
    () => parseDiagnosticConfig({ version: 1, sources: [source, source] }),
    ConfigError,
  );
  assert.throws(
    () =>
      parseDiagnosticConfig({
        version: 1,
        sources: [
          { ...source, targets: [source.targets[0], source.targets[0]] },
        ],
      }),
    ConfigError,
  );
});
test('URL configuration cannot smuggle startup SQL, TLS bypass or implicit Mongo databases', () => {
  const parsed = parseDiagnosticConfig(config());
  for (const url of [
    'postgres://a:b@host/db?options=-crole=owner',
    'postgres://a:b@host/db?sslmode=no-verify',
    'mysql://a:b@host/db',
    'postgres://a:%0A@host/db',
    'postgres://a:b@host/db#fragment',
  ])
    assert.throws(
      () => resolveDiagnosticSources(parsed, { TG_URL: url }),
      ConfigError,
    );
  const mongo = parseDiagnosticConfig({
    version: 1,
    sources: [{ ...source, engine: 'mongodb', mode: 'application-filter' }],
  });
  assert.throws(
    () => resolveDiagnosticSources(mongo, { TG_URL: 'mongodb://a:b@host/' }),
    ConfigError,
  );
});
test('SQLite requires an absolute existing-path reference and no server URL/TLS declaration', () => {
  const parsed = parseDiagnosticConfig({
    version: 1,
    sources: [
      {
        name: 'files',
        engine: 'sqlite',
        mode: 'application-filter',
        filenameEnv: 'TG_FILE',
        targets: source.targets,
      },
    ],
  });
  for (const value of [':memory:', 'relative.db', 'file:/tmp/a'])
    assert.throws(
      () => resolveDiagnosticSources(parsed, { TG_FILE: value }),
      ConfigError,
    );
  assert.throws(
    () =>
      parseDiagnosticConfig({
        version: 1,
        sources: [{ ...source, engine: 'sqlite', mode: 'application-filter' }],
      }),
    ConfigError,
  );
});
test('invalid JSON, oversized config and missing files produce static config reports', async () => {
  for (const value of ['{not json', 'x'.repeat(1024 * 1024 + 1)])
    await file(value, async (path) => {
      const result = await diagnose(['audit', '--config', path, '--json']);
      assert(!('help' in result));
      assert.equal(result.exitCode, 2);
      assert.equal(result.complete, false);
    });
  const missing = await diagnose([
    'audit',
    '--config',
    '/not-a-real-tenantguard-file',
  ]);
  assert(!('help' in missing));
  assert.equal(missing.exitCode, 2);
});
test('all environment references are validated before any source starts', async () => {
  await file(
    {
      version: 1,
      sources: [source, { ...source, name: 'second', urlEnv: 'MISSING' }],
    },
    async (path) => {
      const result = await diagnose(['audit', '--config', path], {
        TG_URL: 'postgres://x:Secret@127.0.0.1:1/db',
      });
      assert(!('help' in result));
      assert.equal(result.exitCode, 2);
      assert.equal(result.connected, false);
      assert.equal(result.findings.length, 1);
      assert(!JSON.stringify(result).includes('Secret'));
    },
  );
});
test('arguments and duplicate config flags cannot reveal supplied secrets', async () => {
  for (const args of [
    ['audit', '--db', 'postgres://a:Secret@host/db', '--json'],
    ['unknown', '--json'],
    ['audit', '--config', 'x', '--config', 'y', '--json'],
    ['audit', '--config', 'x', '--connect', '--json'],
  ]) {
    let output = '';
    const code = await main(args, {
      write: (text) => {
        output += text;
      },
    });
    assert.equal(code, 2);
    assert(!output.includes('Secret'));
    assert.equal(JSON.parse(output).exitCode, 2);
  }
});
test('help is side-effect-free and public imports never run the CLI', async () => {
  let output = '';
  assert.equal(
    await main(['--help'], {
      write: (text) => {
        output += text;
      },
    }),
    0,
  );
  assert(output.includes('doctor'));
  assert(output.includes('audit'));
  const imported = await import('../packages/cli/src/index.js');
  assert.equal(typeof imported.main, 'function');
});
test('report ordering, scope, confidence wording and threshold/operational exits are stable', () => {
  const findings = [
    {
      code: 'Z.TEST',
      source: 'z',
      severity: 'warning' as const,
      message: 'review',
    },
    {
      code: 'A.TEST',
      source: 'a',
      severity: 'info' as const,
      message: 'observed',
    },
  ];
  assert.equal(makeReport('audit', true, findings).exitCode, 0);
  assert.equal(
    makeReport('audit', true, findings, { failOn: 'warning' }).exitCode,
    1,
  );
  assert.equal(
    makeReport('audit', true, findings, { incomplete: true }).exitCode,
    3,
  );
  assert.equal(
    makeReport('audit', false, findings, { invalid: true }).exitCode,
    2,
  );
  const report = makeReport('audit', true, findings);
  assert.equal(report.findings[0]!.code, 'A.TEST');
  assert(renderReport(report).includes('no-errors-observed'));
  assert(!renderReport(report).includes('isolation certified'));
});
test('policy recognizers refuse constant, extra-OR and literal context-key changes', () => {
  const expression =
    "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";
  assert(policyTemplate(expression, 'tenant_id'));
  assert(!policyTemplate('true', 'tenant_id'));
  assert(!policyTemplate(expression + ' OR true', 'tenant_id'));
  assert(
    !policyTemplate(
      expression.replace('app.tenant_id', 'app. tenant_id'),
      'tenant_id',
    ),
  );
  assert(
    !policyTemplate(expression.replace('tenant_id =', 'other ='), 'tenant_id'),
  );
  assert(
    sqlServerTemplate(
      'ALTER FUNCTION f AS RETURN SELECT 1',
      'CREATE FUNCTION f AS RETURN SELECT 1',
    ),
  );
  assert(
    !sqlServerTemplate(
      "CREATE FUNCTION f AS RETURN SELECT 'tenant'",
      "CREATE FUNCTION f AS RETURN SELECT 'Tenant'",
    ),
  );
});
