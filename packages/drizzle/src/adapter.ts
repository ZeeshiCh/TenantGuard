import { AsyncLocalStorage } from 'node:async_hooks';
import { asc, desc, type SQL } from 'drizzle-orm';
import type { PgTable, PgColumn } from 'drizzle-orm/pg-core';
import type { MySqlTable, MySqlColumn } from 'drizzle-orm/mysql-core';
import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantContext,
  type TenantRoute,
} from '@tenantguard/core';
import { validateUtf8Text } from '@tenantguard/scoped-sql/compiler';
import {
  DrizzleSafetyError,
  validateDrizzleTable,
  drizzleCompiler,
  type DrizzleTable,
  type DrizzleFilter,
  type DrizzleFindOptions,
  type ValidatedDrizzleTable,
} from './guards.js';
import {
  acquireDrizzle,
  bounded,
  duration,
  DrizzleTimeoutError,
  DrizzleLifecycleError,
  type DrizzleResource,
  type DrizzleCommitOutcome,
  type DrizzleWire,
} from './resource.js';
import { verifyDrizzleTables } from './metadata.js';
export interface DrizzleRepository<
  Row extends object = Record<string, unknown>,
> {
  find(
    where?: DrizzleFilter,
    options?: DrizzleFindOptions,
  ): Promise<readonly Row[]>;
  insert(row: DrizzleFilter): Promise<number>;
  update(where: DrizzleFilter, changes: DrizzleFilter): Promise<number>;
  delete(where: DrizzleFilter): Promise<number>;
}
export interface DrizzleScopedClient {
  table<Row extends object = Record<string, unknown>>(
    alias: string,
  ): DrizzleRepository<Row>;
}
export interface DrizzleAdapterOptions {
  resolveResource(
    route: Readonly<TenantRoute>,
  ): DrizzleResource | Promise<DrizzleResource>;
  tables: Readonly<Record<string, DrizzleTable>>;
  acquireTimeoutMs?: number;
  requestTimeoutMs?: number;
  operationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}
async function findRows(
  wire: DrizzleWire,
  spec: ValidatedDrizzleTable,
  plan: ReturnType<ReturnType<typeof drizzleCompiler>['find']>,
) {
  const order = plan.direction === 'asc' ? asc(plan.order) : desc(plan.order);
  if (wire.provider === 'postgresql')
    return wire.db
      .select(spec.fields as Record<string, PgColumn>)
      .from(spec.table as PgTable)
      .where(plan.where)
      .orderBy(order)
      .limit(plan.limit)
      .offset(plan.offset);
  return wire.db
    .select(spec.fields as Record<string, MySqlColumn>)
    .from(spec.table as MySqlTable)
    .where(plan.where)
    .orderBy(order)
    .limit(plan.limit)
    .offset(plan.offset);
}
async function write(
  wire: DrizzleWire,
  spec: ValidatedDrizzleTable,
  kind: 'insert' | 'update' | 'delete',
  data?: Record<string, unknown>,
  where?: SQL,
) {
  if (wire.provider === 'postgresql') {
    const table = spec.table as PgTable;
    const result = await (kind === 'insert'
      ? wire.db.insert(table).values(data!)
      : kind === 'update'
        ? wire.db.update(table).set(data!).where(where)
        : wire.db.delete(table).where(where));
    return result.rowCount ?? 0;
  }
  const table = spec.table as MySqlTable;
  const [result] = await (kind === 'insert'
    ? wire.db.insert(table).values(data!)
    : kind === 'update'
      ? wire.db.update(table).set(data!).where(where)
      : wire.db.delete(table).where(where));
  return result.affectedRows;
}
const scopes = new AsyncLocalStorage<boolean>();
export function createDrizzleAdapter(
  options: DrizzleAdapterOptions,
): DatabaseAdapter<DrizzleScopedClient> {
  const tables = new Map(
    Object.entries(options.tables).map(([alias, table]) => [
      alias,
      validateDrizzleTable(table),
    ]),
  );
  if (!tables.size) throw new DrizzleSafetyError('Drizzle tables required');
  const resolveResource = options.resolveResource,
    acquireMs = duration(options.acquireTimeoutMs, 5000),
    requestMs = duration(options.requestTimeoutMs, 5000),
    operationMs = duration(options.operationTimeoutMs, 30000),
    cleanupMs = duration(options.cleanupTimeoutMs, 5000);
  return Object.freeze({
    name: 'drizzle',
    capabilities: Object.freeze({
      isolationModes: Object.freeze(['application-filter'] as const),
      transactions: true,
    }),
    async run<T>(
      context: Readonly<TenantContext>,
      inputRoute: Readonly<TenantRoute>,
      work: (client: DrizzleScopedClient) => Promise<T>,
    ): Promise<T> {
      const trusted = createTenantContext(context);
      validateUtf8Text(trusted.tenantId);
      const route = Object.freeze({ ...inputRoute });
      if (scopes.getStore())
        throw new DrizzleSafetyError(
          'Nested or detached Drizzle scopes are forbidden',
        );
      if (
        route.tenantId !== trusted.tenantId ||
        route.adapter !== 'drizzle' ||
        route.mode !== 'application-filter' ||
        route.status !== 'active' ||
        !route.resource ||
        !route.source ||
        !route.revision
      )
        throw new DrizzleSafetyError('Invalid Drizzle route');
      return scopes.run(true, async () => {
        let resource: DrizzleResource | undefined,
          lease: Awaited<ReturnType<typeof acquireDrizzle>> | undefined,
          closed = false,
          failed = false,
          failure: unknown,
          pending = 0,
          tail: Promise<unknown> = Promise.resolve();
        let outcome: DrizzleCommitOutcome = 'not-committed',
          commitAttempted = false,
          detach: (() => void) | undefined;
        let fatalReject!: (error: Error) => void;
        const fatal = new Promise<never>((_, reject) => {
          fatalReject = reject;
        });
        const assertOpen = () => {
          if (closed || resource?.closed)
            throw new DrizzleSafetyError(
              'Drizzle facade used outside active scope',
            );
        };
        const request = <V>(action: () => Promise<V>) => {
          assertOpen();
          return bounded(
            Promise.resolve().then(() => {
              assertOpen();
              return action();
            }),
            requestMs,
            () => new DrizzleTimeoutError('request', outcome),
          );
        };
        const enqueue = <V>(prepare: () => () => Promise<V>): Promise<V> => {
          let action: () => Promise<V>;
          try {
            assertOpen();
            if (failed) throw failure;
            action = prepare();
          } catch (error) {
            failed = true;
            failure ??= error;
            const rejection = Promise.reject<never>(error);
            void rejection.catch(() => {});
            return rejection;
          }
          pending++;
          const task = tail
            .then(() => {
              assertOpen();
              if (failed) throw failure;
              return request(action);
            })
            .catch((error) => {
              failed = true;
              failure ??= error;
              throw error;
            })
            .finally(() => {
              pending--;
            });
          tail = task.catch(() => {});
          return task;
        };
        let result: T | undefined,
          primary: unknown,
          hasPrimary = false;
        try {
          result = await bounded(
            Promise.race([
              (async () => {
                resource = await bounded(
                  Promise.resolve().then(() => resolveResource(route)),
                  acquireMs,
                  () => new DrizzleTimeoutError('resource resolution'),
                );
                assertOpen();
                const acquired = await bounded(
                  acquireDrizzle(resource!, () => !closed),
                  acquireMs,
                  () => new DrizzleTimeoutError('acquisition'),
                );
                if (closed || resource!.closed) {
                  acquired.destroy();
                  await acquired.close();
                  throw new DrizzleSafetyError(
                    'Drizzle scope expired during acquisition',
                  );
                }
                lease = acquired;
                const wire = lease.wire;
                detach = wire.onError((error) => {
                  failed = true;
                  failure ??= error;
                  fatalReject(error);
                });
                assertOpen();
                if (failed) throw failure;
                await request(() => wire.begin());
                await request(() =>
                  verifyDrizzleTables(wire, [...tables.values()]),
                );
                assertOpen();
                const client: DrizzleScopedClient = Object.freeze({
                  table<Row extends object>(
                    alias: string,
                  ): DrizzleRepository<Row> {
                    assertOpen();
                    const spec = tables.get(alias);
                    if (!spec) {
                      failed = true;
                      failure ??= new DrizzleSafetyError(
                        'Unknown Drizzle table',
                      );
                      throw failure;
                    }
                    const compiler = drizzleCompiler(spec, trusted.tenantId);
                    return Object.freeze({
                      find(
                        where: DrizzleFilter = {},
                        findOptions: DrizzleFindOptions = {},
                      ) {
                        return enqueue(() => {
                          const plan = compiler.find(where, findOptions);
                          return async () => {
                            const rows = await findRows(wire, spec, plan);
                            if (
                              rows.some(
                                (row) =>
                                  row[spec.tenantColumn] !== trusted.tenantId,
                              )
                            )
                              throw new DrizzleSafetyError(
                                'Drizzle returned a foreign tenant',
                              );
                            return rows as Row[];
                          };
                        });
                      },
                      insert(row: DrizzleFilter) {
                        return enqueue(() => {
                          const data = compiler.insert(row);
                          return () => write(wire, spec, 'insert', data);
                        });
                      },
                      update(where: DrizzleFilter, changes: DrizzleFilter) {
                        return enqueue(() => {
                          const plan = compiler.update(where, changes);
                          return () =>
                            write(wire, spec, 'update', plan.data, plan.where);
                        });
                      },
                      delete(where: DrizzleFilter) {
                        return enqueue(() => {
                          const condition = compiler.delete(where);
                          return () =>
                            write(wire, spec, 'delete', undefined, condition);
                        });
                      },
                    });
                  },
                });
                const value = await work(client);
                assertOpen();
                if (pending)
                  throw new DrizzleSafetyError('Unawaited Drizzle operations');
                if (failed) throw failure;
                commitAttempted = true;
                outcome = 'unknown';
                await request(() => wire.commit());
                outcome = 'committed';
                return value;
              })(),
              fatal,
            ]),
            operationMs,
            () => new DrizzleTimeoutError('operation', outcome),
          );
        } catch (error) {
          primary = error;
          hasPrimary = true;
        } finally {
          closed = true;
        }
        const errors: unknown[] = [];
        if (lease) {
          if (hasPrimary) {
            try {
              await bounded(
                lease.wire.rollback(),
                cleanupMs,
                () => new DrizzleTimeoutError('rollback', outcome),
              );
            } catch (error) {
              errors.push(error);
              lease.destroy();
            }
          }
          if (errors.length || (outcome as string) === 'unknown')
            lease.destroy();
          try {
            await bounded(
              lease.close(),
              cleanupMs,
              () => new DrizzleTimeoutError('connection closure', outcome),
            );
          } catch (error) {
            errors.push(error);
            lease.destroy();
            void resource!.close().catch(() => {});
          }
          detach?.();
        }
        if (errors.length || (hasPrimary && commitAttempted))
          throw new DrizzleLifecycleError(
            [...(hasPrimary ? [primary] : []), ...errors],
            outcome,
          );
        if (hasPrimary) throw primary;
        return result as T;
      });
    },
  });
}
