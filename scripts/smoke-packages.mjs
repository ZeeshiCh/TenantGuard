import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve('.');
const temporary = mkdtempSync(join(tmpdir(), 'tenantguard-consumer-'));
try {
  for (const name of ['core', 'node', 'fetch']) {
    execFileSync('pnpm', ['pack', '--pack-destination', temporary], {
      cwd: join(root, 'packages', name),
      stdio: 'pipe',
    });
  }
  writeFileSync(
    join(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  const packages = readdirSync(temporary)
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => join(temporary, file));
  execFileSync(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(temporary, 'cache'),
      ...packages,
    ],
    { cwd: temporary, stdio: 'pipe' },
  );
  writeFileSync(
    join(temporary, 'consumer.mjs'),
    `
    import assert from 'node:assert/strict';
    import { createTenantGuard } from '@tenantguard/core';
    import { nodeContext, requireTenant } from '@tenantguard/node';
    import { withTenant } from '@tenantguard/fetch';
    const guard = createTenantGuard({ carrier: nodeContext, authorize: () => ({ tenantId: 'Org_A' }) });
    const handler = withTenant(guard, (_request, context) => {
      assert.equal(requireTenant().tenantId, context.tenantId);
      return new Response(context.tenantId);
    });
    assert.equal(await (await handler(new Request('http://test'))).text(), 'Org_A');
  `,
  );
  execFileSync(process.execPath, ['consumer.mjs'], {
    cwd: temporary,
    stdio: 'inherit',
  });
  // Type declarations must resolve from installed package exports, without workspace aliases.
  writeFileSync(
    join(temporary, 'consumer.ts'),
    `
    import { createTenantGuard, createTenantRouter, type DatabaseAdapter } from '@tenantguard/core';
    import { withTenant } from '@tenantguard/fetch';
    const guard = createTenantGuard<Request>({ authorize: () => ({ tenantId: 'Org_A' }) });
    withTenant(guard, (_request, context) => new Response(context.tenantId));
    const adapter: DatabaseAdapter<{ query(): string }> = {
      name: 'fixture', capabilities: { isolationModes: ['database-policy'], transactions: true },
      run: async (_context, _route, work) => work({ query: () => 'ok' })
    };
    const router = createTenantRouter({ sources: { orders: { adapter, mode: 'database-policy' } }, registry: { resolve: async () => undefined } });
    void router.run({ tenantId: 'Org_A' }, 'orders', async client => client.query());
  `,
  );
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.ts',
    ],
    { cwd: temporary, stdio: 'inherit' },
  );
  console.log(
    'Packed core/node/fetch: clean offline JavaScript and TypeScript consumers passed',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
