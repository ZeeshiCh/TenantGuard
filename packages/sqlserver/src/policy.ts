export function quoteSqlServerIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value) || value.length > 128)
    throw new TypeError('Invalid SQL Server identifier');
  return `[${value}]`;
}
export function validateSqlServerTenantId(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new TypeError(
      'SQL Server uniqueidentifier policy requires a canonical lowercase UUID',
    );
}
export interface SqlServerProtectedTable {
  readonly schema: string;
  readonly table: string;
  readonly tenantColumn?: string;
  readonly securitySchema?: string;
  readonly predicateName?: string;
  readonly policyName?: string;
}
export function sqlServerPolicyNames(table: SqlServerProtectedTable) {
  const names = {
    schema: table.schema,
    table: table.table,
    tenantColumn: table.tenantColumn ?? 'tenant_id',
    securitySchema: table.securitySchema ?? 'tenantguard',
    predicateName:
      table.predicateName ?? `${table.schema}_${table.table}_tenant_predicate`,
    policyName:
      table.policyName ?? `${table.schema}_${table.table}_tenant_policy`,
  };
  for (const name of Object.values(names)) quoteSqlServerIdentifier(name);
  return Object.freeze(names);
}
/** Owner-run migration batches. CREATE FUNCTION must start its own batch; no GO parser needed. */
export function sqlServerPolicyBatches(
  table: SqlServerProtectedTable,
): readonly string[] {
  const names = sqlServerPolicyNames(table);
  const schema = quoteSqlServerIdentifier(names.securitySchema);
  const predicate = `${schema}.${quoteSqlServerIdentifier(names.predicateName)}`;
  const policy = `${schema}.${quoteSqlServerIdentifier(names.policyName)}`;
  const target = `${quoteSqlServerIdentifier(names.schema)}.${quoteSqlServerIdentifier(names.table)}`;
  const column = quoteSqlServerIdentifier(names.tenantColumn);
  return Object.freeze([
    `IF SCHEMA_ID(N'${names.securitySchema}') IS NULL EXEC(N'CREATE SCHEMA ${schema} AUTHORIZATION [dbo]');`,
    `CREATE FUNCTION ${predicate}(@tenant uniqueidentifier) RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS allowed WHERE DATALENGTH(CONVERT(nvarchar(4000), SESSION_CONTEXT(N'app.tenant_id'))) = 72
AND @tenant = TRY_CONVERT(uniqueidentifier, CONVERT(nvarchar(4000), SESSION_CONTEXT(N'app.tenant_id')));`,
    `CREATE SECURITY POLICY ${policy}
ADD FILTER PREDICATE ${predicate}(${column}) ON ${target},
ADD BLOCK PREDICATE ${predicate}(${column}) ON ${target} AFTER INSERT,
ADD BLOCK PREDICATE ${predicate}(${column}) ON ${target} AFTER UPDATE
WITH (STATE = ON, SCHEMABINDING = ON);`,
  ]);
}
