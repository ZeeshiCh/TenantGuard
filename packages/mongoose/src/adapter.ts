import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantContext,
  type TenantRoute,
} from '@tenantguard/core';
import {
  MongoSafetyError,
  owner,
  projection,
  pipeline,
  bounded,
  sort,
  unicode,
} from '@tenantguard/scoped-mongo';
import {
  mongooseFields,
  type MongooseFilter,
  type MongooseFindOptions,
} from './guards.js';
import {
  mongooseState,
  duration,
  deadline,
  MongooseTimeoutError,
  MongooseLifecycleError,
  type MongooseResource,
  type MongooseSession,
  type MongooseCommitOutcome,
  type OperationOptions,
} from './resource.js';
export interface MongooseRepository<
  Row extends object = Record<string, unknown>,
> {
  find(
    where?: MongooseFilter,
    options?: MongooseFindOptions,
  ): Promise<readonly Row[]>;
  insert(row: MongooseFilter): Promise<number>;
  update(where: MongooseFilter, changes: MongooseFilter): Promise<number>;
  delete(where: MongooseFilter): Promise<number>;
  aggregate<Result extends object = Record<string, unknown>>(
    stages: readonly unknown[],
  ): Promise<readonly Result[]>;
}
export interface MongooseScopedClient {
  model<Row extends object = Record<string, unknown>>(
    alias: string,
  ): MongooseRepository<Row>;
}
export interface MongooseAdapterOptions {
  resolveResource(
    route: Readonly<TenantRoute>,
  ): MongooseResource | Promise<MongooseResource>;
  acquireTimeoutMs?: number;
  operationTimeoutMs?: number;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}
const scopes = new AsyncLocalStorage<boolean>();
export function createMongooseAdapter(
  options: MongooseAdapterOptions,
): DatabaseAdapter<MongooseScopedClient> {
  const resolveResource = options.resolveResource,
    acquireMs = duration(options.acquireTimeoutMs, 5000),
    operationMs = duration(options.operationTimeoutMs, 30000),
    requestMs = duration(options.requestTimeoutMs, 5000),
    cleanupMs = duration(options.cleanupTimeoutMs, 5000);
  return Object.freeze({
    name: 'mongoose',
    capabilities: Object.freeze({
      isolationModes: Object.freeze(['application-filter'] as const),
      transactions: true,
    }),
    async run<T>(
      context: Readonly<TenantContext>,
      inputRoute: Readonly<TenantRoute>,
      work: (client: MongooseScopedClient) => Promise<T>,
    ): Promise<T> {
      const trusted = createTenantContext(context);
      unicode(trusted.tenantId);
      const route = Object.freeze({ ...inputRoute });
      if (scopes.getStore())
        throw new MongoSafetyError(
          'Nested or detached Mongoose scopes are forbidden',
        );
      if (
        route.tenantId !== trusted.tenantId ||
        route.adapter !== 'mongoose' ||
        route.mode !== 'application-filter' ||
        route.status !== 'active' ||
        !route.source ||
        !route.resource ||
        !route.revision
      )
        throw new MongoSafetyError('Invalid Mongoose route');
      return scopes.run(true, async () => {
        let resource: MongooseResource | undefined,
          session: MongooseSession | undefined,
          closed = false,
          failed = false,
          failure: unknown,
          pending = 0,
          tail: Promise<unknown> = Promise.resolve(),
          outcome: MongooseCommitOutcome = 'not-committed',
          commitAttempted = false,
          detach: (() => void) | undefined;
        const active = new Set<Promise<unknown>>();
        let rejectFatal!: (error: Error) => void;
        const fatal = new Promise<never>((_, reject) => {
          rejectFatal = reject;
        });
        const assertOpen = () => {
          if (closed || resource?.closed)
            throw new MongoSafetyError(
              'Mongoose facade used outside active scope',
            );
        };
        const tracked = <V>(
          action: () => Promise<V>,
          limit = requestMs,
          phase = 'request',
        ) => {
          assertOpen();
          const promise = Promise.resolve().then(() => {
            assertOpen();
            return action();
          });
          active.add(promise);
          void promise.then(
            () => active.delete(promise),
            () => active.delete(promise),
          );
          return deadline(
            promise,
            limit,
            () => new MongooseTimeoutError(phase, outcome),
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
              return action();
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
          result = await deadline(
            Promise.race([
              (async () => {
                resource = await deadline(
                  Promise.resolve().then(() => resolveResource(route)),
                  acquireMs,
                  () => new MongooseTimeoutError('resource resolution'),
                );
                assertOpen();
                const state = mongooseState(resource!),
                  runtime = state.runtime;
                detach = runtime.onError((error) => {
                  failed = true;
                  failure ??= error;
                  rejectFatal(error);
                });
                assertOpen();
                if (failed) throw failure;
                await tracked(() => runtime.connect(), acquireMs, 'connection');
                assertOpen();
                const hello = await tracked(() => runtime.hello());
                if (typeof hello.setName !== 'string')
                  throw new MongoSafetyError('Mongoose replica set required');
                for (const model of state.models.values())
                  await tracked(() => runtime.collection(model.spec));
                // Track acquisition itself: a session arriving after expiry must still be ended before reuse.
                await tracked(async () => {
                  session = await runtime.startSession();
                  return session;
                });
                assertOpen();
                session!.startTransaction({
                  readConcern: { level: 'snapshot' },
                  writeConcern: { w: 'majority' },
                  readPreference: 'primary',
                  maxCommitTimeMS: requestMs,
                });
                const client: MongooseScopedClient = Object.freeze({
                  model<Row extends object>(
                    alias: string,
                  ): MongooseRepository<Row> {
                    assertOpen();
                    const declaration = state.models.get(alias);
                    if (!declaration) {
                      failed = true;
                      failure ??= new MongoSafetyError(
                        'Unknown Mongoose model',
                      );
                      throw failure;
                    }
                    const spec = declaration.spec,
                      model = runtime.model(alias);
                    const common = (): OperationOptions => ({
                      session: session!,
                      maxTimeMS: requestMs,
                      collation: { locale: 'simple' },
                    });
                    const where = (input: MongooseFilter, write = false) => {
                      const data = mongooseFields(input, declaration);
                      if (
                        write &&
                        !Object.keys(data).some(
                          (key) => key !== spec.tenantField,
                        )
                      )
                        throw new MongoSafetyError(
                          'Writes require a non-tenant filter',
                        );
                      return owner(spec, trusted.tenantId, data);
                    };
                    return Object.freeze({
                      find(
                        filter: MongooseFilter = {},
                        findOptions: MongooseFindOptions = {},
                      ) {
                        return enqueue(() => {
                          if (
                            !findOptions ||
                            Object.keys(findOptions).some(
                              (key) => !['limit', 'sort'].includes(key),
                            )
                          )
                            throw new MongoSafetyError(
                              'Unsupported find option',
                            );
                          const predicate = where(filter),
                            limit = bounded(findOptions.limit),
                            order =
                              findOptions.sort === undefined
                                ? undefined
                                : sort(findOptions.sort, spec.fields);
                          return async () => {
                            const rows = await tracked(() =>
                              model.find(predicate, projection(spec), {
                                ...common(),
                                limit,
                                ...(order ? { sort: order } : {}),
                              }),
                            );
                            if (
                              rows.some(
                                (row) =>
                                  row[spec.tenantField] !== trusted.tenantId,
                              )
                            )
                              throw new MongoSafetyError(
                                'Mongoose returned foreign ownership',
                              );
                            return rows as Row[];
                          };
                        });
                      },
                      insert(row: MongooseFilter) {
                        return enqueue(() => {
                          const data = mongooseFields(row, declaration);
                          if (
                            Object.hasOwn(data, spec.tenantField) &&
                            data[spec.tenantField] !== trusted.tenantId
                          )
                            throw new MongoSafetyError('Foreign tenant insert');
                          data[spec.tenantField] = trusted.tenantId;
                          if (!Object.hasOwn(data, spec.idField))
                            throw new MongoSafetyError('ID required');
                          return async () => {
                            await tracked(() => model.insert(data, common()));
                            return 1;
                          };
                        });
                      },
                      update(filter: MongooseFilter, changes: MongooseFilter) {
                        return enqueue(() => {
                          const predicate = where(filter, true),
                            data = mongooseFields(changes, declaration);
                          if (
                            !Object.keys(data).length ||
                            [spec.idField, spec.tenantField, '_id'].some(
                              (key) => Object.hasOwn(data, key),
                            )
                          )
                            throw new MongoSafetyError(
                              'Tenant and ID fields are immutable',
                            );
                          return () =>
                            tracked(() =>
                              model.update(predicate, data, common()),
                            );
                        });
                      },
                      delete(filter: MongooseFilter) {
                        return enqueue(() => {
                          const predicate = where(filter, true);
                          return () =>
                            tracked(() => model.delete(predicate, common()));
                        });
                      },
                      aggregate<Result extends object>(
                        stages: readonly unknown[],
                      ) {
                        return enqueue(() => {
                          const safe = pipeline(spec, trusted.tenantId, stages);
                          return () =>
                            tracked(() =>
                              model.aggregate(safe, common()),
                            ) as Promise<Result[]>;
                        });
                      },
                    });
                  },
                });
                const value = await work(client);
                assertOpen();
                if (pending)
                  throw new MongoSafetyError('Unawaited Mongoose operations');
                if (failed) throw failure;
                commitAttempted = true;
                outcome = 'unknown';
                await tracked(() => session!.commitTransaction());
                outcome = 'committed';
                return value;
              })(),
              fatal,
            ]),
            operationMs,
            () => new MongooseTimeoutError('operation', outcome),
          );
        } catch (error) {
          primary = error;
          hasPrimary = true;
        } finally {
          closed = true;
        }
        const errors: unknown[] = [];
        try {
          await deadline(
            (async () => {
              await Promise.allSettled([...active]);
              if (session?.inTransaction()) await session.abortTransaction();
              await session?.endSession();
            })(),
            cleanupMs,
            () => new MongooseTimeoutError('session cleanup', outcome),
          );
        } catch (error) {
          errors.push(error);
        }
        if ((errors.length || (outcome as string) === 'unknown') && resource) {
          try {
            await deadline(
              resource.close(),
              cleanupMs,
              () => new MongooseTimeoutError('connection retirement', outcome),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        detach?.();
        if (errors.length || (hasPrimary && commitAttempted))
          throw new MongooseLifecycleError(
            [...(hasPrimary ? [primary] : []), ...errors],
            outcome,
          );
        if (hasPrimary) throw primary;
        return result as T;
      });
    },
  });
}
