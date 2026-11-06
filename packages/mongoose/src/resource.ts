import {
  Mongoose,
  type ConnectOptions,
  type ClientSession,
  type Model,
  type PipelineStage,
} from 'mongoose';
import { identifier, type MongoCollection } from '@tenantguard/scoped-mongo';
import {
  validateMongooseModel,
  type MongooseModel,
  type ValidatedMongooseModel,
  type MongooseValue,
} from './guards.js';
export type MongooseCommitOutcome = 'not-committed' | 'committed' | 'unknown';
export class MongooseTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly commitOutcome: MongooseCommitOutcome = 'not-committed',
  ) {
    super(`Mongoose ${phase} deadline exceeded`);
  }
}
export class MongooseLifecycleError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly commitOutcome: MongooseCommitOutcome,
  ) {
    super(errors, 'Mongoose transaction or cleanup failed');
  }
}
export function duration(value: number | undefined, fallback: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > 300000)
    throw new TypeError('Invalid Mongoose timeout');
  return n;
}
export async function deadline<T>(
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
export interface MongooseSession {
  startTransaction(options: {
    readConcern: { level: 'snapshot' };
    writeConcern: { w: 'majority' };
    readPreference: 'primary';
    maxCommitTimeMS: number;
  }): void;
  inTransaction(): boolean;
  commitTransaction(): Promise<void>;
  abortTransaction(): Promise<void>;
  endSession(): Promise<void>;
}
export interface OperationOptions {
  session: MongooseSession;
  maxTimeMS: number;
  collation: { locale: 'simple' };
}
export interface MongooseOperations {
  find(
    filter: Record<string, unknown>,
    projection: Record<string, number>,
    options: OperationOptions & {
      limit: number;
      sort?: Record<string, 1 | -1>;
    },
  ): Promise<readonly Record<string, unknown>[]>;
  insert(
    data: Record<string, MongooseValue>,
    options: OperationOptions,
  ): Promise<void>;
  update(
    filter: Record<string, unknown>,
    data: Record<string, MongooseValue>,
    options: OperationOptions,
  ): Promise<number>;
  delete(
    filter: Record<string, unknown>,
    options: OperationOptions,
  ): Promise<number>;
  aggregate(
    stages: Record<string, unknown>[],
    options: OperationOptions,
  ): Promise<readonly Record<string, unknown>[]>;
}
export interface MongooseRuntime {
  connect(): Promise<void>;
  hello(): Promise<{ setName?: unknown }>;
  collection(spec: MongoCollection): Promise<void>;
  startSession(): Promise<MongooseSession>;
  model(alias: string): MongooseOperations;
  close(): Promise<void>;
  onError(listener: (error: Error) => void): () => void;
}
export interface MongooseResource {
  readonly closed: boolean;
  close(): Promise<void>;
}
interface State {
  readonly models: ReadonlyMap<string, ValidatedMongooseModel>;
  readonly runtime: MongooseRuntime;
  closed: boolean;
  closing?: Promise<void>;
}
const resources = new WeakMap<MongooseResource, State>();
/** Internal protocol for fault injection, not exported from the public package. */
export function ownedMongooseResource(
  models: Readonly<Record<string, MongooseModel>>,
  runtime: MongooseRuntime,
): MongooseResource {
  const validated = new Map(
    Object.entries(models).map(([alias, definition]) => [
      identifier(alias),
      validateMongooseModel(definition),
    ]),
  );
  if (!validated.size) throw new TypeError('Mongoose models required');
  const state: State = { models: validated, runtime, closed: false };
  const resource: MongooseResource = Object.freeze({
    get closed() {
      return state.closed;
    },
    close() {
      state.closed = true;
      return (state.closing ??= runtime.close());
    },
  });
  resources.set(resource, state);
  return resource;
}
export function mongooseState(resource: MongooseResource): State {
  const state = resources.get(resource);
  if (!state || state.closed)
    throw new Error('Mongoose resource closed or not owned by TenantGuard');
  return state;
}
export function createMongooseResource(options: {
  uri: string;
  database: string;
  models: Readonly<Record<string, MongooseModel>>;
  connectionOptions?: ConnectOptions;
}): MongooseResource {
  const uri = options.uri;
  if (typeof uri !== 'string' || !uri.length)
    throw new TypeError('Mongoose URI required');
  const database = identifier(options.database),
    config = structuredClone(options.connectionOptions ?? {});
  // This instance owns its connection, schema types and model registry. No supplied model or plugin is installed.
  const base = new Mongoose();
  base.set('transactionAsyncLocalStorage', false);
  const connection = base.createConnection(),
    models = new Map<string, Model<Record<string, unknown>>>();
  const validated = new Map(
    Object.entries(options.models).map(([alias, model]) => [
      identifier(alias),
      validateMongooseModel(model),
    ]),
  );
  if (!validated.size) throw new TypeError('Mongoose models required');
  for (const [alias, model] of validated) {
    const definition: Record<
      string,
      {
        type: StringConstructor | NumberConstructor | BooleanConstructor;
        required: boolean;
        cast: false;
      }
    > = {};
    for (const [key, field] of Object.entries(model.fields))
      definition[key] = {
        type:
          field.type === 'string'
            ? String
            : field.type === 'number'
              ? Number
              : Boolean,
        required: field.required === true,
        cast: false,
      };
    const schema = new base.Schema(definition, {
      collection: model.spec.collection,
      strict: 'throw',
      strictQuery: 'throw',
      bufferCommands: false,
      autoCreate: false,
      autoIndex: false,
      versionKey: false,
      id: false,
      minimize: false,
    });
    models.set(
      alias,
      connection.model<Record<string, unknown>>(
        alias,
        schema,
        model.spec.collection,
      ),
    );
  }
  let opening: Promise<void> | undefined,
    established = false,
    closing: Promise<void> | undefined,
    fatal: Error | undefined;
  const listeners = new Set<(error: Error) => void>();
  let resource: MongooseResource;
  const failure = (error: Error) => {
    fatal = error;
    for (const listener of listeners) listener(error);
    if (established && !resource.closed) void resource.close().catch(() => {});
  };
  connection.on('error', failure);
  connection.on('disconnected', () => {
    if (established && !resource.closed)
      failure(new Error('Mongoose connection disconnected'));
  });
  const runtime: MongooseRuntime = {
    async connect() {
      if (resource.closed) throw new Error('Mongoose resource closed');
      opening ??= connection
        .openUri(uri, {
          ...config,
          dbName: database,
          maxPoolSize: duration(config.maxPoolSize, 10),
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000,
          socketTimeoutMS: 5000,
          waitQueueTimeoutMS: 5000,
          retryWrites: false,
          retryReads: false,
          bufferCommands: false,
          autoCreate: false,
          autoIndex: false,
        })
        .then(async () => {
          if (resource.closed) {
            await runtime.close();
            throw new Error('Mongoose resource closed during connection');
          }
          established = true;
        })
        .catch(async (error) => {
          await resource.close().catch(() => {});
          throw error;
        });
      await opening;
    },
    async hello() {
      return connection.db!.admin().command({ hello: 1, maxTimeMS: 5000 });
    },
    async collection(spec) {
      const info = await connection
        .db!.listCollections(
          { name: spec.collection },
          { nameOnly: false, maxTimeMS: 5000 },
        )
        .toArray();
      if (
        info.length !== 1 ||
        info[0]!.type !== 'collection' ||
        info[0]!.options?.capped ||
        info[0]!.options?.timeseries
      )
        throw new Error(
          'Only existing ordinary Mongoose collections are supported',
        );
    },
    async startSession() {
      return connection.startSession();
    },
    model(alias) {
      const model = models.get(alias)!;
      const queryOptions = (input: OperationOptions) => ({
        ...input,
        session: input.session as ClientSession,
        sanitizeFilter: false,
        translateAliases: false,
        strict: 'throw' as const,
        strictQuery: 'throw' as const,
      });
      return {
        async find(filter, projection, options) {
          return (await model
            .find(filter, projection, {
              ...queryOptions(options),
              limit: options.limit,
              sort: options.sort,
            })
            .lean()
            .exec()) as Record<string, unknown>[];
        },
        async insert(data, options) {
          await model.create([data], {
            session: options.session as ClientSession,
            ordered: true,
            validateBeforeSave: true,
          });
        },
        async update(filter, data, options) {
          return (
            await model
              .updateMany(
                filter,
                { $set: data },
                {
                  ...queryOptions(options),
                  upsert: false,
                  runValidators: true,
                  bypassDocumentValidation: false,
                },
              )
              .exec()
          ).matchedCount;
        },
        async delete(filter, options) {
          return (await model.deleteMany(filter, queryOptions(options)).exec())
            .deletedCount;
        },
        async aggregate(stages, options) {
          return model
            .aggregate(stages as unknown as PipelineStage[])
            .session(options.session as ClientSession)
            .option({
              maxTimeMS: options.maxTimeMS,
              collation: options.collation,
              allowDiskUse: false,
            })
            .exec();
        },
      };
    },
    close() {
      return (closing ??= connection.destroy(true));
    },
    onError(listener) {
      listeners.add(listener);
      if (fatal) listener(fatal);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  resource = ownedMongooseResource(options.models, runtime);
  return resource;
}
