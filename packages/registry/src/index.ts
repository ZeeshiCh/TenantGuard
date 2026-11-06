import {
  createTenantContext,
  validateTenantId,
  TenantRoutingError,
  type TenantContext,
  type TenantRegistry,
  type TenantRoute,
} from '@tenantguard/core';

export class RegistryCacheClosedError extends Error {
  constructor() {
    super('Tenant registry cache is closed');
    this.name = 'RegistryCacheClosedError';
  }
}
export class RegistryCacheInvalidatedError extends Error {
  constructor() {
    super('Tenant registry lookup was invalidated');
    this.name = 'RegistryCacheInvalidatedError';
  }
}
export class RegistryCacheCapacityError extends Error {
  constructor() {
    super('Tenant registry lookup capacity exhausted');
    this.name = 'RegistryCacheCapacityError';
  }
}
export class RegistryCacheTimeoutError extends Error {
  constructor() {
    super('Tenant registry lookup deadline exceeded');
    this.name = 'RegistryCacheTimeoutError';
  }
}
export interface RegistryCacheOptions {
  readonly registry: TenantRegistry;
  readonly ttlMs?: number;
  /** Missing routes are not cached unless explicitly enabled. */
  readonly negativeTtlMs?: number;
  readonly maxEntries?: number;
  /** Counts actual unresolved upstream operations, even after invalidation/timeout. */
  readonly maxPending?: number;
  readonly lookupTimeoutMs?: number;
  /** Monotonic milliseconds; defaults to performance.now(). */
  readonly clock?: () => number;
}
export interface CachedTenantRegistry extends TenantRegistry {
  invalidate(target: {
    readonly tenantId: string;
    readonly source?: string;
  }): void;
  clear(): void;
  /** Terminal. Rejects waiters immediately, then waits for actual upstream settlement. */
  close(): Promise<void>;
  stats(): Readonly<{ entries: number; pending: number; closed: boolean }>;
}
interface Entry {
  readonly tenantId: string;
  readonly source: string;
  readonly route: TenantRoute | undefined;
  readonly expires: number;
}
interface Flight {
  readonly tenantId: string;
  readonly source: string;
  readonly promise: Promise<TenantRoute | undefined>;
  readonly deadline: number;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  active: boolean;
}
function bounded(value: number, name: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`Invalid ${name}`);
  return value;
}
function reference(
  value: unknown,
  name: string,
  max = 2048,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TenantRoutingError(`Invalid registry ${name}`);
}
function snapshot(
  route: TenantRoute | undefined,
  tenantId: string,
  source: string,
): TenantRoute | undefined {
  if (route === undefined) return undefined;
  // Copy once, before validation; never retain provider-owned mutable route objects.
  const secretRef = route.secretRef;
  const copy = {
    tenantId: route.tenantId,
    source: route.source,
    adapter: route.adapter,
    resource: route.resource,
    revision: route.revision,
    status: route.status,
    mode: route.mode,
    ...(secretRef === undefined ? {} : { secretRef }),
  };
  if (copy.tenantId !== tenantId || copy.source !== source)
    throw new TenantRoutingError(
      'Registry route does not match requested tenant/source',
    );
  reference(copy.adapter, 'adapter');
  reference(copy.resource, 'resource');
  reference(copy.revision, 'revision');
  if (copy.secretRef !== undefined)
    reference(copy.secretRef, 'secret reference');
  if (
    !['active', 'pending', 'suspended', 'migrating', 'failed'].includes(
      copy.status,
    ) ||
    !['database-policy', 'database-per-tenant', 'application-filter'].includes(
      copy.mode,
    )
  )
    throw new TenantRoutingError(
      'Invalid registry route status or isolation mode',
    );
  return Object.freeze(copy);
}
/** Routing cache only: membership authorization must still run on every request. */
export function createCachedTenantRegistry(
  options: RegistryCacheOptions,
): CachedTenantRegistry {
  const ttl = bounded(options.ttlMs ?? 5000, 'ttlMs', 1, 86_400_000);
  const negativeTtl = bounded(
    options.negativeTtlMs ?? 0,
    'negativeTtlMs',
    0,
    86_400_000,
  );
  const maxEntries = bounded(
    options.maxEntries ?? 1024,
    'maxEntries',
    1,
    1_000_000,
  );
  const maxPending = bounded(
    options.maxPending ?? 128,
    'maxPending',
    1,
    100_000,
  );
  const timeout = bounded(
    options.lookupTimeoutMs ?? 5000,
    'lookupTimeoutMs',
    1,
    2_147_483_647,
  );
  const resolve = options.registry.resolve.bind(options.registry);
  const clock = options.clock ?? (() => performance.now());
  let previousTime = -Infinity;
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value) || value < previousTime)
      throw new RangeError('Registry cache clock must be finite and monotonic');
    previousTime = value;
    return value;
  };
  now();
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Flight>();
  const pending = new Set<Flight>();
  let closed = false;
  let closedPromise: Promise<void> | undefined;
  let finishClose: (() => void) | undefined;
  const retire = (key: string, flight: Flight, error: Error) => {
    if (!flight.active) return;
    flight.active = false;
    clearTimeout(flight.timer);
    if (flights.get(key) === flight) flights.delete(key);
    flight.reject(error);
  };
  const invalidate = (
    matches: (entry: { tenantId: string; source: string }) => boolean,
  ) => {
    for (const [key, entry] of entries) if (matches(entry)) entries.delete(key);
    for (const [key, flight] of flights)
      if (matches(flight))
        retire(key, flight, new RegistryCacheInvalidatedError());
  };
  return Object.freeze({
    async resolve(
      context: Readonly<TenantContext>,
      source: string,
    ): Promise<TenantRoute | undefined> {
      if (closed) throw new RegistryCacheClosedError();
      const trusted = createTenantContext(context);
      reference(source, 'source', 256);
      const key = JSON.stringify([
        trusted.tenantId,
        trusted.principalId ?? null,
        trusted.correlationId ?? null,
        source,
      ]);
      const time = now();
      if (closed) throw new RegistryCacheClosedError();
      const entry = entries.get(key);
      if (entry && time < entry.expires) {
        entries.delete(key);
        entries.set(key, entry);
        return entry.route;
      }
      entries.delete(key);
      const existing = flights.get(key);
      if (existing) {
        if (time >= existing.deadline)
          retire(key, existing, new RegistryCacheTimeoutError());
        return existing.promise;
      }
      if (pending.size >= maxPending) throw new RegistryCacheCapacityError();
      let accept!: (route: TenantRoute | undefined) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<TenantRoute | undefined>((yes, no) => {
        accept = yes;
        reject = no;
      });
      const flight: Flight = {
        tenantId: trusted.tenantId,
        source,
        promise,
        deadline: time + timeout,
        reject,
        active: true,
      };
      flights.set(key, flight);
      pending.add(flight);
      flight.timer = setTimeout(
        () => retire(key, flight, new RegistryCacheTimeoutError()),
        timeout,
      );
      const finish = () => {
        flight.active = false;
        clearTimeout(flight.timer);
        if (flights.get(key) === flight) flights.delete(key);
        pending.delete(flight);
        if (closed && pending.size === 0) finishClose?.();
      };
      // Defer invocation until tracking is installed; catch synchronous provider throws too.
      void Promise.resolve()
        .then(() => (flight.active ? resolve(trusted, source) : undefined))
        .then(
          (value) => {
            try {
              if (!flight.active) return;
              const route = snapshot(value, trusted.tenantId, source);
              const lifetime = route === undefined ? negativeTtl : ttl;
              const time = now();
              // Provider accessors and custom clocks can reenter invalidation/close.
              if (!flight.active) return;
              if (time >= flight.deadline) {
                retire(key, flight, new RegistryCacheTimeoutError());
                return;
              }
              if (lifetime > 0) {
                for (const [key, entry] of entries)
                  if (time >= entry.expires) entries.delete(key);
                while (entries.size >= maxEntries)
                  entries.delete(entries.keys().next().value!);
                entries.set(key, {
                  tenantId: trusted.tenantId,
                  source,
                  route,
                  expires: time + lifetime,
                });
              }
              accept(route);
            } catch (error) {
              if (flight.active) reject(error);
            } finally {
              // Release actual capacity before consumers can issue their next lookup.
              finish();
            }
          },
          (error: unknown) => {
            if (flight.active) reject(error);
            finish();
          },
        );
      return promise;
    },
    invalidate(target: {
      readonly tenantId: string;
      readonly source?: string;
    }) {
      if (closed) throw new RegistryCacheClosedError();
      const tenantId = target.tenantId;
      const source = target.source;
      validateTenantId(tenantId);
      if (source !== undefined) reference(source, 'source', 256);
      invalidate(
        (entry) =>
          entry.tenantId === tenantId &&
          (source === undefined || entry.source === source),
      );
    },
    clear() {
      if (closed) throw new RegistryCacheClosedError();
      invalidate(() => true);
    },
    close() {
      if (closedPromise) return closedPromise;
      closed = true;
      closedPromise = new Promise<void>((resolve) => {
        finishClose = resolve;
      });
      entries.clear();
      for (const [key, flight] of flights)
        retire(key, flight, new RegistryCacheClosedError());
      if (pending.size === 0) finishClose!();
      return closedPromise;
    },
    stats: () =>
      Object.freeze({ entries: entries.size, pending: pending.size, closed }),
  });
}
