import {
  createSqlServerPool,
  sqlServerPolicyNames,
  sqlServerPolicyBatches,
  quoteSqlServerIdentifier,
} from '@tenantguard/sqlserver';
import type { ResolvedSource } from './config.js';
import type { Observer } from './inspection.js';
export function sqlServerTemplate(
  definition: unknown,
  expected: string,
): boolean {
  return (
    typeof definition === 'string' &&
    definition
      .replace(/^ALTER\s+FUNCTION/i, 'CREATE FUNCTION')
      .replace(/\s+/g, ' ')
      .trim() === expected.replace(/\s+/g, ' ').trim()
  );
}
export async function inspectSqlServer(
  source: ResolvedSource,
  out: Observer,
): Promise<void> {
  const pool = createSqlServerPool({
    connection: {
      server: source.host!,
      authentication: {
        type: 'default',
        options: { userName: source.user, password: source.password },
      },
      options: {
        port: source.port ?? 1433,
        database: source.database,
        encrypt: source.tls !== 'disabled',
        trustServerCertificate: source.tls === 'insecure',
        appName: 'tenantguard-cli',
      },
    },
    max: 1,
    acquireTimeoutMs: source.timeoutMs,
    connectTimeoutMs: source.timeoutMs,
  });
  let session: Awaited<ReturnType<typeof pool.acquire>> | undefined;
  try {
    session = await pool.acquire();
    const permissions = [
      "IS_SRVROLEMEMBER(N'sysadmin')",
      "IS_MEMBER(N'db_owner')",
      "IS_MEMBER(N'db_securityadmin')",
      "IS_MEMBER(N'db_ddladmin')",
      "HAS_PERMS_BY_NAME(NULL,NULL,N'CONTROL SERVER')",
      "HAS_PERMS_BY_NAME(NULL,NULL,N'ALTER ANY LOGIN')",
      "HAS_PERMS_BY_NAME(NULL,NULL,N'IMPERSONATE ANY LOGIN')",
      ...[
        'CONTROL',
        'ALTER ANY SECURITY POLICY',
        'ALTER ANY ROLE',
        'ALTER ANY USER',
        'ALTER ANY SCHEMA',
        'CREATE SCHEMA',
        'CREATE FUNCTION',
      ].map((value) => `HAS_PERMS_BY_NAME(DB_NAME(),N'DATABASE',N'${value}')`),
      "CASE WHEN EXISTS(SELECT 1 FROM sys.database_permissions p JOIN sys.user_token t ON t.principal_id=p.grantee_principal_id WHERE p.class=4 AND p.permission_name IN(N'IMPERSONATE',N'CONTROL') AND p.state IN('G','W')) THEN 1 ELSE 0 END",
      "CASE WHEN EXISTS(SELECT 1 FROM sys.server_permissions p JOIN sys.login_token t ON t.principal_id=p.grantee_principal_id WHERE p.class=101 AND p.permission_name IN(N'IMPERSONATE',N'CONTROL') AND p.state IN('G','W')) THEN 1 ELSE 0 END",
    ];
    const role = (
      await session.query(
        'SELECT ' +
          permissions.map((value, i) => `${value} AS p${i}`).join(','),
        {},
        source.timeoutMs,
      )
    ).rows[0];
    if (!role || permissions.some((_, i) => role[`p${i}`] === null))
      out.unknown(
        'MSSQL.ROLE_UNAVAILABLE',
        'Runtime privilege metadata could not be established.',
      );
    else if (permissions.some((_, i) => role[`p${i}`] !== 0))
      out.add(
        'MSSQL.ROLE_PRIVILEGED',
        'error',
        'Runtime identity has administrative, schema or impersonation capability.',
      );
    for (const target of source.targets) {
      const names = sqlServerPolicyNames({
        schema: target.schema ?? 'dbo',
        table: target.table,
        tenantColumn: target.tenantColumn,
        securitySchema: target.securitySchema,
        predicateName: target.predicateName,
        policyName: target.policyName,
      });
      const binding = `${quoteSqlServerIdentifier(names.securitySchema)}.${quoteSqlServerIdentifier(names.predicateName)}(${quoteSqlServerIdentifier(names.tenantColumn)})`;
      const row = (
        await session.query(
          `SELECT t.object_id,c.system_type_id,c.is_nullable,p.is_enabled,p.is_schema_bound,
 HAS_PERMS_BY_NAME(QUOTENAME(@schema)+N'.'+QUOTENAME(@table),N'OBJECT',N'ALTER') AS table_alter,
 HAS_PERMS_BY_NAME(QUOTENAME(@schema),N'SCHEMA',N'ALTER') AS schema_alter,
 HAS_PERMS_BY_NAME(QUOTENAME(@securitySchema),N'SCHEMA',N'ALTER') AS security_alter,
 HAS_PERMS_BY_NAME(QUOTENAME(@securitySchema)+N'.'+QUOTENAME(@predicate),N'OBJECT',N'ALTER') AS predicate_alter,
 (SELECT COUNT(*) FROM sys.security_predicates f WHERE f.object_id=p.object_id AND f.target_object_id=t.object_id AND (f.predicate_definition=@definition OR f.predicate_definition=N'('+@definition+N')') AND f.predicate_type=0) AS filters,
 (SELECT COUNT(*) FROM sys.security_predicates f WHERE f.object_id=p.object_id AND f.target_object_id=t.object_id AND (f.predicate_definition=@definition OR f.predicate_definition=N'('+@definition+N')') AND f.predicate_type=1 AND f.operation=1) AS inserts,
 (SELECT COUNT(*) FROM sys.security_predicates f WHERE f.object_id=p.object_id AND f.target_object_id=t.object_id AND (f.predicate_definition=@definition OR f.predicate_definition=N'('+@definition+N')') AND f.predicate_type=1 AND f.operation=2) AS updates,
 OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@securitySchema)+N'.'+QUOTENAME(@predicate))) AS definition
 FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
 LEFT JOIN sys.columns c ON c.object_id=t.object_id AND c.name=@column
 LEFT JOIN sys.security_policies p ON p.name=@policy AND SCHEMA_NAME(p.schema_id)=@securitySchema
 WHERE s.name=@schema AND t.name=@table`,
          {
            schema: names.schema,
            table: names.table,
            column: names.tenantColumn,
            policy: names.policyName,
            securitySchema: names.securitySchema,
            predicate: names.predicateName,
            definition: binding,
          },
          source.timeoutMs,
        )
      ).rows[0];
      if (!row) {
        out.unknown(
          'MSSQL.TARGET_UNAVAILABLE',
          'Configured table is absent or invisible.',
          target,
        );
        continue;
      }
      if (row.system_type_id !== 36 || row.is_nullable !== false)
        out.add(
          'MSSQL.TENANT_COLUMN',
          'error',
          'Tenant ownership requires a NOT NULL uniqueidentifier column.',
          target,
        );
      if (
        row.is_enabled !== true ||
        row.is_schema_bound !== true ||
        row.filters !== 1 ||
        row.inserts !== 1 ||
        row.updates !== 1
      )
        out.add(
          'MSSQL.RLS_BINDING',
          'error',
          'Enabled schema-bound filter and INSERT/UPDATE block predicates are required.',
          target,
        );
      if (
        [
          'table_alter',
          'schema_alter',
          'security_alter',
          'predicate_alter',
        ].some((key) => row[key] !== 0)
      )
        out.add(
          'MSSQL.ROLE_DDL',
          'error',
          'Runtime role can alter protected tables, schemas or predicates.',
          target,
        );
      if (!sqlServerTemplate(row.definition, sqlServerPolicyBatches(names)[1]!))
        out.unknown(
          'MSSQL.PREDICATE_UNVERIFIED',
          'Predicate definition is unavailable or not the supported TenantGuard template.',
          target,
        );
      out.add(
        'MSSQL.CATALOG_OBSERVED',
        'info',
        'Native RLS bindings and predicate metadata were inspected.',
        target,
      );
    }
  } finally {
    session?.release(true);
    await pool.close();
  }
}
