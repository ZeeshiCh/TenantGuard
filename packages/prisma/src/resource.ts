import {
  PrismaSafetyError,
  type PrismaDatamodel,
  type PrismaModelMetadata,
} from './guards.js';
export interface PrismaClientLike {
  $transaction<T>(
    work: (transaction: object) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: 'Serializable';
    },
  ): Promise<T>;
  $disconnect(): Promise<void>;
}
export type PrismaProvider = 'postgresql' | 'mysql';
export interface PrismaResource {
  readonly closed: boolean;
  close(): Promise<void>;
}
interface State {
  readonly provider: PrismaProvider;
  readonly datamodel: PrismaDatamodel;
  readonly createClient: () => PrismaClientLike | Promise<PrismaClientLike>;
  readonly clients: Set<PrismaClientLike>;
  readonly disposals: WeakMap<PrismaClientLike, Promise<void>>;
  closed: boolean;
  closing?: Promise<void>;
}
const resources = new WeakMap<PrismaResource, State>(),
  seen = new WeakSet<object>();
export function createPrismaResource(options: {
  provider: PrismaProvider;
  datamodel: PrismaDatamodel;
  createClient: () => PrismaClientLike | Promise<PrismaClientLike>;
}): PrismaResource {
  if (
    !['postgresql', 'mysql'].includes(options.provider) ||
    typeof options.createClient !== 'function'
  )
    throw new PrismaSafetyError('Unsupported Prisma provider or factory');
  const models: readonly PrismaModelMetadata[] = Object.freeze(
    options.datamodel.models.map((model) =>
      Object.freeze({
        name: model.name,
        dbName: model.dbName,
        schema: model.schema,
        fields: Object.freeze(
          model.fields.map((field) => Object.freeze({ ...field })),
        ),
      }),
    ),
  );
  const state: State = {
    provider: options.provider,
    datamodel: Object.freeze({ models }),
    createClient: options.createClient,
    clients: new Set(),
    disposals: new WeakMap(),
    closed: false,
  };
  const resource: PrismaResource = Object.freeze({
    get closed() {
      return state.closed;
    },
    close() {
      state.closed = true;
      return (state.closing ??= Promise.allSettled(
        [...state.clients].map((client) => disposeClient(state, client)),
      ).then((results) => {
        const failures = results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          )
          .map((result) => result.reason);
        if (failures.length)
          throw new AggregateError(
            failures,
            'Prisma resource retirement failed',
          );
      }));
    },
  });
  resources.set(resource, state);
  return resource;
}
export function prismaState(resource: PrismaResource): State {
  const state = resources.get(resource);
  if (!state || state.closed)
    throw new PrismaSafetyError(
      'Prisma resource closed or not owned by TenantGuard',
    );
  return state;
}
function disposeClient(state: State, client: PrismaClientLike): Promise<void> {
  let promise = state.disposals.get(client);
  if (!promise) {
    promise = Promise.resolve()
      .then(() => client.$disconnect())
      .finally(() => state.clients.delete(client));
    state.disposals.set(client, promise);
  }
  return promise;
}
export async function acquirePrismaClient(
  resource: PrismaResource,
  isActive: () => boolean,
) {
  const state = prismaState(resource),
    client = await state.createClient();
  if (
    !client ||
    typeof client.$transaction !== 'function' ||
    typeof client.$disconnect !== 'function'
  )
    throw new PrismaSafetyError('Factory must return a fresh Prisma client');
  if (seen.has(client))
    throw new PrismaSafetyError(
      'Prisma client factories must not reuse client instances',
    );
  seen.add(client);
  state.clients.add(client);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= disposeClient(state, client));
  if (state.closed || !isActive()) {
    try {
      await close();
    } catch (error) {
      void resource.close().catch(() => {});
      throw error;
    }
    throw new PrismaSafetyError('Prisma scope expired during client creation');
  }
  return { client, state, close };
}
