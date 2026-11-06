import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Finding } from './report.js';
export type Engine =
  'postgres' | 'sqlserver' | 'mysql' | 'mariadb' | 'mongodb' | 'sqlite';
export type TlsMode = 'verify' | 'disabled' | 'insecure';
export interface Target {
  readonly table: string;
  readonly tenantColumn: string;
  readonly schema?: string;
  readonly idColumn: string;
  readonly securitySchema?: string;
  readonly predicateName?: string;
  readonly policyName?: string;
}
export interface DiagnosticSource {
  readonly name: string;
  readonly engine: Engine;
  readonly mode: 'database-policy' | 'application-filter';
  readonly urlEnv?: string;
  readonly filenameEnv?: string;
  readonly tls: TlsMode;
  readonly timeoutMs: number;
  readonly targets: readonly Target[];
}
export interface DiagnosticConfig {
  readonly version: 1;
  readonly strict: boolean;
  readonly concurrency: number;
  readonly sources: readonly DiagnosticSource[];
}
export interface ResolvedSource extends DiagnosticSource {
  readonly url?: string;
  readonly filename?: string;
  readonly database?: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
}
export class ConfigError extends Error {
  constructor(
    readonly code: string,
    readonly field: string,
  ) {
    super('Invalid diagnostic configuration');
    this.name = 'ConfigError';
  }
}
function fail(field: string, code = 'CONFIG.INVALID'): never {
  throw new ConfigError(code, field);
}
function object(
  input: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    fail(field);
  if (Object.keys(input).some((key) => !keys.includes(key)))
    fail(field, 'CONFIG.UNKNOWN_FIELD');
  return input as Record<string, unknown>;
}
function identifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value)
  )
    fail(field);
  return value;
}
function envName(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)
  )
    fail(field);
  return value;
}
function integer(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail(field);
  return value;
}
export function parseDiagnosticConfig(input: unknown): DiagnosticConfig {
  const root = object(
    input,
    ['version', 'strict', 'concurrency', 'sources'],
    'config',
  );
  if (root.version !== 1) fail('version', 'CONFIG.VERSION');
  if (root.strict !== undefined && typeof root.strict !== 'boolean')
    fail('strict');
  if (
    !Array.isArray(root.sources) ||
    root.sources.length < 1 ||
    root.sources.length > 32
  )
    fail('sources');
  const names = new Set<string>();
  const sources = Array.from(root.sources).map(
    (input, index): DiagnosticSource => {
      const path = `sources[${index}]`,
        source = object(
          input,
          [
            'name',
            'engine',
            'mode',
            'urlEnv',
            'filenameEnv',
            'tls',
            'timeoutMs',
            'targets',
          ],
          path,
        );
      const name = identifier(source.name, path + '.name');
      if (names.has(name)) fail(path + '.name', 'CONFIG.DUPLICATE_SOURCE');
      names.add(name);
      if (
        ![
          'postgres',
          'sqlserver',
          'mysql',
          'mariadb',
          'mongodb',
          'sqlite',
        ].includes(source.engine as string)
      )
        fail(path + '.engine');
      const engine = source.engine as Engine;
      if (
        !['database-policy', 'application-filter'].includes(
          source.mode as string,
        )
      )
        fail(path + '.mode');
      const mode = source.mode as DiagnosticSource['mode'];
      if (
        (['postgres', 'sqlserver'].includes(engine) &&
          mode !== 'database-policy') ||
        (!['postgres', 'sqlserver'].includes(engine) &&
          mode !== 'application-filter')
      )
        fail(path + '.mode', 'CONFIG.MODE_UNSUPPORTED');
      if (root.strict === true && mode === 'application-filter')
        fail(path + '.mode', 'CONFIG.STRICT_ISOLATION');
      const tls = source.tls ?? 'verify';
      if (
        !['verify', 'disabled', 'insecure'].includes(tls as string) ||
        (tls === 'insecure' && engine !== 'sqlserver')
      )
        fail(path + '.tls');
      let urlEnv: string | undefined, filenameEnv: string | undefined;
      if (engine === 'sqlite') {
        filenameEnv = envName(source.filenameEnv, path + '.filenameEnv');
        if (source.urlEnv !== undefined || source.tls !== undefined) fail(path);
      } else {
        urlEnv = envName(source.urlEnv, path + '.urlEnv');
        if (source.filenameEnv !== undefined) fail(path);
      }
      if (
        !Array.isArray(source.targets) ||
        source.targets.length < 1 ||
        source.targets.length > 128
      )
        fail(path + '.targets');
      const targetsSeen = new Set<string>();
      const targets = Array.from(source.targets).map((input, j) => {
        const field = path + `.targets[${j}]`,
          target = object(
            input,
            [
              'schema',
              'table',
              'tenantColumn',
              'idColumn',
              'securitySchema',
              'predicateName',
              'policyName',
            ],
            field,
          );
        const table = identifier(target.table, field + '.table'),
          tenantColumn = identifier(
            target.tenantColumn,
            field + '.tenantColumn',
          ),
          idColumn = identifier(target.idColumn ?? 'id', field + '.idColumn');
        if (tenantColumn === idColumn) fail(field, 'CONFIG.IDENTITY_COLUMNS');
        const schema =
          target.schema === undefined
            ? engine === 'postgres'
              ? 'public'
              : engine === 'sqlserver'
                ? 'dbo'
                : engine === 'sqlite'
                  ? 'main'
                  : undefined
            : identifier(target.schema, field + '.schema');
        if (engine === 'mongodb' && schema !== undefined)
          fail(field + '.schema');
        if (engine === 'sqlite' && schema !== undefined && schema !== 'main')
          fail(field + '.schema');
        const key = JSON.stringify([
          schema ??
            (['postgres'].includes(engine)
              ? 'public'
              : engine === 'sqlserver'
                ? 'dbo'
                : engine === 'sqlite'
                  ? 'main'
                  : ''),
          table,
        ]);
        if (targetsSeen.has(key)) fail(field, 'CONFIG.DUPLICATE_TARGET');
        targetsSeen.add(key);
        if (
          engine === 'sqlserver' &&
          ((target.predicateName === undefined &&
            `${schema}_${table}_tenant_predicate`.length > 128) ||
            (target.policyName === undefined &&
              `${schema}_${table}_tenant_policy`.length > 128))
        )
          fail(field, 'CONFIG.POLICY_NAME');
        const extra: Record<string, string> = {};
        for (const key of [
          'securitySchema',
          'predicateName',
          'policyName',
        ] as const)
          if (target[key] !== undefined) {
            if (engine !== 'sqlserver') fail(field);
            extra[key] = identifier(target[key], field + '.' + key);
          }
        return Object.freeze({
          table,
          tenantColumn,
          idColumn,
          ...(schema ? { schema } : {}),
          ...extra,
        });
      });
      return Object.freeze({
        name,
        engine,
        mode,
        tls: tls as TlsMode,
        timeoutMs: integer(
          source.timeoutMs ?? 10000,
          200,
          60000,
          path + '.timeoutMs',
        ),
        targets: Object.freeze(targets),
        ...(urlEnv ? { urlEnv } : {}),
        ...(filenameEnv ? { filenameEnv } : {}),
      });
    },
  );
  return Object.freeze({
    version: 1,
    strict: root.strict === true,
    concurrency: integer(root.concurrency ?? 2, 1, 4, 'concurrency'),
    sources: Object.freeze(sources),
  });
}
export async function readDiagnosticConfig(
  path: string,
): Promise<DiagnosticConfig> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) fail('config', 'CONFIG.FILE');
    const limit = 1024 * 1024,
      buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const result = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) fail('config', 'CONFIG.SIZE');
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    } catch {
      fail('config', 'CONFIG.JSON');
    }
    return parseDiagnosticConfig(value);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('CONFIG.FILE', 'config');
  } finally {
    await handle?.close();
  }
}
export function resolveDiagnosticSources(
  config: DiagnosticConfig,
  environment: Readonly<Record<string, string | undefined>>,
  baseDirectory = process.cwd(),
): readonly ResolvedSource[] {
  return Object.freeze(
    config.sources.map((source, index) => {
      const field = `sources[${index}]`,
        value = environment[source.urlEnv ?? source.filenameEnv!];
      if (
        typeof value !== 'string' ||
        !value.length ||
        value.length > 8192 ||
        /[\u0000-\u001f\u007f]/u.test(value)
      )
        fail(field + '.environment', 'CONFIG.ENVIRONMENT');
      if (source.engine === 'sqlite') {
        if (!isAbsolute(value) || value === ':memory:')
          fail(field + '.filename', 'CONFIG.SQLITE_PATH');
        return Object.freeze({
          ...source,
          filename: resolve(baseDirectory, value),
        });
      }
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        fail(field + '.url', 'CONFIG.URL');
      }
      const protocols = {
        postgres: ['postgres:', 'postgresql:'],
        mysql: ['mysql:'],
        mariadb: ['mariadb:', 'mysql:'],
        sqlserver: ['mssql:', 'sqlserver:'],
        mongodb: ['mongodb:', 'mongodb+srv:'],
        sqlite: [],
      };
      if (
        !protocols[source.engine].includes(parsed!.protocol) ||
        !parsed!.hostname ||
        parsed!.hash
      )
        fail(field + '.url', 'CONFIG.URL');
      const seen = new Set<string>();
      for (const [name] of parsed!.searchParams) {
        if (
          source.engine !== 'mongodb' ||
          !['authSource', 'replicaSet', 'directConnection'].includes(name) ||
          seen.has(name)
        )
          fail(field + '.url', 'CONFIG.URL_OPTIONS');
        seen.add(name);
      }
      let database: string, user: string, password: string;
      try {
        database = decodeURIComponent(parsed!.pathname.replace(/^\//, ''));
        user = decodeURIComponent(parsed!.username);
        password = decodeURIComponent(parsed!.password);
      } catch {
        fail(field + '.url', 'CONFIG.URL');
      }
      if (
        !database ||
        database!.length > 128 ||
        database!.includes('/') ||
        /[\u0000-\u001f\u007f]/u.test(database! + user! + password!)
      )
        fail(field + '.url', 'CONFIG.URL');
      if (['mysql', 'mariadb'].includes(source.engine)) {
        const seen = new Set<string>();
        for (const target of source.targets) {
          if (target.schema !== undefined && target.schema !== database!)
            fail(field + '.targets', 'CONFIG.DATABASE_SCOPE');
          const key = (target.schema ?? database!) + '\0' + target.table;
          if (seen.has(key))
            fail(field + '.targets', 'CONFIG.DUPLICATE_TARGET');
          seen.add(key);
        }
      }
      if (source.engine !== 'mongodb' && (!user! || !password!))
        fail(field + '.url', 'CONFIG.CREDENTIALS');
      if (source.engine === 'mongodb') {
        for (const [name, value] of parsed!.searchParams) {
          if (
            !value ||
            value.length > 256 ||
            /[\u0000-\u001f\u007f]/u.test(value) ||
            (name === 'directConnection' && !['true', 'false'].includes(value))
          )
            fail(field + '.url', 'CONFIG.URL_OPTIONS');
        }
        if (
          parsed!.protocol === 'mongodb+srv:' &&
          (parsed!.port ||
            parsed!.searchParams.get('directConnection') === 'true')
        )
          fail(field + '.url', 'CONFIG.URL_OPTIONS');
      }
      const port = parsed!.port
        ? integer(Number(parsed!.port), 1, 65535, field + '.port')
        : undefined;
      return Object.freeze({
        ...source,
        url: value,
        database: database!,
        host: parsed!.hostname.replace(/^\[|\]$/g, ''),
        user: user!,
        password: password!,
        ...(port ? { port } : {}),
      });
    }),
  );
}
export function configFindings(sources: readonly ResolvedSource[]): Finding[] {
  const findings: Finding[] = [];
  for (const source of sources) {
    findings.push({
      code: 'CONFIG.VALID',
      severity: 'info',
      source: source.name,
      message:
        'Declared engine, scope, isolation mode and connection reference are valid.',
    });
    if (source.mode === 'application-filter')
      findings.push({
        code: 'ISOLATION.APPLICATION_FILTER',
        severity: 'warning',
        source: source.name,
        message:
          'Isolation depends on the scoped application API; raw database access bypasses it.',
      });
    if (source.engine !== 'sqlite' && source.tls !== 'verify')
      findings.push({
        code: 'TRANSPORT.UNVERIFIED',
        severity: 'warning',
        source: source.name,
        message: 'Certificate-verified transport is not configured.',
      });
  }
  return findings;
}
