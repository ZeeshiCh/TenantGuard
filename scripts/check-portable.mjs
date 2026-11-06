import assert from 'node:assert/strict';
import { build } from 'esbuild';
// A browser-target bundle rejects node imports (including transitive ones).
for (const [name, entryPoint] of [
  ['registry', 'packages/registry/src/index.ts'],
  ['core', 'packages/core/src/index.ts'],
  ['fetch', 'packages/fetch/src/index.ts'],
  ['hono', 'packages/hono/src/index.ts'],
  ['drizzle/guards', 'packages/drizzle/src/guards.ts'],
  ['prisma/guards', 'packages/prisma/src/guards.ts'],
  ['mongoose/guards', 'packages/mongoose/src/guards.ts'],
  ['mongodb/guards', 'packages/mongodb/src/guards.ts'],
  ['scoped-sql/compiler', 'packages/scoped-sql/src/crud.ts'],
]) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    tsconfig: 'tsconfig.json',
  });
  assert.ok(result.outputFiles[0].text.length > 0);
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.ok(
      !input.includes('packages/node/'),
      `${name} depends on the Node context carrier`,
    );
  }
  console.log(`${name}: portable browser bundle passed`);
}
