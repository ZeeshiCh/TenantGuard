# @tenantguard/resources

Bounded, process-local ownership of per-tenant resource generations. The manager handles creation sharing, acquisition backpressure, idle eviction, secret/resource revision rotation and shutdown. `createPooledAdapter` keeps each resource leased through an existing database adapter's complete transaction and cleanup lifecycle. The same contract works with Node, NestJS, Hono, Express, Fastify, Koa and other JS/TS backends.

The package has no framework, database-driver or Node imports. Browser import boundaries are checked; concrete drivers and deployment runtimes retain their own support limits. Real integration coverage for this wrapper currently includes PostgreSQL and SQLite.

## PostgreSQL example

```ts
import pg from 'pg';
import { createTenantRouter, type TenantRoute } from '@tenantguard/core';
import { createCachedTenantRegistry } from '@tenantguard/registry';
import {
  createTenantResourcePool,
  createPooledAdapter,
} from '@tenantguard/resources';
import { createPgAdapter } from '@tenantguard/postgres/pg';

const resources = createTenantResourcePool({
  maxResources: 64,
  maxResourcesPerTenant: 2,
  maxLeasesPerResource: 4,
  maxWaiters: 128,
  idleTimeoutMs: 30_000,
  create: async (route: Readonly<TenantRoute>) => {
    // Application-owned allowlist and authenticated secret resolver.
    const connection = await resolveAllowedConnection(
      route.resource,
      route.secretRef,
    );
    const pool = new pg.Pool({ ...connection, max: 4 });
    pool.on('error', handleIdleDatabaseError);
    try {
      await pool.query('SELECT 1'); // Verify the actual credentials before publication.
      return pool;
    } catch (error) {
      await pool.end(); // Factory owns partial allocations if creation rejects.
      throw error;
    }
  },
  destroy: async (pool) => {
    await pool.end();
  },
});
const adapter = createPooledAdapter({
  pool: resources,
  name: 'pg',
  capabilities: { transactions: true, isolationModes: ['database-policy'] },
  createAdapter: (pool) =>
    createPgAdapter({
      resolvePool: () => pool,
      tables: [{ schema: 'public', table: 'orders' }],
    }),
});
const registry = createCachedTenantRegistry({
  registry: authoritativeRegistry,
});
const router = createTenantRouter({
  strict: true,
  registry,
  sources: { orders: { adapter, mode: 'database-policy' } },
});

// Register server-controlled active routes during control-plane initialization.
resources.setRoute(initialOrdersRoute);
// Every request still authenticates and authorizes membership first.
await router.run(verifiedContext, 'orders', (client) =>
  client.query('SELECT * FROM public.orders'),
);

// After the authoritative secret/resource revision change commits:
resources.setRoute(updatedOrdersRoute, initialOrdersRoute.revision);
registry.invalidate({
  tenantId: updatedOrdersRoute.tenantId,
  source: 'orders',
});

// Stop new request admission and control-plane event intake first.
await registry.close();
await resources.close();
```

Connection/secret resolution, error reporting, authoritative registry, route initialization and request authorization are application code. No request URL/header becomes a connection string or secret. New credentials should have a new secretRef and route revision. The manager does not change database passwords, store credential values, provision databases or transport distributed invalidation events. PostgreSQL tests change an actual role password to verify that new pools authenticate with the replacement secret while already-acquired transactions finish on their original connection.

Each native pool also needs a connection limit and native connection/query/cleanup deadlines. maxResources bounds owned pool/resource objects, not the number of sockets created inside one resource. In the example, 64 resources with max 4 connections can own up to 256 data connections, including retiring generations. Other processes and unrelated application pools have independent limits.

## Registration, rotation and isolation

The authoritative selector is the case-sensitive `(tenantId, source, adapter)` tuple. Registering the same complete route is idempotent. Changing resource, secretRef or isolation mode without changing revision is rejected. Updating an existing generation requires `setRoute(next, expectedCurrentRevision)`; stale compare-and-set attempts fail with `ResourcePoolRouteError`. Revisions are opaque strings: the manager cannot sort them or infer event ordering. Only a trusted control plane should register, remove or rotate routes.

`run(route, callback)` requires an exact currently registered active generation, including resource, revision, secretRef and mode. Stale registry snapshots fail closed before a callback starts. Registration remains after idle eviction, so an old route cannot silently recreate an obsolete resource. maxRoutes independently bounds this metadata; use explicit remove for deprovisioning or trusted catalog management. There is no automatic registration from incoming requests. The manager maintains one authoritative route per selector; principal-dependent registry routes must be modeled with distinct server-controlled sources or separate managers.

Rotation retires the old generation from new use, rejects its queued acquisitions and creates the new generation lazily. Acquired leases stay pinned until their callbacks/adapter lifecycles finish. Idle old resources close immediately; busy ones close after their last lease. Rotation overlap still consumes global and per-tenant capacity. A limit of one resource per tenant serializes replacement behind old leases and confirmed disposal. A limit of two allows an old and new generation to coexist when global capacity permits.

`remove({ tenantId, source? })` removes all matching adapter registrations, rejects their queued work and retires their current resources. Omit source for every source of that tenant. It does not revoke acquired transactions. Re-registration is an explicit trusted action. Neither removal nor rotation automatically retries application callbacks.

Coordinate registry invalidation and resource activation on every backend instance. Installing the new managed route before invalidating the registry deliberately makes intervening old cache hits fail closed. Failed/delayed control-plane synchronization can cause temporary routing errors; this package provides no cross-component transaction or distributed delivery guarantee. Query authoritative state and use compare-and-set rather than blindly installing old event payloads. Duplicate removal/invalidation may reduce availability but cannot install a route.

## Capacity and acquisition

Identical generation requests share one factory operation. A ready resource supports bounded concurrent leases; additional callers wait in a bounded queue. Acquisition scans waiting requests in insertion order, allowing other tenants to proceed when one generation is blocked. Under pressure, least-recently-used idle resources are evicted even before their idle deadline. Active, creating, disposing and quarantined resources are never evicted to manufacture free capacity.

Global and per-tenant resource counts include every generation, including native factories still running after timeout, old generations draining leases, pending destruction and failed destruction. The per-tenant bound spans sources and adapters within this manager. Factory rejection frees its slot only after the factory promise settles; the factory must clean partial native allocations before rejecting. A late successful retired factory is adopted solely for destruction and is never handed to application work.

Returned resource objects must be new and exclusively owned. Weak ownership history rejects a previously adopted object, including one returned by another manager using the same module instance. The second manager never destroys the first manager's handle. Separate module copies/processes cannot detect shared ownership: applications must honor the exclusive factory contract.

| Option                | Default              | Meaning                                                                 |
| --------------------- | -------------------- | ----------------------------------------------------------------------- |
| maxResources          | 64                   | Global live/reserved resource bound; integer 1–100,000                  |
| maxResourcesPerTenant | min(2, maxResources) | All generations/sources for one tenant; 1–maxResources                  |
| maxRoutes             | 256                  | Registered authoritative selectors; 1–1,000,000                         |
| maxWaiters            | 128                  | Queued acquisitions; 1–100,000                                          |
| maxLeasesPerResource  | 16                   | Concurrent callbacks per resource; 1–100,000                            |
| acquireTimeoutMs      | 5,000                | Per acquisition, including queue/factory wait                           |
| createTimeoutMs       | 10,000               | Shared generation factory deadline                                      |
| idleTimeoutMs         | 30,000               | Idle time after the last lease finishes                                 |
| destroyTimeoutMs      | 10,000               | Stalled disposal closes admission; actual disposal remains tracked      |
| shutdownTimeoutMs     | 30,000               | Bounded reporting deadline for terminal drain                           |
| clock                 | performance.now      | Finite monotonic milliseconds for acquisition, creation and idle checks |

All durations are integers from 1 to 2,147,483,647 milliseconds. A single automatic idle timer schedules the nearest idle expiry, and `sweep()` also checks idle/factory deadlines. The idle timer is unreferenced on Node so it alone does not keep the process alive. Acquisition/creation deadlines are checked before grants/publication as well as by timer. Disposal timers and the shutdown deadline use host time; shutdown also checks elapsed real monotonic time before reporting successful completion. Invalid bounds or a regressing custom clock fail closed for the affected operation; clock failure during maintenance retires the manager.

`stats()` returns frozen aggregate counts for routes, resources, creating, activeLeases, waiting, disposing, quarantined and closed. It exposes no tenant identifiers, references or credentials. Resource bounds do not replace HTTP admission limits or driver-specific socket/worker limits.

## Lease and shutdown guarantees

`createPooledAdapter` preserves the existing DatabaseAdapter types, validates tenant/adapter/mode, and holds the resource until the underlying adapter's run promise settles. The underlying adapter still owns transaction isolation, commit/rollback, pending native work and scoped-client revocation. A callback/adapter error retires its resource from further use; any other acquired leases drain before destruction. The original work error is preserved. Acquisition is awaited in the caller’s own async context, so queued work preserves request tenant/principal/correlation identity and other AsyncLocalStorage values when a different request grants its lease. The wrapper does not replay transactions or change database isolation modes.

The generic manager's run callback is trusted infrastructure receiving a native resource. Do not expose it or raw handles to request handlers, retain handles outside callbacks, or start detached work. Request code should use the pooled database adapter's scoped client. Recursive acquisition can exhaust leases; reuse the existing scoped client and honor adapters' nested-transaction restrictions.

`close()` is terminal and idempotent, returning one stable promise. It immediately closes admission, rejects queued acquisitions and retires every resource. Active callbacks and actual factory/disposal promises stay tracked. It resolves only after all owned resources are confirmed destroyed. Never-started factory/work callbacks are skipped. Active work is not force-closed when a deadline expires.

A failed destroy quarantines its capacity, closes the entire manager to new work and causes shutdown to report `ResourcePoolCleanupError` with original causes. A destroy timeout also closes admission but keeps the real disposal operation counted. A shutdown deadline rejects with `ResourcePoolTimeoutError` (phase shutdown), without claiming that native work was cancelled or resources closed. The manager continues draining late completions; subsequent close calls return the same rejected promise. Inspect stats and apply application supervision after failure. A broken destroy contract cannot be repaired automatically, and a never-settling callback/native operation can remain live after the reporting deadline.

Errors are `ResourcePoolRouteError`, `ResourcePoolCapacityError`, `ResourcePoolClosedError`, `ResourcePoolTimeoutError` (acquire/create/destroy/shutdown), or `ResourcePoolCleanupError`. Original factory/work errors propagate. Cleanup failures are reported by close and terminal stats rather than silently recycling uncertain capacity. Application shutdown should stop request/control-plane intake, retire the registry cache, close this resource manager and only then close any external shared infrastructure after successful draining. Failed shutdown is not successful disposal.

## Verification and deployment

27 unit/concurrency cases cover 100 callers, queue/lease/resource bounds, tenant/case/source separation, idle/LRU eviction, compare-and-set rotation, stale/removal rejection, pending factories, native disposal accounting, deadline reporting, duplicate ownership and reentrant publication races. PostgreSQL integration tests exercise RLS concurrency, actual password rotation with pinned transactions, rollback before retirement, automatic connection eviction, blocked native factories, shutdown during advisory-lock queries and a real pool.end stall. SQLite tests verify scoped concurrency and file rotation while a transaction stays pinned to its original worker/file. These suites also pass on Node 22.

```sh
node --import tsx --test tests/resources.test.ts
node --import tsx --test tests/resources.integration.ts tests/resources-sqlite.integration.ts
```

The package runs inside each backend process and needs no separate service deployment. Resource limits and control-plane delivery are per process. Packed JavaScript and fully strict TypeScript consumers verify export/type integration. Other native adapters satisfy the same public contract, but resource-wrapper failure certification beyond PostgreSQL/SQLite, distributed coordination and production performance certification remain future work. No package/service is published or deployed by this milestone.
