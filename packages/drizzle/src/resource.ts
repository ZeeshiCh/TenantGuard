import pg, { type ClientConfig } from 'pg';
import mysql, {
  type ConnectionOptions,
  type RowDataPacket,
  type ResultSetHeader,
} from 'mysql2/promise';
import {
  drizzle as pgDrizzle,
  type NodePgDatabase,
} from 'drizzle-orm/node-postgres';
import {
  drizzle as mysqlDrizzle,
  type MySql2Database,
} from 'drizzle-orm/mysql2';
import { DrizzleSafetyError, identifier } from './guards.js';
export type DrizzleCommitOutcome = 'not-committed' | 'committed' | 'unknown';
export class DrizzleTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly commitOutcome: DrizzleCommitOutcome = 'not-committed',
  ) {
    super(`Drizzle ${phase} deadline exceeded`);
  }
}
export class DrizzleLifecycleError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly commitOutcome: DrizzleCommitOutcome,
  ) {
    super(errors, 'Drizzle transaction or cleanup failed');
  }
}
export function duration(value: number | undefined, fallback: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > 300000)
    throw new DrizzleSafetyError('Invalid Drizzle timeout');
  return n;
}
export async function bounded<T>(
  promise: Promise<T>,
  ms: number,
  error: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
interface BaseWire {
  query(
    text: string,
    values?: readonly (string | number | null)[],
  ): Promise<readonly Record<string, unknown>[]>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  destroy(): void;
  onError(listener: (error: Error) => void): () => void;
}
export type DrizzleWire = BaseWire &
  (
    | { readonly provider: 'postgresql'; readonly db: NodePgDatabase }
    | { readonly provider: 'mysql'; readonly db: MySql2Database }
  );
export interface DrizzleResource {
  readonly provider: 'postgresql' | 'mysql';
  readonly closed: boolean;
  close(): Promise<void>;
}
interface State {
  provider: 'postgresql' | 'mysql';
  connect: () => Promise<DrizzleWire>;
  closed: boolean;
  wires: Set<DrizzleWire>;
  closing?: Promise<void>;
}
const resources = new WeakMap<DrizzleResource, State>();
/** Internal resource constructor supports transport fault-injection; no raw connection escapes the public package. */
export function ownedDrizzleResource(
  provider: State['provider'],
  connect: State['connect'],
): DrizzleResource {
  const state: State = { provider, connect, closed: false, wires: new Set() };
  const resource: DrizzleResource = Object.freeze({
    provider,
    get closed() {
      return state.closed;
    },
    close() {
      state.closed = true;
      for (const wire of state.wires) wire.destroy();
      return (state.closing ??= Promise.allSettled(
        [...state.wires].map((wire) => wire.close()),
      ).then((results) => {
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => r.reason);
        if (errors.length)
          throw new AggregateError(errors, 'Drizzle resource closure failed');
      }));
    },
  });
  resources.set(resource, state);
  return resource;
}
export async function acquireDrizzle(
  resource: DrizzleResource,
  isActive: () => boolean,
) {
  const state = resources.get(resource);
  if (!state || state.closed)
    throw new DrizzleSafetyError(
      'Drizzle resource closed or not owned by TenantGuard',
    );
  const wire = await state.connect();
  state.wires.add(wire);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= wire.close().finally(() => state.wires.delete(wire)));
  if (state.closed || !isActive()) {
    wire.destroy();
    try {
      await close();
    } catch (error) {
      void resource.close().catch(() => {});
      throw error;
    }
    throw new DrizzleSafetyError('Drizzle scope expired during acquisition');
  }
  return { wire, close, destroy: () => wire.destroy() };
}
export function createDrizzlePgResource(options: {
  connection: ClientConfig;
  connectTimeoutMs?: number;
}): DrizzleResource {
  const config = structuredClone(options.connection),
    connectMs = duration(options.connectTimeoutMs, 5000);
  (config as ClientConfig & { pipeline?: boolean }).pipeline = false;
  return ownedDrizzleResource('postgresql', async () => {
    const client = new pg.Client({
      ...config,
      connectionTimeoutMillis: connectMs,
      statement_timeout: 5000,
      lock_timeout: 1000,
      idle_in_transaction_session_timeout: 30000,
    });
    const listeners = new Set<(error: Error) => void>();
    let fatal: Error | undefined,
      closing: Promise<void> | undefined,
      ended = false;
    client.on('error', (error) => {
      fatal = error;
      for (const listener of listeners) listener(error);
    });
    client.on('end', () => {
      if (!ended) {
        fatal ??= new Error('Drizzle PostgreSQL connection ended');
        for (const listener of listeners) listener(fatal);
      }
    });
    const close = () => {
      ended = true;
      return (closing ??= client.end());
    };
    try {
      await client.connect();
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
    return {
      provider: 'postgresql',
      db: pgDrizzle(client),
      async query(text, values = []) {
        return (await client.query(text, [...values])).rows as Record<
          string,
          unknown
        >[];
      },
      async begin() {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query('SET LOCAL search_path=public,pg_catalog,pg_temp');
      },
      async commit() {
        const result = await client.query('COMMIT');
        if (result.command !== 'COMMIT')
          throw new DrizzleSafetyError(
            'PostgreSQL did not commit the transaction',
          );
      },
      async rollback() {
        await client.query('ROLLBACK');
      },
      close,
      destroy() {
        void close().catch(() => {});
      },
      onError(listener) {
        listeners.add(listener);
        if (fatal) listener(fatal);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  });
}
export function createDrizzleMysqlResource(options: {
  connection: ConnectionOptions & { database: string };
  connectTimeoutMs?: number;
}): DrizzleResource {
  const config = structuredClone(options.connection),
    connectMs = duration(options.connectTimeoutMs, 5000);
  identifier(config.database);
  return ownedDrizzleResource('mysql', async () => {
    const connection = await mysql.createConnection({
      ...config,
      connectTimeout: connectMs,
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
    let ended = false,
      fatal: Error | undefined,
      closing: Promise<void> | undefined;
    const listeners = new Set<(error: Error) => void>();
    connection.on('error', (error: Error) => {
      fatal = error;
      if (!ended) for (const listener of listeners) listener(error);
    });
    connection.on('end', () => {
      if (!ended) {
        fatal ??= new Error('Drizzle MySQL connection ended');
        for (const listener of listeners) listener(fatal);
      }
    });
    const close = () => {
      ended = true;
      return (closing ??= connection.end());
    };
    return {
      provider: 'mysql',
      db: mysqlDrizzle(connection),
      async query(text, values = []) {
        const [rows] = await connection.execute<RowDataPacket[]>(text, [
          ...values,
        ]);
        return rows as Record<string, unknown>[];
      },
      async begin() {
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT DATABASE() AS name,@@autocommit AS autocommit',
        );
        if (
          rows[0]?.name !== config.database ||
          Number(rows[0]?.autocommit) !== 1
        )
          throw new DrizzleSafetyError(
            'Unsafe MySQL database/autocommit state',
          );
        await connection.query('SET SESSION innodb_lock_wait_timeout=1');
        await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        await connection.beginTransaction();
      },
      async commit() {
        await connection.commit();
        const [status] = await connection.query<ResultSetHeader>('DO 0');
        if (status.serverStatus & 1)
          throw new DrizzleSafetyError(
            'MySQL commit left an active transaction',
          );
      },
      async rollback() {
        await connection.rollback();
        const [status] = await connection.query<ResultSetHeader>('DO 0');
        if (status.serverStatus & 1)
          throw new DrizzleSafetyError(
            'MySQL rollback left an active transaction',
          );
      },
      close,
      destroy() {
        ended = true;
        connection.destroy();
      },
      onError(listener) {
        listeners.add(listener);
        if (fatal) listener(fatal);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  });
}
