import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantContext,
  type TenantRoute,
} from '@tenantguard/core';
import {
  createScopedSqlCompiler,
  quoteScopedSqlIdentifier,
  validateScopedSqlTable,
  validateUtf8Text,
  type ScopedSqlFilter,
  type ScopedSqlFindOptions,
  type ScopedSqlStatement,
  type ScopedSqlTable,
} from './crud.js';
import {
  sqlDuration,
  type ScopedSqlResult,
  type ScopedSqlSessionPool,
} from './pool.js';
export type ScopedSqlCommitOutcome = 'not-committed' | 'committed' | 'unknown';
export class ScopedSqlSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopedSqlSafetyError';
  }
}
export class ScopedSqlTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly commitOutcome: ScopedSqlCommitOutcome = 'not-committed',
  ) {
    super(`Scoped SQL ${phase} timed out`);
    this.name = 'ScopedSqlTimeoutError';
  }
}
export class ScopedSqlCleanupError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly commitOutcome: ScopedSqlCommitOutcome,
  ) {
    super(errors, 'Scoped SQL cleanup failed; connection destroyed');
    this.name = 'ScopedSqlCleanupError';
  }
}
export class ScopedSqlCommitError extends Error {
  readonly commitOutcome = 'unknown';
  constructor(cause: unknown) {
    super('Scoped SQL commit outcome is unknown; do not retry blindly', {
      cause,
    });
    this.name = 'ScopedSqlCommitError';
  }
}
export interface ScopedSqlRepository<
  Row extends object = Record<string, unknown>,
> {
  find(
    where?: ScopedSqlFilter,
    options?: ScopedSqlFindOptions,
  ): Promise<readonly Row[]>;
  insert(row: ScopedSqlFilter): Promise<number>;
  update(where: ScopedSqlFilter, changes: ScopedSqlFilter): Promise<number>;
  delete(where: ScopedSqlFilter): Promise<number>;
}
export interface ScopedSqlClient {
  table<Row extends object = Record<string, unknown>>(
    name: string,
  ): ScopedSqlRepository<Row>;
}
export interface ScopedSqlAdapterOptions {
  resolvePool(
    route: Readonly<TenantRoute>,
  ): ScopedSqlSessionPool | Promise<ScopedSqlSessionPool>;
  readonly tables: Readonly<Record<string, ScopedSqlTable>>;
  readonly acquireTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
}
const scopes = new AsyncLocalStorage<true>();
const SESSION_SQL =
  'SELECT DATABASE() AS database_name, CURRENT_USER() AS authenticated_user, @@session.autocommit AS autocommit, CONVERT(@tenantguard_tenant USING utf8mb4) AS tenant, VERSION() AS version';
function bounded<T>(
  promise: Promise<T>,
  ms: number,
  error: () => Error,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(error());
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (expired) late?.(value);
        else resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        if (!expired) reject(reason);
      },
    );
  });
}
/** Shared application-filter implementation. Concrete native-driver factories supply sessions. */
export function createScopedSqlAdapter(
  engine: 'mysql' | 'mariadb',
  options: ScopedSqlAdapterOptions,
): DatabaseAdapter<ScopedSqlClient> {
  const tables = new Map(
    Object.entries(options.tables).map(([name, table]) => {
      quoteScopedSqlIdentifier(name);
      return [name, validateScopedSqlTable(table)] as const;
    }),
  );
  if (!tables.size) throw new TypeError('Declare at least one scoped table');
  const resolvePool = options.resolvePool,
    acquireMs = sqlDuration(options.acquireTimeoutMs, 5000),
    operationMs = sqlDuration(options.operationTimeoutMs, 30000),
    requestMs = sqlDuration(options.requestTimeoutMs, 15000),
    cleanupMs = sqlDuration(options.cleanupTimeoutMs, 2000),
    lockMs = sqlDuration(options.lockTimeoutMs, 5000);
  return Object.freeze({
    name: engine,
    capabilities: Object.freeze({
      isolationModes: Object.freeze(['application-filter'] as const),
      transactions: true,
    }),
    async run<T>(
      context: Readonly<TenantContext>,
      route: Readonly<TenantRoute>,
      work: (client: ScopedSqlClient) => Promise<T>,
    ): Promise<T> {
      const snapshot = createTenantContext(context);
      validateUtf8Text(snapshot.tenantId);
      if (
        route.adapter !== engine ||
        route.mode !== 'application-filter' ||
        route.status !== 'active' ||
        route.tenantId !== snapshot.tenantId ||
        ![route.source, route.resource, route.revision].every(
          (value) => typeof value === 'string' && value.length > 0,
        ) ||
        (route.secretRef !== undefined &&
          (typeof route.secretRef !== 'string' || !route.secretRef))
      )
        throw new ScopedSqlSafetyError(
          'Invalid application-filter tenant route',
        );
      if (scopes.getStore())
        throw new ScopedSqlSafetyError(
          'Nested or detached scoped SQL transactions are unsupported; reuse the repository',
        );
      const routing = Object.freeze({ ...route });
      return scopes.run(true, async () => {
        const pool = await bounded(
          Promise.resolve().then(() => resolvePool(routing)),
          acquireMs,
          () => new ScopedSqlTimeoutError('pool resolution'),
        );
        const session = await bounded(
          pool.acquire(),
          acquireMs,
          () => new ScopedSqlTimeoutError('acquisition'),
          (late) => late.release(true),
        );
        const state: { outcome: ScopedSqlCommitOutcome } = {
          outcome: 'not-committed',
        };
        let accepting = false,
          closed = false,
          broken = false,
          failed = false,
          queryFailed = false,
          failure: unknown,
          queryFailure: unknown;
        let rejectConnection: (error: unknown) => void = () => {};
        const connectionFailure = new Promise<never>((_resolve, reject) => {
          rejectConnection = reject;
        });
        let detach: () => void;
        try {
          detach = session.onError((error) => {
            broken = true;
            accepting = false;
            rejectConnection(error);
          });
        } catch (error) {
          session.release(true);
          throw error;
        }
        const execute = async (
          text: string,
          values?: ScopedSqlStatement['values'],
        ) => {
          if (closed || broken)
            throw new ScopedSqlSafetyError('Scoped SQL session is closed');
          const result = await bounded(
            session.execute(text, values),
            requestMs,
            () => new ScopedSqlTimeoutError('request', state.outcome),
          );
          if (closed || broken)
            throw new ScopedSqlSafetyError('Scoped SQL session is closed');
          return result;
        };
        let user: string | undefined;
        const checkState = (result: ScopedSqlResult, tenant: string | null) => {
          const row = result.rows[0];
          if (
            !row ||
            row.database_name !== session.database ||
            typeof row.authenticated_user !== 'string' ||
            (user !== undefined && row.authenticated_user !== user) ||
            Number(row.autocommit) !== 1 ||
            row.tenant !== tenant ||
            typeof row.version !== 'string' ||
            /mariadb/i.test(row.version) !== (engine === 'mariadb')
          )
            throw new ScopedSqlSafetyError(
              'Scoped SQL database, identity, context or server engine is unsafe',
            );
          user = row.authenticated_user;
        };
        const pending = new Set<Promise<unknown>>();
        let queue: Promise<unknown> = Promise.resolve();
        const schedule = <R>(
          plan: () => ScopedSqlStatement,
          map: (result: ScopedSqlResult) => R,
        ): Promise<R> => {
          let statement: ScopedSqlStatement;
          try {
            if (!accepting || closed)
              throw new ScopedSqlSafetyError(
                'Repository is outside its active callback',
              );
            statement = plan();
          } catch (error) {
            queryFailed = true;
            queryFailure = error;
            const rejected = Promise.reject<R>(error);
            void rejected.catch(() => {});
            return rejected;
          }
          const promise = queue.then(async () => {
            if (!accepting || closed || broken || queryFailed)
              throw new ScopedSqlSafetyError(
                'Scoped SQL transaction is no longer usable',
              );
            try {
              checkState(await execute(SESSION_SQL), snapshot.tenantId);
              return map(await execute(statement.text, statement.values));
            } catch (error) {
              queryFailed = true;
              queryFailure = error;
              throw error;
            }
          });
          queue = promise.then(
            () => {},
            () => {},
          );
          pending.add(promise);
          void promise.then(
            () => pending.delete(promise),
            () => pending.delete(promise),
          );
          return promise;
        };
        const count = (result: ScopedSqlResult) => {
          if (
            !Number.isSafeInteger(result.affectedRows) ||
            result.affectedRows < 0
          )
            throw new ScopedSqlSafetyError('Invalid affected-row result');
          return result.affectedRows;
        };
        const client: ScopedSqlClient = Object.freeze({
          table<Row extends object = Record<string, unknown>>(
            name: string,
          ): ScopedSqlRepository<Row> {
            if (!accepting || closed)
              throw new ScopedSqlSafetyError(
                'Repository is outside its active callback',
              );
            const manifest = tables.get(name);
            if (!manifest) {
              queryFailed = true;
              queryFailure = new ScopedSqlSafetyError(
                'Unregistered scoped table',
              );
              throw queryFailure;
            }
            const compiler = createScopedSqlCompiler(
              session.database,
              manifest,
              snapshot.tenantId,
            );
            return Object.freeze({
              find: (
                where?: ScopedSqlFilter,
                findOptions?: ScopedSqlFindOptions,
              ) =>
                schedule(
                  () => compiler.find(where, findOptions),
                  (result) => result.rows as readonly Row[],
                ),
              insert: (row: ScopedSqlFilter) =>
                schedule(() => compiler.insert(row), count),
              update: (where: ScopedSqlFilter, changes: ScopedSqlFilter) =>
                schedule(() => compiler.update(where, changes), count),
              delete: (where: ScopedSqlFilter) =>
                schedule(() => compiler.delete(where), count),
            });
          },
        });
        let result: T | undefined;
        try {
          const operation = (async () => {
            quoteScopedSqlIdentifier(session.database);
            await session.rollback();
            if (closed || broken)
              throw new ScopedSqlSafetyError('Scoped SQL session is closed');
            checkState(await execute(SESSION_SQL), null);
            await execute('SELECT RELEASE_ALL_LOCKS()');
            await session.reset();
            if (closed || broken)
              throw new ScopedSqlSafetyError('Scoped SQL session is closed');
            checkState(await execute(SESSION_SQL), null);
            for (const table of tables.values()) {
              const info = (
                await execute(
                  'SELECT TABLE_TYPE AS table_type, ENGINE AS engine FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?',
                  [session.database, table.table],
                )
              ).rows[0];
              if (
                !info ||
                info.table_type !== 'BASE TABLE' ||
                String(info.engine).toUpperCase() !== 'INNODB'
              )
                throw new ScopedSqlSafetyError(
                  'Scoped tables must be ordinary InnoDB tables',
                );
              const columns = (
                await execute(
                  'SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS capacity, CHARACTER_SET_NAME AS charset FROM information_schema.COLUMNS WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?',
                  [session.database, table.table],
                )
              ).rows;
              const tenant = columns.find(
                (column) => column.name === table.tenantColumn,
              );
              if (
                !tenant ||
                tenant.type !== 'varchar' ||
                tenant.nullable !== 'NO' ||
                tenant.charset !== 'utf8mb4' ||
                Number(tenant.capacity) < snapshot.tenantId.length ||
                table.columns.some(
                  (name) => !columns.some((column) => column.name === name),
                )
              )
                throw new ScopedSqlSafetyError(
                  'Scoped table requires registered columns and a sufficient UTF8MB4 VARCHAR NOT NULL tenant column',
                );
            }
            await execute(
              "SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'",
            );
            await execute("SET SESSION time_zone='+00:00'");
            await execute(
              `SET SESSION innodb_lock_wait_timeout=${Math.ceil(lockMs / 1000)}`,
            );
            await session.begin();
            if (closed || broken)
              throw new ScopedSqlSafetyError('Scoped SQL session is closed');
            await execute('SET @tenantguard_tenant=?', [snapshot.tenantId]);
            accepting = true;
            let value: T;
            try {
              value = await work(client);
            } finally {
              accepting = false;
            }
            if (pending.size) {
              await Promise.allSettled([...pending]);
              throw new ScopedSqlSafetyError(
                'Callback returned with unawaited CRUD operations',
              );
            }
            if (queryFailed) throw queryFailure;
            checkState(await execute(SESSION_SQL), snapshot.tenantId);
            state.outcome = 'unknown';
            await session.commit();
            state.outcome = 'committed';
            return value;
          })();
          result = await bounded(
            Promise.race([operation, connectionFailure]),
            operationMs,
            () => new ScopedSqlTimeoutError('operation', state.outcome),
          );
        } catch (error) {
          failed = true;
          failure = error;
        }
        accepting = false;
        closed = true;
        let destroy =
          broken ||
          state.outcome === 'unknown' ||
          failure instanceof ScopedSqlTimeoutError ||
          failure instanceof ScopedSqlSafetyError;
        if (!destroy) {
          try {
            await bounded(
              session.rollback(),
              cleanupMs,
              () => new ScopedSqlTimeoutError('rollback', state.outcome),
            );
            await bounded(
              session.execute('SELECT RELEASE_ALL_LOCKS()'),
              cleanupMs,
              () => new ScopedSqlTimeoutError('lock cleanup', state.outcome),
            );
            await bounded(
              session.reset(),
              cleanupMs,
              () => new ScopedSqlTimeoutError('reset', state.outcome),
            );
            checkState(
              await bounded(
                session.execute(SESSION_SQL),
                cleanupMs,
                () =>
                  new ScopedSqlTimeoutError(
                    'cleanup verification',
                    state.outcome,
                  ),
              ),
              null,
            );
          } catch (cleanup) {
            destroy = true;
            failure = new ScopedSqlCleanupError(
              failed ? [failure, cleanup] : [cleanup],
              state.outcome,
            );
            failed = true;
          }
        }
        detach();
        session.release(destroy);
        if (failed) {
          if (
            state.outcome === 'unknown' &&
            !(failure instanceof ScopedSqlTimeoutError) &&
            !(failure instanceof ScopedSqlCleanupError)
          )
            throw new ScopedSqlCommitError(failure);
          throw failure;
        }
        return result as T;
      });
    },
  });
}
