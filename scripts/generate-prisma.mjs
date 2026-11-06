import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const manifest = require.resolve('prisma/package.json');
const cli = join(dirname(manifest), 'build/index.js');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const generator = [
  process.execPath,
  resolve('packages/prisma/src/generator.js'),
]
  .map(quote)
  .join(' ');
for (const provider of ['postgresql', 'mysql']) {
  const schema = `tests/prisma/${provider}.prisma`,
    output = `tests/prisma/generated/${provider}`,
    stamp = join(output, '.tenantguard-generated');
  const digest = createHash('sha256')
    .update(readFileSync(schema))
    .update(readFileSync(manifest))
    .update(readFileSync('packages/prisma/src/generator.js'))
    .digest('hex');
  if (
    existsSync(stamp) &&
    existsSync(join(output, 'client.ts')) &&
    existsSync(join(output, 'tenantguard/datamodel.json')) &&
    readFileSync(stamp, 'utf8') === digest
  )
    continue;
  execFileSync(process.execPath, [cli, 'generate', '--schema', schema], {
    stdio: 'inherit',
    env: { ...process.env, TENANTGUARD_PRISMA_GENERATOR: generator },
  });
  writeFileSync(stamp, digest);
}
