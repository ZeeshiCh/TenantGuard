/** UUID encoding is specific to this PostgreSQL policy, not the portable tenant identity. */
export function validatePostgresTenantId(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new TypeError(
      'PostgreSQL UUID tenant policy requires a canonical lowercase UUID tenantId',
    );
}
export const SET_TENANT_SQL = "SELECT set_config('app.tenant_id', $1, true)";
export function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value) || Buffer.byteLength(value) > 63)
    throw new TypeError('Invalid PostgreSQL identifier');
  return `"${value}"`;
}
/** Apply in a migration, using the table owner. Tenant column must be UUID NOT NULL. */
export function tenantPolicySql(
  table: string,
  schema = 'public',
  column = 'tenant_id',
): string {
  const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const predicate = `${quoteIdentifier(column)} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
  return `ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${target} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenantguard_access ON ${target} AS PERMISSIVE FOR ALL USING (${predicate}) WITH CHECK (${predicate});
CREATE POLICY tenantguard_boundary ON ${target} AS RESTRICTIVE FOR ALL USING (${predicate}) WITH CHECK (${predicate});`;
}
/** Inventory only: policy expressions and role privileges still require manual review. */
export const AUDIT_SQL = `SELECT n.nspname AS schema, c.relname AS table,
 c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
 EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) AS has_policy
 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1, 2`;
