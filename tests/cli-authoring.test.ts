import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose, main } from '../packages/cli/src/api.js';
import type { DiagnosticReport } from '../packages/cli/src/report.js';
async function fixture(work: (directory: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'tg-author-'));
  try {
    await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function run(args: string[]) {
  const value = await diagnose(args, {});
  assert(!('help' in value));
  return value as DiagnosticReport;
}
test('init generates validated offline configs for all six engines', async () =>
  fixture(async (dir) => {
    for (const engine of [
      'postgres',
      'sqlserver',
      'mysql',
      'mariadb',
      'mongodb',
      'sqlite',
    ]) {
      const path = join(dir, engine + '.json');
      assert.equal(
        (await run(['init', '--engine', engine, '--output', path])).exitCode,
        0,
      );
      const config = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(config.sources[0].engine, engine);
      assert.equal(config.sources[0].name, 'main');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  }));
test('init refuses existing files and symlinks without changing their bytes', async () =>
  fixture(async (dir) => {
    const path = join(dir, 'config.json'),
      link = join(dir, 'link.json');
    await writeFile(path, 'original');
    await symlink(path, link);
    for (const output of [path, link])
      assert.equal(
        (await run(['init', '--engine', 'sqlite', '--output', output]))
          .exitCode,
        2,
      );
    assert.equal(await readFile(path, 'utf8'), 'original');
  }));
test('concurrent init creates exactly one file without overwrite', async () =>
  fixture(async (dir) => {
    const args = [
      'init',
      '--engine',
      'postgres',
      '--output',
      join(dir, 'config.json'),
    ];
    const result = await Promise.all([run(args), run(args)]);
    assert.deepEqual(result.map((r) => r.exitCode).sort(), [0, 2]);
  }));
test('init rejects invalid modes, identifiers and extra arguments before file creation', async () =>
  fixture(async (dir) => {
    for (const args of [
      ['--engine', 'other'],
      ['--engine', 'postgres', '--table', 'orders;DROP'],
      ['--engine', 'postgres', '--engine', 'sqlite'],
      ['--engine', 'sqlite', '--schema', 'other'],
      ['--engine', 'postgres', '--connect'],
    ])
      assert.equal(
        (await run(['init', ...args, '--output', join(dir, 'out.json')]))
          .exitCode,
        2,
      );
  }));
test('generate-policy emits exact PostgreSQL helpers offline without resolving credentials', async () =>
  fixture(async (dir) => {
    const config = join(dir, 'config.json');
    await run(['init', '--engine', 'postgres', '--output', config]);
    const result = await run(['generate-policy', '--config', config]);
    assert.equal(result.exitCode, 0);
    assert.match(result.artifact!.batches[0]!, /FORCE ROW LEVEL SECURITY/);
    assert.equal(result.connected, false);
    let output = '';
    assert.equal(
      await main(
        ['generate-policy', '--config', config],
        {
          write: (s) => {
            output += s;
          },
        },
        {},
      ),
      0,
    );
    assert.match(output, /CREATE POLICY tenantguard_boundary/);
    assert(!output.includes('TG_DATABASE_URL'));
  }));
test('SQL Server output preserves function batch boundaries and supports custom names', async () =>
  fixture(async (dir) => {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        sources: [
          {
            name: 'orders',
            engine: 'sqlserver',
            mode: 'database-policy',
            urlEnv: 'UNSET',
            targets: [
              {
                schema: 'dbo',
                table: 'orders',
                tenantColumn: 'owner',
                predicateName: 'custom_predicate',
                policyName: 'custom_policy',
              },
            ],
          },
        ],
      }),
    );
    const report = await run(['generate-policy', '--config', path]);
    assert.equal(report.artifact!.batches.length, 3);
    assert.match(report.artifact!.batches[1]!, /custom_predicate/);
    const out = join(dir, 'migration.sql');
    assert.equal(
      (await run(['generate-policy', '--config', path, '--output', out]))
        .exitCode,
      0,
    );
    assert.match(await readFile(out, 'utf8'), /\nGO\nCREATE FUNCTION/);
    assert.equal(
      (await run(['generate-policy', '--config', path, '--output', out]))
        .exitCode,
      2,
    );
  }));
test('generate-policy rejects application-filter engines and ambiguous source selection', async () =>
  fixture(async (dir) => {
    const path = join(dir, 'config.json');
    await run(['init', '--engine', 'mysql', '--output', path]);
    assert.equal(
      (await run(['generate-policy', '--config', path])).exitCode,
      2,
    );
    const config = JSON.parse(await readFile(path, 'utf8'));
    config.sources.push({ ...config.sources[0], name: 'second' });
    await writeFile(path, JSON.stringify(config));
    assert.equal(
      (await run(['generate-policy', '--config', path])).exitCode,
      2,
    );
    assert.equal(
      (await run(['generate-policy', '--config', path, '--source', 'unknown']))
        .exitCode,
      2,
    );
  }));
