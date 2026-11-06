import assert from 'node:assert/strict';
import { build } from 'esbuild';
// A browser-target bundle rejects node imports (including transitive ones).
for (const name of ['core', 'fetch', 'hono']) {
  const result = await build({
    entryPoints: [`packages/${name}/src/index.ts`],
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
