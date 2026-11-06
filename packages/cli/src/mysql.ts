import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import type { ResolvedSource } from './config.js';
import type { Observer } from './inspection.js';
export async function inspectMysql(
  source: ResolvedSource,
  out: Observer,
): Promise<void> {
  const client = await mysql.createConnection({
    host: source.host,
    port: source.port ?? 3306,
    user: source.user,
    password: source.password,
    database: source.database,
    charset: 'utf8mb4',
    connectTimeout: source.timeoutMs,
    multipleStatements: false,
    ssl: source.tls === 'verify' ? { rejectUnauthorized: true } : undefined,
  });
  try {
    const [version] = await client.query<RowDataPacket[]>(
      'SELECT VERSION() AS version',
    );
    if (
      String(version[0]!.version).includes('MariaDB') !==
      (source.engine === 'mariadb')
    )
      out.add(
        'MYSQL.ENGINE_MISMATCH',
        'error',
        'Connected database does not match the declared MySQL/MariaDB engine.',
      );
    await client.query('START TRANSACTION READ ONLY');
    const [grants] = await client.query<RowDataPacket[]>(
      'SHOW GRANTS FOR CURRENT_USER',
    );
    const elevated = grants.some((row) =>
      Object.values(row).some(
        (value) =>
          typeof value === 'string' &&
          /^GRANT\s+(?:ALL PRIVILEGES|.*\b(?:SUPER|CREATE USER|SYSTEM_USER|ROLE_ADMIN|FILE|SHUTDOWN)\b)/i.test(
            value,
          ),
      ),
    );
    if (elevated)
      out.add(
        'MYSQL.ROLE_PRIVILEGED',
        'error',
        'Connected role has direct global administrative privileges.',
      );
    out.add(
      'MYSQL.GRANTS_PARTIAL',
      'warning',
      'Effective inherited roles, proxy users and all privilege paths require separate review.',
    );
    for (const target of source.targets) {
      const schema = target.schema ?? source.database!;
      const [rows] = await client.execute<RowDataPacket[]>(
        'SELECT t.TABLE_TYPE,t.ENGINE,c.IS_NULLABLE,c.DATA_TYPE,c.COLLATION_NAME FROM information_schema.TABLES t LEFT JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME AND c.COLUMN_NAME=? WHERE t.TABLE_SCHEMA=? AND t.TABLE_NAME=?',
        [target.tenantColumn, schema, target.table],
      );
      const row = rows[0];
      if (!row) {
        out.unknown(
          'MYSQL.TARGET_UNAVAILABLE',
          'Configured table is absent or invisible.',
          target,
        );
        continue;
      }
      if (
        row.TABLE_TYPE !== 'BASE TABLE' ||
        String(row.ENGINE).toLowerCase() !== 'innodb'
      )
        out.add(
          'MYSQL.TRANSACTIONAL_TABLE',
          'error',
          'Only InnoDB base tables support the declared transactional CRUD mode.',
          target,
        );
      if (
        row.IS_NULLABLE !== 'NO' ||
        ![
          'varchar',
          'char',
          'text',
          'tinytext',
          'mediumtext',
          'longtext',
        ].includes(row.DATA_TYPE)
      )
        out.add(
          'MYSQL.TENANT_COLUMN',
          'error',
          'Tenant ownership requires a non-null character column.',
          target,
        );
      if (row.COLLATION_NAME && !String(row.COLLATION_NAME).endsWith('_bin'))
        out.add(
          'MYSQL.COLLATION',
          'warning',
          'Default tenant collation is not binary; the scoped adapter must retain binary ownership predicates.',
          target,
        );
      const [indexes] = await client.execute<RowDataPacket[]>(
        'SELECT INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',
        [schema, target.table],
      );
      if (
        !indexes.some(
          (index) =>
            index.COLUMN_NAME === target.tenantColumn &&
            Number(index.SEQ_IN_INDEX) === 1,
        )
      )
        out.add(
          'MYSQL.TENANT_INDEX',
          'warning',
          'No tenant-leading index was observed; inspect query plans and tenant-aware constraints.',
          target,
        );
      if (source.engine === 'mariadb')
        out.add(
          'MYSQL.RELATIONSHIPS_UNVERIFIED',
          'info',
          'Published tenant-audit 0.2.0 does not implement MariaDB relationship analysis.',
          target,
        );
      out.add(
        'MYSQL.CATALOG_OBSERVED',
        'info',
        'Transactional table, ownership column, collation and index metadata were inspected.',
        target,
      );
    }
  } finally {
    await client.end();
  }
}
