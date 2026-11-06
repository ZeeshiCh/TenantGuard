import pg from 'pg';
import type { ResolvedSource } from './config.js';
import type { Observer } from './inspection.js';
/** A recognizer for the generated UUID policy, not arbitrary policy-expression evaluation. */
export function policyTemplate(
  expression: string | null,
  column: string,
): boolean {
  if (expression === null) return false;
  // Preserve all quoted strings; remove only canonical renderer parentheses/whitespace.
  const pieces = expression.match(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|[^'"\s()]+|[()\s]+/g,
  );
  if (!pieces || pieces.join('') !== expression) return false;
  const value = pieces.filter((token) => !/^[(\s)]+$/.test(token)).join('');
  const identifiers = [column, '"' + column + '"'];
  return identifiers.some(
    (name) =>
      value ===
        `${name}=NULLIFcurrent_setting'app.tenant_id'::text,true,''::text::uuid` ||
      value === `${name}=NULLIFcurrent_setting'app.tenant_id',true,''::uuid`,
  );
}
export async function inspectPostgres(
  source: ResolvedSource,
  out: Observer,
): Promise<void> {
  const client = new pg.Client({
    host: source.host,
    port: source.port ?? 5432,
    user: source.user,
    password: source.password,
    database: source.database,
    ssl: source.tls === 'verify' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: source.timeoutMs,
    statement_timeout: source.timeoutMs,
    application_name: 'tenantguard-cli',
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const role = (
      await client.query(`SELECT current_user=session_user AS identity_ok,
 EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication) AND pg_catalog.pg_has_role(session_user,r.oid,'MEMBER')) AS privileged,
 pg_catalog.current_setting('server_version_num')::int AS version, NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') AS tenant`)
    ).rows[0]!;
    if (role.identity_ok !== true || role.privileged !== false)
      out.add(
        'PG.ROLE_PRIVILEGED',
        'error',
        'Runtime identity or a reachable role can administer or bypass isolation.',
      );
    if (role.tenant !== null)
      out.add(
        'PG.SESSION_TENANT',
        'error',
        'Fresh diagnostic session inherits a tenant context; review runtime role defaults.',
      );
    if (role.version < 140000)
      out.add(
        'PG.VERSION',
        'error',
        'PostgreSQL 14 or later is required by these catalog checks.',
      );
    for (const target of source.targets) {
      const row = (
        await client.query(
          `SELECT c.oid,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
 pg_catalog.pg_has_role(session_user,c.relowner,'MEMBER') AS owner,
 pg_catalog.has_table_privilege(current_user,c.oid,'TRUNCATE') AS truncate,
 pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') AS create_schema,
 a.attnotnull,a.atttypid='pg_catalog.uuid'::pg_catalog.regtype AS uuid
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=$3 AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname=$1 AND c.relname=$2`,
          [target.schema ?? 'public', target.table, target.tenantColumn],
        )
      ).rows[0];
      if (!row) {
        out.unknown(
          'PG.TARGET_UNAVAILABLE',
          'Configured table is absent or not visible.',
          target,
        );
        continue;
      }
      if (row.relkind !== 'r')
        out.add(
          'PG.ORDINARY_TABLE',
          'error',
          'Only ordinary protected tables are supported.',
          target,
        );
      if (row.relrowsecurity !== true || row.relforcerowsecurity !== true)
        out.add(
          'PG.RLS_REQUIRED',
          'error',
          'Tenant table must enable and force row-level security.',
          target,
        );
      if (
        row.owner !== false ||
        row.truncate !== false ||
        row.create_schema !== false
      )
        out.add(
          'PG.ROLE_DDL',
          'error',
          'Runtime role has ownership, schema creation or TRUNCATE capability.',
          target,
        );
      if (row.attnotnull !== true || row.uuid !== true)
        out.add(
          'PG.TENANT_COLUMN',
          'error',
          'Tenant ownership requires a NOT NULL UUID column.',
          target,
        );
      const policies = (
        await client.query(
          `SELECT polname,polpermissive,polcmd,0=ANY(polroles) AS public,
 pg_catalog.pg_get_expr(polqual,polrelid) AS using_expr,pg_catalog.pg_get_expr(polwithcheck,polrelid) AS check_expr
 FROM pg_catalog.pg_policy WHERE polrelid=$1`,
          [row.oid],
        )
      ).rows;
      for (const [name, permissive] of [
        ['tenantguard_access', true],
        ['tenantguard_boundary', false],
      ] as const) {
        const policy = policies.find((p) => p.polname === name);
        if (
          !policy ||
          policy.polpermissive !== permissive ||
          policy.polcmd !== '*' ||
          policy.public !== true
        ) {
          out.add(
            'PG.POLICY_BINDING',
            'error',
            'Required public permissive/restrictive ALL policy is missing or mismatched.',
            target,
          );
          continue;
        }
        if (
          !policyTemplate(policy.using_expr, target.tenantColumn) ||
          !policyTemplate(policy.check_expr, target.tenantColumn)
        ) {
          if (
            [policy.using_expr, policy.check_expr].some(
              (value) =>
                typeof value === 'string' &&
                /^(?:\(*\s*)?(true|false)(?:\s*\)*)?$/i.test(value),
            )
          )
            out.add(
              'PG.POLICY_CONSTANT',
              'error',
              'A required policy has a constant predicate instead of tenant ownership.',
              target,
            );
          else
            out.unknown(
              'PG.POLICY_UNVERIFIED',
              'Required predicate is not a recognized TenantGuard UUID policy; review custom semantics.',
              target,
            );
        }
      }
      if (policies.length > 2)
        out.add(
          'PG.POLICY_EXTRA',
          'warning',
          'Additional policies need explicit review beyond the generated boundary.',
          target,
        );
      out.add(
        'PG.CATALOG_OBSERVED',
        'info',
        'Role, column and RLS metadata were inspected; runtime behavior is not certified.',
        target,
      );
    }
  } finally {
    await client.end();
  }
}
