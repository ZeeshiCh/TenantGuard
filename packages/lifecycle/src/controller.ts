import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantRegistry,
  type TenantRoute,
} from '@tenantguard/core';
import {
  assertActive,
  duration,
  keySnapshot,
  routeIdentity,
  routeSnapshot,
  stateSnapshot,
  nextVersion,
  text,
  LifecycleBusyError,
  LifecycleClosedError,
  LifecycleConflictError,
  LifecyclePublicationError,
  LifecycleRecoveryError,
  LifecycleTimeoutError,
  type LifecycleAdmissionStore,
  type LifecycleKey,
  type LifecycleOperation,
  type LifecycleState,
  type LifecycleStore,
} from './state.js';
export interface LifecycleWork<Native> {
  readonly work: (
    native: Native,
    operation: Readonly<LifecycleOperation>,
  ) => Promise<void>;
  readonly verify: (
    native: Native,
    operation: Readonly<LifecycleOperation>,
  ) => Promise<void>;
}
export interface LifecycleCommand<Native> extends LifecycleWork<Native> {
  readonly route: Readonly<TenantRoute>;
  readonly operationId: string;
  readonly schemaVersion: string;
}
/** Explicit management API. Never invoke from ordinary request authorization. */
export function createTenantLifecycle<Native>(options: {
  store: LifecycleStore<Native>;
  onChange?: (state: Readonly<LifecycleState>) => Promise<void>;
  maxOperations?: number;
  operationTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}) {
  const store = options.store,
    onChange = options.onChange;
  const max = duration(options.maxOperations, 16),
    operationTimeout = duration(options.operationTimeoutMs, 60000),
    shutdownTimeout = duration(options.shutdownTimeoutMs, 30000);
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined, finishClose: (() => void) | undefined;
  const checkClose = () => {
    if (closed && !pending.size) finishClose?.();
  };
  async function publish(state: Readonly<LifecycleState>) {
    if (onChange)
      try {
        await onChange(state);
      } catch (error) {
        throw new LifecyclePublicationError(state, error);
      }
  }
  function manage<T>(run: (check: () => void) => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new LifecycleClosedError());
    if (pending.size >= max) return Promise.reject(new LifecycleBusyError());
    let expired = false;
    const deadline = performance.now() + operationTimeout;
    const check = () => {
      if (expired || performance.now() >= deadline) {
        expired = true;
        throw new LifecycleTimeoutError('operation');
      }
    };
    const actual = Promise.resolve().then(() => {
      check();
      return run(check);
    });
    pending.add(actual);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        expired = true;
        reject(new LifecycleTimeoutError('operation'));
      }, operationTimeout);
      const finish = () => {
        clearTimeout(timer);
        pending.delete(actual);
        checkClose();
      };
      void actual.then(
        (value) => {
          finish();
          try {
            check();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          finish();
          reject(error);
        },
      );
    });
  }
  function execute(
    command: LifecycleCommand<Native> & { expectedVersion?: number },
    kind: 'provision' | 'migrate' | 'resume',
    recover = false,
    checkpoint?: () => void,
  ): Promise<Readonly<LifecycleState>> {
    const target = routeSnapshot(command.route),
      key = keySnapshot(target),
      id = command.operationId,
      schemaVersion = command.schemaVersion;
    text(id, 256);
    text(schemaVersion, 256);
    if (target.status !== 'active') throw new LifecycleConflictError();
    const work = command.work,
      verify = command.verify;
    if (typeof work !== 'function' || typeof verify !== 'function')
      throw new TypeError('Lifecycle work and verification are required');
    const expected = command.expectedVersion;
    const run = (check: () => void) =>
      store.withControlLock(key, async (session) => {
        let current = await session.read();
        check();
        const matches = (operation: Readonly<LifecycleOperation> | undefined) =>
          operation?.id === id &&
          operation.kind === kind &&
          operation.schemaVersion === schemaVersion &&
          routeIdentity(operation.target) === routeIdentity(target);
        if (current?.route.status === 'active' && matches(current.operation)) {
          await publish(current);
          return current;
        }
        if (current?.operation?.id === id) {
          if (!matches(current.operation)) throw new LifecycleConflictError();
          if (!recover) throw new LifecycleRecoveryError();
        }
        if (recover) {
          if (
            !current ||
            !matches(current.operation) ||
            !['pending', 'provisioning', 'migrating', 'failed'].includes(
              current.route.status,
            ) ||
            current.version !== expected
          )
            throw new LifecycleConflictError();
        } else if (kind === 'provision') {
          if (current || expected !== undefined)
            throw new LifecycleConflictError();
        } else {
          if (
            !current ||
            current.version !== expected ||
            current.route.status !==
              (kind === 'resume' ? 'suspended' : 'active') ||
            current.route.adapter !== target.adapter ||
            current.route.mode !== target.mode ||
            current.route.revision === target.revision
          )
            throw new LifecycleConflictError();
          if (kind === 'resume' && current.schemaVersion !== schemaVersion)
            throw new LifecycleConflictError();
        }
        const operation = Object.freeze({ id, kind, target, schemaVersion });
        const write = async (status: TenantRoute['status']) => {
          const next = stateSnapshot(
            {
              version: nextVersion(current?.version),
              route: { ...(current?.route ?? target), status },
              schemaVersion: current?.schemaVersion,
              operation,
            },
            key,
          );
          if (!(await session.compareAndSet(current?.version, next)))
            throw new LifecycleConflictError();
          current = next;
        };
        try {
          if (!current) {
            await write('pending');
            await publish(current!);
            check();
          }
          await write(kind === 'provision' ? 'provisioning' : 'migrating');
          await publish(current!);
          check();
          const started = current!;
          const active = await store.withExclusiveLock(
            key,
            async (transaction) => {
              check();
              const owned = await transaction.read();
              if (
                owned?.version !== started.version ||
                !matches(owned.operation)
              )
                throw new LifecycleConflictError();
              await transaction.runPhase((native) => work(native, operation));
              check();
              const verified = await transaction.runPhase((native) =>
                verify(native, operation),
              );
              if (verified !== undefined)
                throw new TypeError(
                  'Verification must reject on failure and resolve without a value',
                );
              check();
              const next = stateSnapshot(
                {
                  version: nextVersion(started.version),
                  route: target,
                  schemaVersion,
                  operation,
                },
                key,
              );
              if (!(await transaction.compareAndSet(started.version, next)))
                throw new LifecycleConflictError();
              check();
              return next;
            },
            check,
          );
          current = active;
        } catch (error) {
          if (current && current.route.status !== 'active') {
            const failed = stateSnapshot(
              {
                ...current,
                version: nextVersion(current.version),
                route: { ...current.route, status: 'failed' },
                failure: 'operation',
              },
              key,
            );
            try {
              if (await session.compareAndSet(current.version, failed)) {
                current = failed;
                await publish(failed);
              }
            } catch (cleanup) {
              throw new AggregateError(
                [error, cleanup],
                'Lifecycle operation failed and failure publication was uncertain',
              );
            }
          }
          throw error;
        }
        await publish(current!);
        return current!;
      });
    return checkpoint ? run(checkpoint) : manage(run);
  }
  return Object.freeze({
    provision: (command: LifecycleCommand<Native>) =>
      execute(command, 'provision'),
    migrate: (
      command: LifecycleCommand<Native> & { expectedVersion: number },
    ) => execute(command, 'migrate'),
    resume: (
      command: Omit<LifecycleCommand<Native>, 'work'> & {
        expectedVersion: number;
      },
    ) => execute({ ...command, work: async () => {} }, 'resume'),
    async recover(
      command: LifecycleWork<Native> & {
        key: LifecycleKey;
        expectedVersion: number;
        operationId: string;
      },
    ) {
      const key = keySnapshot(command.key),
        input = {
          work: command.work,
          verify: command.verify,
          expectedVersion: command.expectedVersion,
          operationId: command.operationId,
        };
      return manage(async (check) => {
        const current = await store.read(key);
        check();
        if (!current?.operation || current.operation.id !== input.operationId)
          throw new LifecycleConflictError();
        return execute(
          {
            ...input,
            route: current.operation.target,
            schemaVersion: current.operation.schemaVersion,
          },
          current.operation.kind,
          true,
          check,
        );
      });
    },
    suspend(command: { key: LifecycleKey; expectedVersion: number }) {
      const key = keySnapshot(command.key),
        expected = command.expectedVersion;
      return manage((check) =>
        store.withControlLock(key, async (session) => {
          const current = await session.read();
          check();
          if (
            !current ||
            current.version !== expected ||
            current.route.status !== 'active'
          )
            throw new LifecycleConflictError();
          const next = stateSnapshot(
            {
              version: nextVersion(expected),
              route: { ...current.route, status: 'suspended' },
              schemaVersion: current.schemaVersion,
            },
            key,
          );
          if (!(await session.compareAndSet(expected, next)))
            throw new LifecycleConflictError();
          await publish(next);
          check();
          await store.withExclusiveLock(key, async () => {
            check();
          });
          return next;
        }),
      );
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + shutdownTimeout;
        const timer = setTimeout(
          () => reject(new LifecycleTimeoutError('shutdown')),
          shutdownTimeout,
        );
        finishClose = () => {
          clearTimeout(timer);
          if (performance.now() >= deadline)
            reject(new LifecycleTimeoutError('shutdown'));
          else resolve();
        };
      });
      void closing.catch(() => {});
      checkClose();
      return closing;
    },
    stats: () => Object.freeze({ closed, operations: pending.size }),
  });
}
export function createLifecycleRegistry<Native>(
  store: LifecycleStore<Native>,
): TenantRegistry {
  return Object.freeze({
    async resolve(
      input: Parameters<TenantRegistry['resolve']>[0],
      source: string,
    ) {
      const context = createTenantContext(input);
      const key = keySnapshot({ tenantId: context.tenantId, source });
      const state = await store.read(key);
      return state ? stateSnapshot(state, key).route : undefined;
    },
  });
}
export function createLifecycleAdapter<Native, Client>(options: {
  store: LifecycleAdmissionStore<Native>;
  adapter: DatabaseAdapter<Client>;
}): DatabaseAdapter<Client> {
  const store = options.store,
    adapter = options.adapter;
  const name = adapter.name,
    capabilities = Object.freeze({
      transactions: adapter.capabilities.transactions,
      isolationModes: Object.freeze([...adapter.capabilities.isolationModes]),
    });
  return Object.freeze({
    name,
    capabilities,
    async run<T>(
      context: Parameters<DatabaseAdapter<Client>['run']>[0],
      value: Readonly<TenantRoute>,
      work: (client: Client) => Promise<T>,
    ): Promise<T> {
      const trusted = createTenantContext(context),
        route = routeSnapshot(value);
      if (
        trusted.tenantId !== route.tenantId ||
        route.adapter !== name ||
        !capabilities.isolationModes.includes(route.mode)
      )
        throw new LifecycleConflictError();
      return store.withAdmission(keySnapshot(route), async (reader) => {
        const state = await reader.read();
        assertActive(state ? stateSnapshot(state, route) : undefined, route);
        return adapter.run(trusted, route, work);
      });
    },
  });
}
