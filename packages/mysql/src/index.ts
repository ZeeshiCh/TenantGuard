import mysql, {
  type ConnectionOptions,
  type RowDataPacket,
  type ResultSetHeader,
} from 'mysql2/promise';
import {
  createScopedSqlAdapter,
  createScopedSqlPool,
  quoteScopedSqlIdentifier,
  sqlDuration,
  type ScopedSqlAdapterOptions,
  type ScopedSqlPoolOptions,
  type ScopedSqlResult,
  type ScopedSqlWire,
} from '@tenantguard/scoped-sql';
export type {
  ScopedSqlClient,
  ScopedSqlRepository,
  ScopedSqlTable,
  ScopedSqlValue,
  ScopedSqlFilter,
  ScopedSqlFindOptions,
} from '@tenantguard/scoped-sql';
export {
  ScopedSqlSafetyError,
  ScopedSqlTimeoutError,
  ScopedSqlCleanupError,
  ScopedSqlCommitError,
} from '@tenantguard/scoped-sql';
export interface MysqlPoolOptions extends Omit<
  ScopedSqlPoolOptions,
  'connect' | 'database'
> {
  readonly connection: ConnectionOptions & { database: string };
}
export function createMysqlPool(options: MysqlPoolOptions) {
  quoteScopedSqlIdentifier(options.connection.database);
  const config = structuredClone(options.connection);
  const connectTimeout = sqlDuration(options.connectTimeoutMs, 5000);
  return createScopedSqlPool({
    ...options,
    database: config.database,
    connect: async (): Promise<ScopedSqlWire> => {
      const connection = await mysql.createConnection({
        ...config,
        connectTimeout,
        multipleStatements: false,
        namedPlaceholders: false,
        rowsAsArray: false,
        charset: 'utf8mb4',
        timezone: 'Z',
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        flags: ['FOUND_ROWS'],
      });
      let closed = false;
      const listeners = new Set<(error: Error) => void>();
      connection.on('error', (error) => {
        if (!closed) for (const listener of listeners) listener(error);
      });
      connection.on('end', () => {
        if (!closed)
          for (const listener of listeners)
            listener(new Error('MySQL connection ended'));
      });
      return {
        async execute(text, values = []): Promise<ScopedSqlResult> {
          const [data] = await connection.execute<
            RowDataPacket[] | ResultSetHeader
          >(
            text,
            values.map((value) =>
              typeof value === 'bigint'
                ? value.toString()
                : value instanceof Uint8Array
                  ? Buffer.from(value)
                  : value,
            ),
          );
          return Array.isArray(data)
            ? { rows: data.map((row) => ({ ...row })), affectedRows: 0 }
            : { rows: [], affectedRows: data.affectedRows };
        },
        begin: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        rollback: () => connection.rollback(),
        reset: async () => {
          await connection.reset();
          await connection.query('SET NAMES utf8mb4');
        },
        destroy() {
          closed = true;
          connection.destroy();
        },
        onError(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    },
  });
}
export function createMysqlAdapter(options: ScopedSqlAdapterOptions) {
  return createScopedSqlAdapter('mysql', options);
}
