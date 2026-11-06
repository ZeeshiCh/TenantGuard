import { PrismaSafetyError, type ValidatedModel } from './guards.js';
import type { PrismaProvider } from './resource.js';
export interface PrismaRawTransaction {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}
/** Fixed infrastructure queries only; raw transaction APIs never reach business callbacks. */
export async function verifyPrismaModels(
  tx: PrismaRawTransaction,
  provider: PrismaProvider,
  models: readonly ValidatedModel[],
): Promise<void> {
  for (const model of models) {
    if (provider === 'postgresql') {
      const rows = await tx.$queryRawUnsafe<{ safe: boolean }[]>(
        `SELECT (c.relkind='r' AND a.attnotnull AND a.attgenerated='' AND a.atttypid IN ('text'::regtype,'varchar'::regtype) AND co.collisdeterministic) AS safe FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation WHERE n.nspname=$1 AND c.relname=$2 AND a.attname=$3 AND a.attnum>0 AND NOT a.attisdropped`,
        model.schema,
        model.table,
        model.tenantColumn,
      );
      if (rows.length !== 1 || rows[0]?.safe !== true)
        throw new PrismaSafetyError(
          'Prisma requires ordinary PostgreSQL tables with deterministic TEXT/VARCHAR NOT NULL tenant columns',
        );
    } else {
      const rows = await tx.$queryRawUnsafe<
        {
          engine: string;
          table_type: string;
          data_type: string;
          nullable: string;
          collation_name: string;
          extra: string;
        }[]
      >(
        `SELECT t.ENGINE AS engine,t.TABLE_TYPE AS table_type,c.DATA_TYPE AS data_type,c.IS_NULLABLE AS nullable,c.COLLATION_NAME AS collation_name,c.EXTRA AS extra FROM information_schema.TABLES t JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? AND c.COLUMN_NAME=?`,
        model.table,
        model.tenantColumn,
      );
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row.engine !== 'InnoDB' ||
        row.table_type !== 'BASE TABLE' ||
        row.data_type !== 'varchar' ||
        row.nullable !== 'NO' ||
        !['utf8mb4_0900_bin', 'utf8mb4_nopad_bin'].includes(
          row.collation_name,
        ) ||
        /GENERATED/i.test(row.extra)
      )
        throw new PrismaSafetyError(
          'Prisma requires InnoDB VARCHAR NOT NULL tenant columns with an approved binary NO PAD collation',
        );
    }
  }
}
