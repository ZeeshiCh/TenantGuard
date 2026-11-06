import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createTenantContext,
  type TenantContext,
  type TenantRoute,
  type DatabaseAdapter,
} from '@tenantguard/core';
import { validateUtf8Text } from '@tenantguard/scoped-sql/compiler';
import {
  PrismaSafetyError,
  validateModel,
  prismaCompiler,
  type PrismaModel,
  type PrismaFilter,
  type PrismaFindOptions,
  type ValidatedModel,
} from './guards.js';
import {
  prismaState,
  acquirePrismaClient,
  type PrismaResource,
} from './resource.js';
import { verifyPrismaModels, type PrismaRawTransaction } from './metadata.js';
export type PrismaCommitOutcome = 'not-committed' | 'committed' | 'unknown';
export class PrismaTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly commitOutcome: PrismaCommitOutcome = 'not-committed',
  ) {
    super(`Prisma ${phase} deadline exceeded`);
  }
}
export class PrismaLifecycleError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly commitOutcome: PrismaCommitOutcome,
  ) {
    super(errors, 'Prisma transaction or cleanup failed');
  }
}
function duration(value: number | undefined, fallback: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > 300000)
    throw new PrismaSafetyError('Invalid Prisma timeout');
  return n;
}
async function bounded<T>(promise: Promise<T>, ms: number, error: () => Error) {
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
export interface PrismaRepository<
  Row extends object = Record<string, unknown>,
> {
  find(
    where?: PrismaFilter,
    options?: PrismaFindOptions,
  ): Promise<readonly Row[]>;
  insert(row: PrismaFilter): Promise<number>;
  update(where: PrismaFilter, changes: PrismaFilter): Promise<number>;
  delete(where: PrismaFilter): Promise<number>;
}
export interface PrismaScopedClient {
  model<Row extends object = Record<string, unknown>>(
    alias: string,
  ): PrismaRepository<Row>;
}
export interface PrismaAdapterOptions {
  resolveResource(
    route: Readonly<TenantRoute>,
  ): PrismaResource | Promise<PrismaResource>;
  models: Readonly<Record<string, PrismaModel>>;
  maxWaitMs?: number;
  transactionTimeoutMs?: number;
  operationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  requestTimeoutMs?: number;
}
interface Delegate {
  findMany(args: object): Promise<Record<string, unknown>[]>;
  create(args: object): Promise<unknown>;
  updateMany(args: object): Promise<{ count: number }>;
  deleteMany(args: object): Promise<{ count: number }>;
}
const scopes = new AsyncLocalStorage<boolean>();
export function createPrismaAdapter(
  options: PrismaAdapterOptions,
): DatabaseAdapter<PrismaScopedClient> {
  const declared = Object.freeze(
    Object.entries(options.models).map(
      ([alias, model]) =>
        [
          alias,
          Object.freeze({ ...model, fields: Object.freeze([...model.fields]) }),
        ] as const,
    ),
  );
  if (!declared.length) throw new PrismaSafetyError('Prisma models required');
  const resolveResource = options.resolveResource,
    maxWait = duration(options.maxWaitMs, 5000),
    timeout = duration(options.transactionTimeoutMs, 30000),
    operationMs = duration(options.operationTimeoutMs, 25000),
    cleanupMs = duration(options.cleanupTimeoutMs, 5000),
    requestMs = duration(options.requestTimeoutMs, 5000);
  return Object.freeze({
    name: 'prisma',
    capabilities: Object.freeze({
      isolationModes: Object.freeze(['application-filter'] as const),
      transactions: true,
    }),
    async run<T>(
      context: Readonly<TenantContext>,
      inputRoute: Readonly<TenantRoute>,
      work: (client: PrismaScopedClient) => Promise<T>,
    ): Promise<T> {
      const trusted = createTenantContext(context);
      validateUtf8Text(trusted.tenantId);
      const route = Object.freeze({ ...inputRoute });
      if (scopes.getStore())
        throw new PrismaSafetyError(
          'Nested or detached Prisma scopes are forbidden',
        );
      if (
        route.tenantId !== trusted.tenantId ||
        route.adapter !== 'prisma' ||
        route.mode !== 'application-filter' ||
        route.status !== 'active' ||
        !route.resource ||
        !route.source ||
        !route.revision
      )
        throw new PrismaSafetyError('Invalid Prisma route');
      return scopes.run(true, async () => {
        let resource: PrismaResource | undefined,
          lease: Awaited<ReturnType<typeof acquirePrismaClient>> | undefined;
        let closed = false,
          failed = false,
          failure: unknown,
          pending = 0,
          tail: Promise<unknown> = Promise.resolve();
        let outcome: PrismaCommitOutcome = 'not-committed',
          commitReady = false,
          callbackFailed = false;
        const assertOpen = () => {
          if (closed || resource?.closed)
            throw new PrismaSafetyError(
              'Prisma facade used outside active scope',
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
              return bounded(
                Promise.resolve().then(() => {
                  assertOpen();
                  if (failed) throw failure;
                  return action();
                }),
                requestMs,
                () => new PrismaTimeoutError('request'),
              );
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
        let transaction: Promise<T> | undefined,
          result: T | undefined,
          primary: unknown,
          hasPrimary = false;
        try {
          result = await bounded(
            (async () => {
              resource = await bounded(
                Promise.resolve().then(() => resolveResource(route)),
                maxWait,
                () => new PrismaTimeoutError('resource resolution'),
              );
              assertOpen();
              const state = prismaState(resource!),
                models = new Map<string, ValidatedModel>(
                  declared.map(([alias, model]) => [
                    alias,
                    validateModel(model, state.datamodel),
                  ]),
                );
              const acquired = await bounded(
                acquirePrismaClient(resource!, () => !closed),
                maxWait,
                () => new PrismaTimeoutError('client acquisition'),
              );
              if (closed || resource!.closed) {
                await acquired.close();
                throw new PrismaSafetyError(
                  'Prisma scope expired during acquisition',
                );
              }
              lease = acquired;
              transaction = lease.client.$transaction(
                async (tx) => {
                  try {
                    assertOpen();
                    await verifyPrismaModels(
                      tx as PrismaRawTransaction,
                      state.provider,
                      [...models.values()],
                    );
                    assertOpen();
                    const client: PrismaScopedClient = Object.freeze({
                      model<Row extends object>(
                        alias: string,
                      ): PrismaRepository<Row> {
                        assertOpen();
                        const model = models.get(alias);
                        if (!model) {
                          failed = true;
                          failure ??= new PrismaSafetyError(
                            'Unknown Prisma model',
                          );
                          throw failure;
                        }
                        const delegate = (
                          tx as unknown as Record<string, Delegate>
                        )[model.delegate];
                        if (!delegate) {
                          failed = true;
                          failure ??= new PrismaSafetyError(
                            'Missing Prisma delegate',
                          );
                          throw failure;
                        }
                        const compiler = prismaCompiler(
                          model,
                          trusted.tenantId,
                        );
                        return Object.freeze({
                          find(
                            where: PrismaFilter = {},
                            findOptions: PrismaFindOptions = {},
                          ) {
                            return enqueue(() => {
                              const args = compiler.find(where, findOptions);
                              return async () => {
                                const rows = await delegate.findMany(args);
                                if (
                                  rows.some(
                                    (row) =>
                                      row[model.tenantField] !==
                                      trusted.tenantId,
                                  )
                                )
                                  throw new PrismaSafetyError(
                                    'Prisma returned a foreign tenant; schema or client contract violated',
                                  );
                                return rows as Row[];
                              };
                            });
                          },
                          insert(row: PrismaFilter) {
                            return enqueue(() => {
                              const args = compiler.create(row);
                              return async () => {
                                await delegate.create(args);
                                return 1;
                              };
                            });
                          },
                          update(where: PrismaFilter, changes: PrismaFilter) {
                            return enqueue(() => {
                              const args = compiler.update(where, changes);
                              return async () =>
                                (await delegate.updateMany(args)).count;
                            });
                          },
                          delete(where: PrismaFilter) {
                            return enqueue(() => {
                              const args = compiler.delete(where);
                              return async () =>
                                (await delegate.deleteMany(args)).count;
                            });
                          },
                        });
                      },
                    });
                    const value = await bounded(
                      Promise.resolve().then(() => work(client)),
                      operationMs,
                      () => new PrismaTimeoutError('work'),
                    );
                    assertOpen();
                    if (pending)
                      throw new PrismaSafetyError(
                        'Unawaited Prisma operations',
                      );
                    if (failed) throw failure;
                    commitReady = true;
                    outcome = 'unknown';
                    return value;
                  } catch (error) {
                    callbackFailed = true;
                    throw error;
                  } finally {
                    closed = true;
                  }
                },
                { maxWait, timeout, isolationLevel: 'Serializable' },
              );
              const value = await transaction;
              outcome = 'committed';
              return value;
            })(),
            maxWait + timeout + cleanupMs,
            () =>
              new PrismaTimeoutError(
                'transaction settlement',
                commitReady ? 'unknown' : 'not-committed',
              ),
          );
        } catch (error) {
          primary = error;
          hasPrimary = true;
        } finally {
          closed = true;
        }
        const errors: unknown[] = [];
        if (transaction) {
          try {
            await bounded(
              transaction.then(
                () => {},
                () => {},
              ),
              cleanupMs,
              () =>
                new PrismaTimeoutError(
                  'transaction cleanup',
                  commitReady ? 'unknown' : 'not-committed',
                ),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (hasPrimary && !commitReady && callbackFailed && !errors.length)
          outcome = 'not-committed';
        if (errors.length && resource) {
          try {
            await bounded(
              resource.close(),
              cleanupMs,
              () => new PrismaTimeoutError('retirement', outcome),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (lease) {
          try {
            await bounded(
              lease.close(),
              cleanupMs,
              () => new PrismaTimeoutError('disconnect', outcome),
            );
          } catch (error) {
            errors.push(error);
            if (resource) void resource.close().catch(() => {});
          }
        }
        if (errors.length || (hasPrimary && commitReady))
          throw new PrismaLifecycleError(
            [...(hasPrimary ? [primary] : []), ...errors],
            outcome,
          );
        if (hasPrimary) throw primary;
        return result as T;
      });
    },
  });
}
