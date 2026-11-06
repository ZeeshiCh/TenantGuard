import mariadb, { type ConnectionConfig, type UpsertResult } from 'mariadb';
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
export interface MariadbPoolOptions extends Omit<
  ScopedSqlPoolOptions,
  'connect' | 'database'
> {
  readonly connection: ConnectionConfig & { database: string };
}
export function createMariadbPool(options: MariadbPoolOptions) {
  quoteScopedSqlIdentifier(options.connection.database);
  const config = structuredClone(options.connection);
  const connectTimeout = sqlDuration(options.connectTimeoutMs, 5000);
  return createScopedSqlPool({
    ...options,
    database: config.database,
    connect: async (): Promise<ScopedSqlWire> => {
      const connection = await mariadb.createConnection({
        ...config,
        connectTimeout,
        multipleStatements: false,
        namedPlaceholders: false,
        rowsAsArray: false,
        charset: 'utf8mb4',
        timezone: '+00:00',
        foundRows: true,
      });
      let closed = false;
      const listeners = new Set<(error: Error) => void>();
      connection.on('error', (error) => {
        if (!closed) for (const listener of listeners) listener(error);
      });
      connection.on('end', () => {
        if (!closed)
          for (const listener of listeners)
            listener(new Error('MariaDB connection ended'));
      });
      return {
        async execute(text, values = []): Promise<ScopedSqlResult> {
          const data = await connection.execute<
            Record<string, unknown>[] | UpsertResult
          >(
            text,
            values.map((value) =>
              value instanceof Uint8Array ? Buffer.from(value) : value,
            ),
          );
          return Array.isArray(data)
            ? { rows: data.map((row) => ({ ...row })), affectedRows: 0 }
            : { rows: [], affectedRows: Number(data.affectedRows) };
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
export function createMariadbAdapter(options: ScopedSqlAdapterOptions) {
  return createScopedSqlAdapter('mariadb', options);
}
