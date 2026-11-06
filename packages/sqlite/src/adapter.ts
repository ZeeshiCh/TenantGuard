import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createTenantContext,
  type TenantContext,
  type TenantRoute,
  type DatabaseAdapter,
} from '@tenantguard/core';
import {
  createScopedSqlCompiler,
  validateScopedSqlTable,
  validateUtf8Text,
  type ScopedSqlTable,
  type ScopedSqlFilter,
  type ScopedSqlFindOptions,
  type ScopedSqlStatement,
} from '@tenantguard/scoped-sql/compiler';
import {
  acquireSqlite,
  bounded,
  duration,
  SqliteSafetyError,
  SqliteTimeoutError,
  SqliteLifecycleError,
  type SqliteResource,
  type SqliteCommitOutcome,
  type SqliteWire,
} from './resource.js';
export interface SqliteRepository<
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
export interface SqliteScopedClient {
  table<Row extends object = Record<string, unknown>>(
    alias: string,
  ): SqliteRepository<Row>;
}
export interface SqliteAdapterOptions {
  resolveResource(
    route: Readonly<TenantRoute>,
  ): SqliteResource | Promise<SqliteResource>;
  tables: Readonly<Record<string, ScopedSqlTable>>;
  acquireTimeoutMs?: number;
  requestTimeoutMs?: number;
  operationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}
const scopes = new AsyncLocalStorage<boolean>();
export function createSqliteAdapter(
  options: SqliteAdapterOptions,
): DatabaseAdapter<SqliteScopedClient> {
  const tables = new Map(
    Object.entries(options.tables).map(([alias, table]) => [
      alias,
      validateScopedSqlTable(table),
    ]),
  );
  if (!tables.size) throw new SqliteSafetyError('SQLite tables required');
  const resolveResource = options.resolveResource,
    acquireMs = duration(options.acquireTimeoutMs, 5000),
    requestMs = duration(options.requestTimeoutMs, 5000),
    operationMs = duration(options.operationTimeoutMs, 30000),
    cleanupMs = duration(options.cleanupTimeoutMs, 5000);
  return Object.freeze({
    name: 'sqlite',
    capabilities: Object.freeze({
      isolationModes: Object.freeze(['application-filter'] as const),
      transactions: true,
    }),
    async run<T>(
      context: Readonly<TenantContext>,
      inputRoute: Readonly<TenantRoute>,
      work: (client: SqliteScopedClient) => Promise<T>,
    ): Promise<T> {
      const trusted = createTenantContext(context);
      validateUtf8Text(trusted.tenantId);
      const route = Object.freeze({ ...inputRoute });
      if (scopes.getStore())
        throw new SqliteSafetyError(
          'Nested or detached SQLite scopes are forbidden',
        );
      if (
        route.tenantId !== trusted.tenantId ||
        route.adapter !== 'sqlite' ||
        route.mode !== 'application-filter' ||
        route.status !== 'active' ||
        !route.source ||
        !route.resource ||
        !route.revision
      )
        throw new SqliteSafetyError('Invalid SQLite route');
      return scopes.run(true, async () => {
        let resource: SqliteResource | undefined,
          wire: SqliteWire | undefined,
          release: (() => void) | undefined;
        let closed = false,
          poisoned = false,
          failure: unknown,
          pending = 0,
          tail: Promise<unknown> = Promise.resolve();
        let outcome: SqliteCommitOutcome = 'not-committed',
          commitAttempted = false;
        const assertOpen = () => {
          if (resource?.closed)
            throw new SqliteSafetyError('SQLite resource closed');
          if (closed)
            throw new SqliteSafetyError(
              'SQLite facade used outside active scope',
            );
        };
        const request = <V>(command: string, data?: unknown) => {
          assertOpen();
          return bounded(
            wire!.request<V>(command, data),
            requestMs,
            () => new SqliteTimeoutError(command, outcome),
          );
        };
        const enqueue = <V>(prepare: () => () => Promise<V>): Promise<V> => {
          let action: () => Promise<V>;
          try {
            assertOpen();
            if (poisoned) throw failure;
            action = prepare();
          } catch (error) {
            poisoned = true;
            failure ??= error;
            const rejection = Promise.reject<never>(error);
            void rejection.catch(() => {});
            return rejection;
          }
          pending++;
          const task = tail
            .then(() => {
              assertOpen();
              if (poisoned) throw failure;
              return action();
            })
            .catch((error) => {
              poisoned = true;
              failure ??= error;
              throw error;
            })
            .finally(() => {
              pending--;
            });
          tail = task.catch(() => {});
          return task;
        };
        let value: T | undefined,
          primary: unknown,
          hasPrimary = false;
        try {
          value = await bounded(
            (async () => {
              resource = await bounded(
                Promise.resolve().then(() => resolveResource(route)),
                acquireMs,
                () => new SqliteTimeoutError('resource resolution'),
              );
              assertOpen();
              // Acquisition can finish after the operation deadline: release that lease before creating a worker.
              const lease = await acquireSqlite(
                resource!,
                acquireMs,
                () => !closed,
              );
              if (closed || resource!.closed) {
                await lease.wire.terminate();
                lease.release();
                throw new SqliteSafetyError(
                  'SQLite scope expired during acquisition',
                );
              }
              wire = lease.wire;
              release = lease.release;
              await request('begin', [...tables.values()]);
              assertOpen();
              const client: SqliteScopedClient = Object.freeze({
                table<Row extends object>(
                  alias: string,
                ): SqliteRepository<Row> {
                  assertOpen();
                  const spec = tables.get(alias);
                  if (!spec) {
                    poisoned = true;
                    failure ??= new SqliteSafetyError('Unknown SQLite table');
                    throw failure;
                  }
                  const compiler = createScopedSqlCompiler(
                    'main',
                    spec,
                    trusted.tenantId,
                    { dialect: 'sqlite' },
                  );
                  const execute = async (
                    plan: ScopedSqlStatement,
                    read = false,
                  ) =>
                    request<{ rows: Row[]; changes: number }>('execute', {
                      ...plan,
                      read,
                    });
                  return Object.freeze({
                    find(
                      where: ScopedSqlFilter = {},
                      findOptions: ScopedSqlFindOptions = {},
                    ) {
                      return enqueue(() => {
                        const plan = compiler.find(where, findOptions);
                        return async () => (await execute(plan, true)).rows;
                      });
                    },
                    insert(row: ScopedSqlFilter) {
                      return enqueue(() => {
                        const plan = compiler.insert(row);
                        return async () => (await execute(plan)).changes;
                      });
                    },
                    update(where: ScopedSqlFilter, changes: ScopedSqlFilter) {
                      return enqueue(() => {
                        const plan = compiler.update(where, changes);
                        return async () => (await execute(plan)).changes;
                      });
                    },
                    delete(where: ScopedSqlFilter) {
                      return enqueue(() => {
                        const plan = compiler.delete(where);
                        return async () => (await execute(plan)).changes;
                      });
                    },
                  });
                },
              });
              const result = await work(client);
              assertOpen();
              if (pending)
                throw new SqliteSafetyError('Unawaited SQLite operations');
              if (poisoned) throw failure;
              commitAttempted = true;
              outcome = 'unknown';
              try {
                await request('commit');
                outcome = 'committed';
              } catch (error) {
                if (
                  error instanceof Error &&
                  'transaction' in error &&
                  error.transaction === true
                )
                  outcome = 'not-committed';
                throw error;
              }
              return result;
            })(),
            operationMs,
            () => new SqliteTimeoutError('operation', outcome),
          );
        } catch (error) {
          primary = error;
          hasPrimary = true;
        } finally {
          closed = true;
        }
        const errors: unknown[] = [];
        if (wire) {
          try {
            await bounded(
              wire.request('cleanup'),
              cleanupMs,
              () => new SqliteTimeoutError('cleanup', outcome),
            );
          } catch (error) {
            errors.push(error);
          }
          if (errors.length || (outcome as string) === 'unknown') {
            try {
              await bounded(
                resource!.close(),
                cleanupMs,
                () => new SqliteTimeoutError('retirement', outcome),
              );
            } catch (error) {
              errors.push(error);
            }
          } else {
            try {
              await bounded(
                wire.terminate(),
                cleanupMs,
                () => new SqliteTimeoutError('worker exit', outcome),
              );
            } catch (error) {
              errors.push(error);
              void resource!.close().catch(() => {});
            }
          }
          release?.();
        }
        if (errors.length || (hasPrimary && commitAttempted))
          throw new SqliteLifecycleError(
            [...(hasPrimary ? [primary] : []), ...errors],
            outcome,
          );
        if (hasPrimary) throw primary;
        return value as T;
      });
    },
  });
}
