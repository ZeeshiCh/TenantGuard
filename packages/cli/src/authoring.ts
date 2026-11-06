import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tenantPolicySql } from '@tenantguard/postgres';
import { sqlServerPolicyBatches } from '@tenantguard/sqlserver';
import {
  ConfigError,
  parseDiagnosticConfig,
  readDiagnosticConfig,
} from './config.js';
import { makeReport, type DiagnosticReport } from './report.js';

/** An existing file or symlink is never opened for writing. */
export async function writeNewFile(
  filename: string,
  content: string,
): Promise<void> {
  let handle;
  try {
    handle = await open(resolve(filename), 'wx', 0o600);
  } catch {
    throw new ConfigError('OUTPUT.UNAVAILABLE', 'output');
  }
  try {
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    throw new ConfigError('OUTPUT.WRITE_FAILED', 'output');
  }
}
export async function author(
  args: readonly string[],
): Promise<DiagnosticReport> {
  const command = args[0] as 'init' | 'generate-policy';
  const options: Record<string, { type: 'string' | 'boolean' }> =
    command === 'init'
      ? {
          engine: { type: 'string' as const },
          output: { type: 'string' as const },
          table: { type: 'string' as const },
          schema: { type: 'string' as const },
          'tenant-column': { type: 'string' as const },
          'url-env': { type: 'string' as const },
          json: { type: 'boolean' as const },
        }
      : {
          config: { type: 'string' as const },
          source: { type: 'string' as const },
          output: { type: 'string' as const },
          json: { type: 'boolean' as const },
        };
  const parsed = parseArgs({ args: [...args.slice(1)], options, tokens: true });
  const names = parsed.tokens
    .filter((t) => t.kind === 'option')
    .map((t) => t.name);
  if (new Set(names).size !== names.length)
    throw new ConfigError('CLI.ARGUMENTS', 'arguments');
  const v = parsed.values as {
    engine?: string;
    output?: string;
    table?: string;
    schema?: string;
    'tenant-column'?: string;
    'url-env'?: string;
    config?: string;
    source?: string;
    json?: boolean;
  };
  if (command === 'init') {
    if (!v.engine) throw new ConfigError('CLI.ARGUMENTS', 'engine');
    const config = {
      version: 1,
      sources: [
        {
          name: 'main',
          engine: v.engine,
          mode: ['postgres', 'sqlserver'].includes(v.engine)
            ? 'database-policy'
            : 'application-filter',
          ...(v.engine === 'sqlite'
            ? { filenameEnv: v['url-env'] ?? 'TG_SQLITE_FILE' }
            : { urlEnv: v['url-env'] ?? 'TG_DATABASE_URL' }),
          targets: [
            {
              table: v.table ?? 'orders',
              tenantColumn: v['tenant-column'] ?? 'tenant_id',
              ...(v.schema ? { schema: v.schema } : {}),
            },
          ],
        },
      ],
    };
    parseDiagnosticConfig(config);
    await writeNewFile(
      v.output ?? 'tenantguard.json',
      JSON.stringify(config, null, 2) + '\n',
    );
    return makeReport(command, false, [
      {
        code: 'CONFIG.CREATED',
        severity: 'info',
        message:
          'Created a new diagnostic config. Set its environment reference and review declared targets before connecting.',
      },
    ]);
  }
  if (!v.config) throw new ConfigError('CLI.ARGUMENTS', 'config');
  const config = await readDiagnosticConfig(resolve(v.config));
  const source = v.source
    ? config.sources.find((s) => s.name === v.source)
    : config.sources.length === 1
      ? config.sources[0]
      : undefined;
  if (!source) throw new ConfigError('CONFIG.SOURCE', 'source');
  if (source.mode !== 'database-policy')
    throw new ConfigError('POLICY.MODE_UNSUPPORTED', 'source.mode');
  const batches = source.targets.flatMap((t) =>
    source.engine === 'postgres'
      ? [tenantPolicySql(t.table, t.schema, t.tenantColumn)]
      : [...sqlServerPolicyBatches({ ...t, schema: t.schema ?? 'dbo' })],
  );
  const artifact = { engine: source.engine, batches };
  const sql = policyText(artifact);
  if (v.output) await writeNewFile(v.output, sql);
  return makeReport(
    command,
    false,
    [
      {
        source: source.name,
        code: 'POLICY.GENERATED',
        severity: 'info',
        message:
          'Generated owner-run migration SQL only; no database connection or schema change was made.',
      },
    ],
    {
      scope: [
        {
          source: source.name,
          engine: source.engine,
          mode: source.mode,
          targets: source.targets.map(
            (t) => (t.schema ? t.schema + '.' : '') + t.table,
          ),
        },
      ],
      ...(!v.output ? { artifact } : {}),
    },
  );
}
export function policyText(artifact: {
  engine: string;
  batches: readonly string[];
}): string {
  return (
    '-- TenantGuard generated migration: review and run with migration-owner credentials.\n' +
    artifact.batches.join(artifact.engine === 'sqlserver' ? '\nGO\n' : '\n') +
    '\n'
  );
}
