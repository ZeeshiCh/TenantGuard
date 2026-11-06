import { validateTenantId } from '@tenantguard/core';
import { validatePostgresTenantId } from '@tenantguard/postgres';
import { validateSqlServerTenantId } from '@tenantguard/sqlserver';
import { ConfigError, type ResolvedSource, type Target } from './config.js';
export interface IsolationProbe {
  readonly target: Target;
  readonly tenantA: string;
  readonly tenantB: string;
  readonly rowA: string;
  readonly rowB: string;
}
export function resolveProbe(
  sources: readonly ResolvedSource[],
  values: Readonly<Record<string, string | boolean | undefined>>,
  environment: Readonly<Record<string, string | undefined>>,
): { source: ResolvedSource; probe: IsolationProbe } {
  const source = sources.find((s) => s.name === values.source);
  const target = source?.targets.find(
    (t) => (t.schema ? t.schema + '.' : '') + t.table === values.target,
  );
  if (!source || !target) throw new ConfigError('PROBE.TARGET', 'target');
  const fields = [
    'tenant-a-env',
    'tenant-b-env',
    'row-a-env',
    'row-b-env',
  ] as const;
  const refs = fields.map((field) => {
    const ref = values[field];
    if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref))
      throw new ConfigError('PROBE.REFERENCE', field);
    const value = environment[ref];
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > 256 ||
      value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      Buffer.from(value).toString('utf8') !== value
    )
      throw new ConfigError('PROBE.VALUE', field);
    return value;
  });
  const [tenantA, tenantB, rowA, rowB] = refs as [
    string,
    string,
    string,
    string,
  ];
  try {
    for (const tenant of [tenantA, tenantB]) {
      validateTenantId(tenant);
      if (source.engine === 'postgres') validatePostgresTenantId(tenant);
      if (source.engine === 'sqlserver') validateSqlServerTenantId(tenant);
    }
  } catch {
    throw new ConfigError('PROBE.TENANT', 'tenant');
  }
  if (tenantA === tenantB || rowA === rowB)
    throw new ConfigError('PROBE.DISTINCT', 'fixtures');
  return {
    source: { ...source, targets: [target] },
    probe: { target, tenantA, tenantB, rowA, rowB },
  };
}
