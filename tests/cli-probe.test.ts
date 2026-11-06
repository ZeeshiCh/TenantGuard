import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProbe } from '../packages/cli/src/probe-config.js';
import {
  parseDiagnosticConfig,
  resolveDiagnosticSources,
} from '../packages/cli/src/config.js';
const sources = resolveDiagnosticSources(
  parseDiagnosticConfig({
    version: 1,
    sources: [
      {
        name: 'orders',
        engine: 'mysql',
        mode: 'application-filter',
        urlEnv: 'URL',
        targets: [{ table: 'orders', tenantColumn: 'tenant_id' }],
      },
    ],
  }),
  { URL: 'mysql://user:password@localhost/app' },
);
const flags = {
    source: 'orders',
    target: 'orders',
    'tenant-a-env': 'A',
    'tenant-b-env': 'B',
    'row-a-env': 'RA',
    'row-b-env': 'RB',
  },
  env = { A: 'Org_A', B: 'org_a', RA: 'seed-a', RB: 'seed-b' };
test('isolation probes require declared targets and distinct explicit fixture references', () => {
  const p = resolveProbe(sources, flags, env);
  assert.equal(p.probe.tenantA, 'Org_A');
  assert.equal(p.source.targets.length, 1);
  for (const [f, e] of [
    [{ ...flags, target: 'undeclared' }, env],
    [flags, { ...env, RA: 'seed-b' }],
    [flags, { ...env, B: 'Org_A' }],
    [flags, { ...env, A: '' }],
    [flags, { ...env, RB: undefined }],
    [{ ...flags, 'row-a-env': 'not a name' }, env],
  ] as const)
    assert.throws(() => resolveProbe(sources, f, e));
});
test('native isolation probes validate canonical UUID tenants before connecting', () => {
  const pg = resolveDiagnosticSources(
    parseDiagnosticConfig({
      version: 1,
      sources: [
        {
          name: 'orders',
          engine: 'postgres',
          mode: 'database-policy',
          urlEnv: 'URL',
          targets: [{ table: 'orders', tenantColumn: 'tenant_id' }],
        },
      ],
    }),
    { URL: 'postgres://user:password@localhost/app' },
  );
  assert.throws(() =>
    resolveProbe(pg, { ...flags, target: 'public.orders' }, env),
  );
});
