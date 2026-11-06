import { DrizzleSafetyError, type ValidatedDrizzleTable } from './guards.js';
import type { DrizzleWire } from './resource.js';
export async function verifyDrizzleTables(
  wire: DrizzleWire,
  tables: readonly ValidatedDrizzleTable[],
) {
  for (const table of tables) {
    if (table.provider !== wire.provider)
      throw new DrizzleSafetyError('Drizzle table/provider mismatch');
    if (wire.provider === 'postgresql') {
      const rows = await wire.query(
        `SELECT (c.relkind='r' AND a.attnotnull AND a.attgenerated='' AND a.atttypid IN ('text'::regtype,'varchar'::regtype)) AS safe FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE n.nspname=$1 AND c.relname=$2 AND a.attname=$3 AND a.attnum>0 AND NOT a.attisdropped`,
        [table.schema, table.name, table.tenantName],
      );
      if (rows.length !== 1 || rows[0]?.safe !== true)
        throw new DrizzleSafetyError(
          'Drizzle requires ordinary PostgreSQL tables and TEXT/VARCHAR NOT NULL tenant columns',
        );
    } else {
      const rows = await wire.query(
          `SELECT t.ENGINE AS engine,t.TABLE_TYPE AS table_type,c.DATA_TYPE AS data_type,c.IS_NULLABLE AS nullable,c.EXTRA AS extra FROM information_schema.TABLES t JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? AND c.COLUMN_NAME=?`,
          [table.name, table.tenantName],
        ),
        row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row.engine !== 'InnoDB' ||
        row.table_type !== 'BASE TABLE' ||
        row.data_type !== 'varchar' ||
        row.nullable !== 'NO' ||
        typeof row.extra !== 'string' ||
        /GENERATED/i.test(row.extra)
      )
        throw new DrizzleSafetyError(
          'Drizzle requires InnoDB ordinary tables and VARCHAR NOT NULL tenant columns',
        );
    }
  }
}
