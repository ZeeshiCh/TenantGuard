import {
  createTenantContext,
  validateTenantId,
  TenantRoutingError,
  type AdapterCapabilities,
  type DatabaseAdapter,
  type TenantRoute,
  type TenantContext,
} from '@tenantguard/core';

export class ResourcePoolClosedError extends Error {
  constructor() {
    super('Tenant resource pool is closed');
    this.name = 'ResourcePoolClosedError';
  }
}
export class ResourcePoolCapacityError extends Error {
  constructor() {
    super('Tenant resource pool admission capacity exhausted');
    this.name = 'ResourcePoolCapacityError';
  }
}
export class ResourcePoolTimeoutError extends Error {
  constructor(readonly phase: 'acquire' | 'create' | 'destroy' | 'shutdown') {
    super(`Tenant resource ${phase} deadline exceeded`);
    this.name = 'ResourcePoolTimeoutError';
  }
}
export class ResourcePoolRouteError extends TenantRoutingError {
  constructor() {
    super(
      'Resource route is unregistered, retired or has a conflicting revision',
    );
    this.name = 'ResourcePoolRouteError';
  }
}
export class ResourcePoolCleanupError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(
      errors,
      'Resource lifecycle failed; native resources may remain open',
    );
    this.name = 'ResourcePoolCleanupError';
  }
}
export interface ResourcePoolOptions<Resource extends object> {
  /** Must return a new, exclusively owned resource; clean partial allocations on rejection. */
  readonly create: (route: Readonly<TenantRoute>) => Promise<Resource>;
  readonly destroy: (resource: Resource) => Promise<void>;
  readonly maxResources?: number;
  readonly maxResourcesPerTenant?: number;
  readonly maxRoutes?: number;
  readonly maxWaiters?: number;
  readonly maxLeasesPerResource?: number;
  readonly acquireTimeoutMs?: number;
  readonly createTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly destroyTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly clock?: () => number;
}
export interface TenantResourcePool<Resource extends object> {
  /** Trusted control plane only. Revision changes require compare-and-set. */
  setRoute(route: Readonly<TenantRoute>, expectedRevision?: string): void;
  remove(target: { readonly tenantId: string; readonly source?: string }): void;
  run<T>(
    route: Readonly<TenantRoute>,
    work: (resource: Resource) => Promise<T>,
  ): Promise<T>;
  /** Checks idle deadlines; automatic eviction also runs without further requests. */
  sweep(): void;
  close(): Promise<void>;
  stats(): Readonly<{
    routes: number;
    resources: number;
    creating: number;
    activeLeases: number;
    waiting: number;
    disposing: number;
    quarantined: number;
    closed: boolean;
  }>;
}
interface Slot<Resource extends object> {
  route: Readonly<TenantRoute>;
  current?: RecordState<Resource>;
}
interface RecordState<Resource extends object> {
  slot: Slot<Resource>;
  route: Readonly<TenantRoute>;
  resource?: Resource;
  state: 'creating' | 'ready' | 'disposing' | 'failed';
  retired: boolean;
  users: number;
  idleAt: number;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}
interface Waiter<Resource extends object> {
  slot: Slot<Resource>;
  route: Readonly<TenantRoute>;
  deadline: number;
  reject(error: unknown): void;
  grant(record: RecordState<Resource>): void;
  timer?: ReturnType<typeof setTimeout>;
}
// Weak ownership history also catches the same handle returned to another manager.
const owned = new WeakSet<object>();
function bound(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`Invalid ${name}`);
  return value;
}
function text(value: unknown, max = 2048): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new ResourcePoolRouteError();
}
function snapshot(value: Readonly<TenantRoute>): Readonly<TenantRoute> {
  const route = {
    tenantId: value.tenantId,
    source: value.source,
    adapter: value.adapter,
    resource: value.resource,
    revision: value.revision,
    status: value.status,
    mode: value.mode,
    secretRef: value.secretRef,
  };
  validateTenantId(route.tenantId);
  text(route.source, 256);
  text(route.adapter);
  text(route.resource);
  text(route.revision);
  if (route.secretRef !== undefined) text(route.secretRef);
  if (
    route.status !== 'active' ||
    !['database-policy', 'database-per-tenant', 'application-filter'].includes(
      route.mode,
    )
  )
    throw new ResourcePoolRouteError();
  return Object.freeze(route);
}
const selector = (route: Readonly<TenantRoute>) =>
  JSON.stringify([route.tenantId, route.source, route.adapter]);
const identity = (route: Readonly<TenantRoute>) =>
  JSON.stringify([
    route.tenantId,
    route.source,
    route.adapter,
    route.resource,
    route.revision,
    route.secretRef ?? null,
    route.mode,
  ]);

/** Owns resource generations; never force-closes active callbacks or pretends timed-out I/O was cancelled. */
export function createTenantResourcePool<Resource extends object>(
  options: ResourcePoolOptions<Resource>,
): TenantResourcePool<Resource> {
  const max = bound(options.maxResources ?? 64, 1, 100_000, 'maxResources');
  const perTenant = bound(
    options.maxResourcesPerTenant ?? Math.min(2, max),
    1,
    max,
    'maxResourcesPerTenant',
  );
  const maxRoutes = bound(options.maxRoutes ?? 256, 1, 1_000_000, 'maxRoutes');
  const maxWaiters = bound(options.maxWaiters ?? 128, 1, 100_000, 'maxWaiters');
  const leases = bound(
    options.maxLeasesPerResource ?? 16,
    1,
    100_000,
    'maxLeasesPerResource',
  );
  const acquireTimeout = bound(
    options.acquireTimeoutMs ?? 5000,
    1,
    2_147_483_647,
    'acquireTimeoutMs',
  );
  const createTimeout = bound(
    options.createTimeoutMs ?? 10000,
    1,
    2_147_483_647,
    'createTimeoutMs',
  );
  const idleTimeout = bound(
    options.idleTimeoutMs ?? 30000,
    1,
    2_147_483_647,
    'idleTimeoutMs',
  );
  const destroyTimeout = bound(
    options.destroyTimeoutMs ?? 10000,
    1,
    2_147_483_647,
    'destroyTimeoutMs',
  );
  const shutdownTimeout = bound(
    options.shutdownTimeoutMs ?? 30000,
    1,
    2_147_483_647,
    'shutdownTimeoutMs',
  );
  const create = options.create,
    destroy = options.destroy,
    clock = options.clock ?? (() => performance.now());
  let previous = -Infinity;
  const now = () => {
    const time = clock();
    if (!Number.isFinite(time) || time < previous)
      throw new RangeError('Resource clock must be finite and monotonic');
    previous = time;
    return time;
  };
  now();
  const slots = new Map<string, Slot<Resource>>();
  const records = new Set<RecordState<Resource>>();
  const waiters = new Set<Waiter<Resource>>();
  const failures: unknown[] = [];
  let closed = false,
    pumping = false,
    again = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownDeadline = Infinity;
  let closePromise: Promise<void> | undefined,
    finishClose: (() => void) | undefined,
    failClose: ((error: unknown) => void) | undefined;
  const checkClose = () => {
    if (
      closed &&
      Array.from(records).every((record) => record.state === 'failed')
    ) {
      clearTimeout(shutdownTimer);
      if (failures.length) failClose?.(new ResourcePoolCleanupError(failures));
      else if (performance.now() >= shutdownDeadline)
        failClose?.(new ResourcePoolTimeoutError('shutdown'));
      else finishClose?.();
    }
  };
  const rejectWaiter = (waiter: Waiter<Resource>, error: unknown) => {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  };
  const rejectGeneration = (record: RecordState<Resource>, error: unknown) => {
    // A retired native factory may settle after a replacement for the same route starts.
    if (record.retired || record.slot.current !== record) return;
    for (const waiter of waiters)
      if (waiter.slot === record.slot && waiter.route === record.route)
        rejectWaiter(waiter, error);
  };
  function dispose(record: RecordState<Resource>) {
    if (!record.retired || record.users || record.state !== 'ready') return;
    record.state = 'disposing';
    const timer = setTimeout(() => {
      if (record.state === 'disposing')
        fatal(new ResourcePoolTimeoutError('destroy'));
    }, destroyTimeout);
    void Promise.resolve()
      .then(() => destroy(record.resource!))
      .then(
        () => {
          clearTimeout(timer);
          records.delete(record);
          pump();
          checkClose();
        },
        (error) => {
          clearTimeout(timer);
          record.state = 'failed';
          failures.push(error);
          shutdown();
          checkClose();
        },
      );
  }
  function retire(record: RecordState<Resource>) {
    record.retired = true;
    clearTimeout(record.timer);
    if (record.slot.current === record) record.slot.current = undefined;
    dispose(record);
  }
  function shutdown(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    clearTimeout(idleTimer);
    slots.clear();
    closePromise = new Promise<void>((resolve, reject) => {
      finishClose = resolve;
      failClose = reject;
    });
    shutdownDeadline = performance.now() + shutdownTimeout;
    shutdownTimer = setTimeout(
      () => failClose?.(new ResourcePoolTimeoutError('shutdown')),
      shutdownTimeout,
    );
    // Automatic terminal cleanup failures are reported by close(), without orphan rejections.
    void closePromise.catch(() => {});
    for (const waiter of waiters)
      rejectWaiter(waiter, new ResourcePoolClosedError());
    for (const record of records) retire(record);
    checkClose();
    return closePromise;
  }
  function fatal(error: unknown) {
    failures.push(error);
    shutdown();
    checkClose();
  }
  function start(slot: Slot<Resource>, time: number) {
    const record: RecordState<Resource> = {
      slot,
      route: slot.route,
      state: 'creating',
      retired: false,
      users: 0,
      idleAt: time,
      deadline: time + createTimeout,
    };
    slot.current = record;
    records.add(record);
    record.timer = setTimeout(() => {
      rejectGeneration(record, new ResourcePoolTimeoutError('create'));
      retire(record);
      pump();
    }, createTimeout);
    const skipped = Symbol('undispatched factory');
    void Promise.resolve()
      .then<Resource | typeof skipped>(() => {
        if (record.retired) return skipped;
        return create(record.route);
      })
      .then(
        (resource) => {
          clearTimeout(record.timer);
          if (resource === skipped) {
            records.delete(record);
            pump();
            checkClose();
            return;
          }
          if (
            !resource ||
            (typeof resource !== 'object' && typeof resource !== 'function') ||
            owned.has(resource)
          ) {
            records.delete(record);
            rejectGeneration(record, new ResourcePoolRouteError());
            fatal(
              new Error(
                'Factory returned an invalid or previously owned resource',
              ),
            );
            return;
          }
          owned.add(resource);
          record.resource = resource;
          try {
            // Keep creation unpublished while a custom clock can reenter the manager.
            const time = now();
            record.idleAt = time;
            record.state = 'ready';
            if (time >= record.deadline) {
              rejectGeneration(record, new ResourcePoolTimeoutError('create'));
              retire(record);
            }
            if (closed || record.retired || slot.route !== record.route)
              retire(record);
            pump();
          } catch (error) {
            record.state = 'ready';
            retire(record);
            fatal(error);
          }
        },
        (error) => {
          clearTimeout(record.timer);
          records.delete(record);
          rejectGeneration(record, error);
          if (slot.current === record) slot.current = undefined;
          pump();
          checkClose();
        },
      );
  }
  function scheduleIdle(time: number) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (closed) return;
    let remaining = Infinity;
    for (const record of records)
      if (record.state === 'ready' && !record.retired && !record.users)
        remaining = Math.min(remaining, record.idleAt + idleTimeout - time);
    if (Number.isFinite(remaining)) {
      idleTimer = setTimeout(() => pump(), Math.max(1, remaining));
      // Node hosts should not stay alive solely for idle eviction; browser timers are numbers.
      if (typeof idleTimer === 'object' && 'unref' in idleTimer)
        idleTimer.unref();
    }
  }
  function pump() {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        if (closed) {
          checkClose();
          break;
        }
        const time = now();
        if (closed) break;
        for (const record of records) {
          if (
            record.state === 'creating' &&
            !record.retired &&
            time >= record.deadline
          ) {
            rejectGeneration(record, new ResourcePoolTimeoutError('create'));
            retire(record);
          }
        }
        for (const record of records)
          if (
            record.state === 'ready' &&
            !record.retired &&
            !record.users &&
            time >= record.idleAt + idleTimeout
          )
            retire(record);
        for (const waiter of waiters) {
          if (closed) break;
          if (time >= waiter.deadline) {
            rejectWaiter(waiter, new ResourcePoolTimeoutError('acquire'));
            continue;
          }
          if (
            waiter.slot.route !== waiter.route ||
            slots.get(selector(waiter.route)) !== waiter.slot
          ) {
            rejectWaiter(waiter, new ResourcePoolRouteError());
            continue;
          }
          const record = waiter.slot.current;
          if (
            record?.state === 'ready' &&
            !record.retired &&
            record.users < leases
          ) {
            waiters.delete(waiter);
            clearTimeout(waiter.timer);
            record.users++;
            waiter.grant(record);
            continue;
          }
          if (record) continue;
          const tenantCount = Array.from(records).filter(
            (record) => record.route.tenantId === waiter.route.tenantId,
          ).length;
          if (records.size < max && tenantCount < perTenant) {
            start(waiter.slot, time);
            continue;
          }
          const candidates = Array.from(records).filter(
            (record) =>
              !record.retired &&
              record.state === 'ready' &&
              !record.users &&
              (tenantCount < perTenant ||
                record.route.tenantId === waiter.route.tenantId),
          );
          candidates.sort((a, b) => a.idleAt - b.idleAt);
          if (candidates[0]) retire(candidates[0]);
        }
        for (const record of records)
          if (
            record.state === 'creating' &&
            !record.retired &&
            ![...waiters].some(
              (waiter) =>
                waiter.slot === record.slot && waiter.route === record.route,
            )
          )
            retire(record);
        scheduleIdle(time);
      } while (again);
    } catch (error) {
      fatal(error);
    } finally {
      pumping = false;
    }
  }
  return Object.freeze({
    setRoute(value: Readonly<TenantRoute>, expectedRevision?: string) {
      if (closed) throw new ResourcePoolClosedError();
      const route = snapshot(value),
        key = selector(route),
        slot = slots.get(key);
      if (closed) throw new ResourcePoolClosedError();
      if (slot) {
        if (
          expectedRevision !== undefined &&
          expectedRevision !== slot.route.revision
        )
          throw new ResourcePoolRouteError();
        if (identity(slot.route) === identity(route)) return;
        if (
          expectedRevision !== slot.route.revision ||
          route.revision === slot.route.revision
        )
          throw new ResourcePoolRouteError();
        const old = slot.current;
        slot.route = route;
        for (const waiter of waiters)
          if (waiter.slot === slot)
            rejectWaiter(waiter, new ResourcePoolRouteError());
        if (old) retire(old);
      } else {
        if (expectedRevision !== undefined) throw new ResourcePoolRouteError();
        if (slots.size >= maxRoutes) throw new ResourcePoolCapacityError();
        slots.set(key, { route });
      }
      pump();
    },
    remove(target: { readonly tenantId: string; readonly source?: string }) {
      if (closed) throw new ResourcePoolClosedError();
      const tenantId = target.tenantId,
        source = target.source;
      validateTenantId(tenantId);
      if (source !== undefined) text(source, 256);
      for (const [key, slot] of slots)
        if (
          slot.route.tenantId === tenantId &&
          (source === undefined || slot.route.source === source)
        ) {
          slots.delete(key);
          for (const waiter of waiters)
            if (waiter.slot === slot)
              rejectWaiter(waiter, new ResourcePoolRouteError());
          if (slot.current) retire(slot.current);
        }
      pump();
    },
    async run<T>(
      value: Readonly<TenantRoute>,
      work: (resource: Resource) => Promise<T>,
    ): Promise<T> {
      if (closed) throw new ResourcePoolClosedError();
      const route = snapshot(value),
        slot = slots.get(selector(route)),
        time = now();
      if (closed) throw new ResourcePoolClosedError();
      if (!slot || identity(slot.route) !== identity(route))
        throw new ResourcePoolRouteError();
      if (waiters.size >= maxWaiters) throw new ResourcePoolCapacityError();
      // Await from the caller's async context. Pump/factory/other-lease callbacks
      // only resolve acquisition; they must never invoke another request's work.
      const record = await new Promise<RecordState<Resource>>(
        (accept, reject) => {
          const waiter: Waiter<Resource> = {
            slot,
            route: slot.route,
            deadline: time + acquireTimeout,
            reject,
            grant: accept,
          };
          waiters.add(waiter);
          waiter.timer = setTimeout(() => {
            rejectWaiter(waiter, new ResourcePoolTimeoutError('acquire'));
            pump();
          }, acquireTimeout);
          pump();
        },
      );
      try {
        if (closed) throw new ResourcePoolClosedError();
        return await work(record.resource!);
      } catch (error) {
        retire(record);
        throw error;
      } finally {
        record.users--;
        try {
          record.idleAt = now();
        } catch (error) {
          fatal(error);
        }
        dispose(record);
        pump();
        checkClose();
      }
    },
    sweep: pump,
    close: shutdown,
    stats: () =>
      Object.freeze({
        routes: slots.size,
        resources: records.size,
        creating: [...records].filter((r) => r.state === 'creating').length,
        activeLeases: [...records].reduce((n, r) => n + r.users, 0),
        waiting: waiters.size,
        disposing: [...records].filter((r) => r.state === 'disposing').length,
        quarantined: [...records].filter((r) => r.state === 'failed').length,
        closed,
      }),
  });
}

/** Holds the lease through the underlying adapter's full enforcement/transaction/cleanup lifecycle. */
export function createPooledAdapter<Resource extends object, Client>(options: {
  readonly pool: TenantResourcePool<Resource>;
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  readonly createAdapter: (resource: Resource) => DatabaseAdapter<Client>;
}): DatabaseAdapter<Client> {
  const pool = options.pool,
    createAdapter = options.createAdapter,
    name = options.name;
  const capabilities = Object.freeze({
    transactions: options.capabilities.transactions,
    isolationModes: Object.freeze([...options.capabilities.isolationModes]),
  });
  return Object.freeze({
    name,
    capabilities,
    async run<T>(
      context: Readonly<TenantContext>,
      route: Readonly<TenantRoute>,
      work: (client: Client) => Promise<T>,
    ): Promise<T> {
      const trusted = createTenantContext(context),
        routing = snapshot(route);
      if (
        trusted.tenantId !== routing.tenantId ||
        routing.adapter !== name ||
        !capabilities.isolationModes.includes(routing.mode)
      )
        throw new ResourcePoolRouteError();
      return pool.run(routing, async (resource) => {
        const adapter = createAdapter(resource);
        if (
          adapter.name !== name ||
          !adapter.capabilities.isolationModes.includes(routing.mode) ||
          adapter.capabilities.transactions !== capabilities.transactions
        )
          throw new ResourcePoolRouteError();
        return adapter.run(trusted, routing, work);
      });
    },
  });
}
