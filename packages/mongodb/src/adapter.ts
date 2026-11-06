import { AsyncLocalStorage } from 'node:async_hooks';
import {
  MongoClient,
  type ClientSession,
  type MongoClientOptions,
  type Document,
} from 'mongodb';
import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantRoute,
  type TenantContext,
} from '@tenantguard/core';
import {
  MongoSafetyError,
  type MongoCollection,
  type MongoValue,
  manifest,
  identifier,
  unicode,
  fields,
  owner,
  projection,
  pipeline,
  bounded,
  sort,
} from './guards.js';
export class MongoTimeoutError extends Error {}
export class MongoLifecycleError extends AggregateError {
  constructor(
    errors: unknown[],
    readonly commitOutcome: 'not-committed' | 'committed' | 'unknown',
  ) {
    super(errors, 'MongoDB scope failed during commit or cleanup');
  }
}
function duration(n: number | undefined, fallback: number): number {
  if (n === undefined) return fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > 300000)
    throw new MongoSafetyError('Invalid timeout');
  return n;
}
async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new MongoTimeoutError('MongoDB scope deadline exceeded')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export interface MongoResource {
  /** Infrastructure only. Bypasses all facade guarantees. */
  readonly client: MongoClient;
  readonly database: string;
  readonly closed: boolean;
  close(): Promise<void>;
}
export function createMongoResource(options: {
  uri: string;
  database: string;
  clientOptions?: MongoClientOptions;
}): MongoResource {
  const database = identifier(options.database);
  const config = options.clientOptions ?? {};
  const client = new MongoClient(options.uri, {
    ...config,
    maxPoolSize: duration(config.maxPoolSize, 10),
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 5000,
    waitQueueTimeoutMS: 5000,
    retryReads: false,
    retryWrites: false,
  });
  let closed = false,
    closing: Promise<void> | undefined;
  return Object.freeze({
    client,
    database,
    get closed() {
      return closed;
    },
    close() {
      closed = true;
      return (closing ??= client.close(true));
    },
  });
}
export interface MongoRepository<Row = Record<string, unknown>> {
  find(
    where?: Readonly<Record<string, MongoValue>>,
    options?: { limit?: number; sort?: Readonly<Record<string, 1 | -1>> },
  ): Promise<readonly Row[]>;
  insert(row: Readonly<Record<string, MongoValue>>): Promise<number>;
  update(
    where: Readonly<Record<string, MongoValue>>,
    changes: Readonly<Record<string, MongoValue>>,
  ): Promise<number>;
  delete(where: Readonly<Record<string, MongoValue>>): Promise<number>;
  aggregate<Result = Record<string, unknown>>(
    stages: readonly unknown[],
  ): Promise<readonly Result[]>;
}
export interface MongoScopedClient {
  collection<Row = Record<string, unknown>>(
    alias: string,
  ): MongoRepository<Row>;
}
export interface MongoAdapterOptions {
  resolveResource(
    route: Readonly<TenantRoute>,
  ): MongoResource | Promise<MongoResource>;
  collections: Readonly<Record<string, MongoCollection>>;
  operationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  requestTimeoutMs?: number;
}
const scope = new AsyncLocalStorage<boolean>();
export function createMongoAdapter(
  options: MongoAdapterOptions,
): DatabaseAdapter<MongoScopedClient> {
  const specs = new Map(
    Object.entries(options.collections).map(([key, value]) => [
      identifier(key),
      manifest(value),
    ]),
  );
  if (!specs.size) throw new MongoSafetyError('Collections required');
  const operationMs = duration(options.operationTimeoutMs, 30000),
    cleanupMs = duration(options.cleanupTimeoutMs, 5000),
    requestMs = duration(options.requestTimeoutMs, 5000);
  const resolveResource = options.resolveResource;
  return Object.freeze({
    name: 'mongodb',
    capabilities: Object.freeze({
      isolationModes: Object.freeze(['application-filter'] as const),
      transactions: true,
    }),
    async run<T>(
      context: Readonly<TenantContext>,
      inputRoute: Readonly<TenantRoute>,
      work: (client: MongoScopedClient) => Promise<T>,
    ): Promise<T> {
      const trusted = createTenantContext(context);
      unicode(trusted.tenantId);
      const route = Object.freeze({ ...inputRoute });
      if (scope.getStore())
        throw new MongoSafetyError(
          'Nested or detached MongoDB scopes are forbidden',
        );
      if (
        route.tenantId !== trusted.tenantId ||
        route.adapter !== 'mongodb' ||
        route.mode !== 'application-filter' ||
        route.status !== 'active' ||
        !route.resource ||
        !route.revision ||
        !route.source
      )
        throw new MongoSafetyError('Invalid MongoDB route');
      return scope.run(true, async () => {
        let closed = false,
          resource: MongoResource | undefined,
          session: ClientSession | undefined;
        let failure: unknown,
          failed = false,
          outcome: 'not-committed' | 'committed' | 'unknown' = 'not-committed';
        let commitAttempted = false;
        let tail: Promise<unknown> = Promise.resolve(),
          pending = 0;
        const active = new Set<Promise<unknown>>();
        const assertOpen = () => {
          if (closed || resource?.closed)
            throw new MongoSafetyError(
              'MongoDB facade used outside active scope',
            );
        };
        const native = <V>(fn: () => Promise<V>): Promise<V> => {
          assertOpen();
          const p = Promise.resolve().then(() => {
            assertOpen();
            return fn();
          });
          active.add(p);
          void p.then(
            () => active.delete(p),
            () => active.delete(p),
          );
          return deadline(p, requestMs);
        };
        const queue = <V>(prepare: () => () => Promise<V>): Promise<V> => {
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
        let primary: unknown,
          hasPrimary = false,
          result: T | undefined;
        try {
          result = await deadline(
            (async () => {
              // Late resolver results must not create sessions after a scope expires.
              resource = await resolveResource(route);
              assertOpen();
              const db = resource.client.db(resource.database);
              const hello = await native(() =>
                db.admin().command({ hello: 1, maxTimeMS: requestMs }),
              );
              assertOpen();
              if (typeof hello.setName !== 'string')
                throw new MongoSafetyError('MongoDB replica set required');
              for (const spec of specs.values()) {
                const info = await native(() =>
                  db
                    .listCollections(
                      { name: spec.collection },
                      { nameOnly: false, maxTimeMS: requestMs },
                    )
                    .toArray(),
                );
                assertOpen();
                if (
                  info.length !== 1 ||
                  info[0]!.type !== 'collection' ||
                  info[0]!.options?.capped ||
                  info[0]!.options?.timeseries
                )
                  throw new MongoSafetyError(
                    'Only existing ordinary collections are supported',
                  );
              }
              session = resource.client.startSession();
              session.startTransaction({
                readConcern: { level: 'snapshot' },
                writeConcern: { w: 'majority' },
                readPreference: 'primary',
                maxCommitTimeMS: requestMs,
              });
              const client: MongoScopedClient = Object.freeze({
                collection<Row>(alias: string): MongoRepository<Row> {
                  assertOpen();
                  const spec = specs.get(alias);
                  if (!spec) {
                    failed = true;
                    failure ??= new MongoSafetyError('Unknown collection');
                    throw failure;
                  }
                  const collection = db.collection(spec.collection);
                  const common = () => ({
                    session: session!,
                    maxTimeMS: requestMs,
                    collation: { locale: 'simple' },
                  });
                  const writeFilter = (where: unknown) => {
                    const data = fields(where, spec.fields);
                    if (!Object.keys(data).some((k) => k !== spec.tenantField))
                      throw new MongoSafetyError(
                        'Writes require a non-tenant filter',
                      );
                    return owner(spec, trusted.tenantId, data);
                  };
                  return Object.freeze({
                    find(
                      where = {},
                      findOptions: {
                        limit?: number;
                        sort?: Readonly<Record<string, 1 | -1>>;
                      } = {},
                    ) {
                      return queue(() => {
                        const filter = owner(spec, trusted.tenantId, where),
                          limit = bounded(findOptions.limit),
                          order =
                            findOptions.sort === undefined
                              ? undefined
                              : sort(findOptions.sort, spec.fields);
                        return () =>
                          native(() =>
                            collection
                              .find(filter, {
                                ...common(),
                                projection: projection(spec),
                                limit,
                                ...(order ? { sort: order } : {}),
                              })
                              .toArray(),
                          ) as Promise<Row[]>;
                      });
                    },
                    insert(row: Readonly<Record<string, MongoValue>>) {
                      return queue(() => {
                        const data = fields(row, spec.fields);
                        if (
                          Object.hasOwn(data, spec.tenantField) &&
                          data[spec.tenantField] !== trusted.tenantId
                        )
                          throw new MongoSafetyError('Foreign tenant insert');
                        data[spec.tenantField] = trusted.tenantId;
                        if (!Object.hasOwn(data, spec.idField))
                          throw new MongoSafetyError('ID required');
                        return async () => {
                          await native(() =>
                            collection.insertOne(data, {
                              session: session!,
                              maxTimeMS: requestMs,
                              bypassDocumentValidation: false,
                            }),
                          );
                          return 1;
                        };
                      });
                    },
                    update(
                      where: Readonly<Record<string, MongoValue>>,
                      changes: Readonly<Record<string, MongoValue>>,
                    ) {
                      return queue(() => {
                        const filter = writeFilter(where),
                          data = fields(changes, spec.fields);
                        if (
                          !Object.keys(data).length ||
                          [spec.tenantField, spec.idField, '_id'].some((k) =>
                            Object.hasOwn(data, k),
                          )
                        )
                          throw new MongoSafetyError(
                            'Ownership and ID fields are immutable',
                          );
                        return async () =>
                          (
                            await native(() =>
                              collection.updateMany(
                                filter,
                                { $set: data },
                                {
                                  ...common(),
                                  upsert: false,
                                  bypassDocumentValidation: false,
                                },
                              ),
                            )
                          ).matchedCount;
                      });
                    },
                    delete(where: Readonly<Record<string, MongoValue>>) {
                      return queue(() => {
                        const filter = writeFilter(where);
                        return async () =>
                          (
                            await native(() =>
                              collection.deleteMany(filter, common()),
                            )
                          ).deletedCount;
                      });
                    },
                    aggregate<Result>(stages: readonly unknown[]) {
                      return queue(() => {
                        const safe = pipeline(spec, trusted.tenantId, stages);
                        return () =>
                          native(() =>
                            collection
                              .aggregate<Document>(safe, {
                                ...common(),
                                allowDiskUse: false,
                              })
                              .toArray(),
                          ) as Promise<Result[]>;
                      });
                    },
                  });
                },
              });
              const value = await work(client);
              assertOpen();
              if (pending)
                throw new MongoSafetyError('Unawaited MongoDB operations');
              if (failed) throw failure;
              commitAttempted = true;
              outcome = 'unknown';
              await native(() => session!.commitTransaction());
              outcome = 'committed';
              return value;
            })(),
            operationMs,
          );
        } catch (error) {
          primary = error;
          hasPrimary = true;
        } finally {
          closed = true;
        }
        const cleanupErrors: unknown[] = [];
        try {
          await deadline(
            (async () => {
              await Promise.allSettled([...active]);
              if (session?.inTransaction()) await session.abortTransaction();
              await session?.endSession();
            })(),
            cleanupMs,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (
          (cleanupErrors.length || (outcome as string) === 'unknown') &&
          resource
        ) {
          try {
            await deadline(resource.close(), cleanupMs);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length || (hasPrimary && commitAttempted))
          throw new MongoLifecycleError(
            [...(hasPrimary ? [primary] : []), ...cleanupErrors],
            outcome,
          );
        if (hasPrimary) throw primary;
        return result as T;
      });
    },
  });
}
