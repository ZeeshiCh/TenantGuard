import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve('.');
const temporary = mkdtempSync(join(tmpdir(), 'tenantguard-consumer-'));
try {
  const packed = new Map();
  function pack(directory, workspace = false) {
    const manifest = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    );
    if (packed.has(manifest.name)) {
      if (packed.get(manifest.name) !== manifest.version)
        throw new Error(
          `Consumer fixture needs conflicting versions of ${manifest.name}`,
        );
      return;
    }
    packed.set(manifest.name, manifest.version);
    if (workspace) {
      execFileSync('pnpm', ['pack', '--pack-destination', temporary], {
        cwd: directory,
        stdio: 'pipe',
      });
    } else {
      execFileSync(
        'npm',
        [
          'pack',
          directory,
          '--ignore-scripts',
          '--pack-destination',
          temporary,
          '--cache',
          join(temporary, 'cache'),
        ],
        { cwd: temporary, stdio: 'pipe' },
      );
    }
    const require = createRequire(join(directory, 'package.json'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@tenantguard/')) {
        pack(
          join(root, 'packages', dependency.slice('@tenantguard/'.length)),
          true,
        );
        continue;
      }
      let dependencyDirectory;
      try {
        dependencyDirectory = dirname(
          require.resolve(`${dependency}/package.json`),
        );
      } catch {
        dependencyDirectory = dirname(require.resolve(dependency));
        while (
          !existsSync(join(dependencyDirectory, 'package.json')) ||
          JSON.parse(
            readFileSync(join(dependencyDirectory, 'package.json'), 'utf8'),
          ).name !== dependency
        ) {
          const parent = dirname(dependencyDirectory);
          if (parent === dependencyDirectory)
            throw new Error(`Cannot locate manifest for ${dependency}`);
          dependencyDirectory = parent;
        }
      }
      pack(dependencyDirectory);
    }
  }
  for (const name of ['core', 'node', 'fetch', 'postgres'])
    pack(join(root, 'packages', name), true);
  pack(
    dirname(
      createRequire(join(root, 'package.json')).resolve('pg/package.json'),
    ),
  );
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
    import pg from 'pg';
    import { createPgAdapter } from '@tenantguard/postgres/pg';
    const guard = createTenantGuard({ carrier: nodeContext, authorize: () => ({ tenantId: 'Org_A' }) });
    const handler = withTenant(guard, (_request, context) => {
      assert.equal(requireTenant().tenantId, context.tenantId);
      return new Response(context.tenantId);
    });
    assert.equal(await (await handler(new Request('http://test'))).text(), 'Org_A');
    const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 100 });
    const adapter = createPgAdapter({ resolvePool: () => pool, tables: [{ schema: 'public', table: 'orders' }] });
    assert.equal(adapter.name, 'pg');
    await pool.end();
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
    import pg from 'pg';
    import { createPgAdapter, type PgTenantClient } from '@tenantguard/postgres/pg';
    const guard = createTenantGuard<Request>({ authorize: () => ({ tenantId: 'Org_A' }) });
    withTenant(guard, (_request, context) => new Response(context.tenantId));
    const adapter: DatabaseAdapter<{ query(): string }> = {
      name: 'fixture', capabilities: { isolationModes: ['database-policy'], transactions: true },
      run: async (_context, _route, work) => work({ query: () => 'ok' })
    };
    const router = createTenantRouter({ sources: { orders: { adapter, mode: 'database-policy' } }, registry: { resolve: async () => undefined } });
    void router.run({ tenantId: 'Org_A' }, 'orders', async client => client.query());
    const pool = new pg.Pool({ max: 1 });
    const direct = createPgAdapter({ resolvePool: () => pool, tables: [{ schema: 'public', table: 'orders' }] });
    const typed: import('@tenantguard/core').DatabaseAdapter<PgTenantClient> = direct;
    void typed;
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
    'Packed core/node/fetch/postgres: clean offline JavaScript and TypeScript consumers passed',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
