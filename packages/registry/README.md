# @tenantguard/registry

Portable process-local caching for the `TenantRegistry` contract. Works with every explicit-context database router and with Node, NestJS, Hono, Express, Fastify, Koa and Fetch backends. The cache has no framework, database-driver or Node imports. Browser bundling is verified; edge-platform deployment is not certified.

```ts
import { createTenantRouter, type TenantRegistry } from '@tenantguard/core';
import { createCachedTenantRegistry } from '@tenantguard/registry';

// Application-owned provider: load server-controlled routing metadata.
const provider: TenantRegistry = {
  resolve: async (context, source) =>
    loadRouteFromControlPlane(context, source),
};
const registry = createCachedTenantRegistry({
  registry: provider,
  ttlMs: 5_000,
  maxEntries: 1_024,
  maxPending: 128,
  lookupTimeoutMs: 5_000,
});
const router = createTenantRouter({
  registry,
  sources: configuredDataSources,
});

// In an already authenticated/authorized request:
await router.run(verifiedContext, 'orders', async (client) => {
  // Use the selected database adapter's scoped API.
});

// After committing a trusted control-plane route/status/secret revision change:
registry.invalidate({ tenantId: changedTenantId, source: 'orders' });
// Omit source to invalidate every source and identity variant for this tenant.
// registry.clear() invalidates every local cached route and pending lookup.

// Terminal shutdown; close application-owned resources after requests drain.
await registry.close();
```

The example's provider loader, configured data sources and request context are application code. Authorization must run for every request; this package caches routing metadata, not credentials or tenant membership.

## Cache and validation rules

Keys encode tenantId, principalId, correlationId and source as a tuple, preserving case and avoiding delimiter collisions. The provider receives a frozen verified-context snapshot. Context fields are never dropped to improve hit rates: a provider may use principal or correlation identity to choose a route. Unique correlation IDs therefore intentionally prevent hits across those requests. Identical concurrent lookups share one upstream operation; different contexts and sources do not.

Routes are copied, validated and frozen before publication. Tenant/source must match the lookup; status and isolation mode must be known. Resource, adapter, revision and optional secretRef must be nonempty strings of at most 2,048 code units without control characters; source is bounded to 256. Only declared routing fields are retained. Revisions are opaque strings, not sortable numbers. The current resolve contract does not accept an expected revision: the cache stores the provider's revision with its snapshot and replaces it after invalidation/expiry. It cannot infer a newer revision before consulting the provider.

Pending, suspended, migrating and failed routes may be cached; the core router still rejects every non-active route before invoking an adapter. Missing routes are not cached by default. Provider failures and invalid routes are never cached. There is no stale-on-error fallback, background refresh or automatic retry.

| Option          | Default         | Allowed values / behavior                                                                   |
| --------------- | --------------- | ------------------------------------------------------------------------------------------- |
| ttlMs           | 5,000           | Integer 1–86,400,000; TTL starts when a successful load completes                           |
| negativeTtlMs   | 0               | Integer 0–86,400,000; positive values opt into caching missing routes                       |
| maxEntries      | 1,024           | Integer 1–1,000,000; least-recently-used eviction                                           |
| maxPending      | 128             | Integer 1–100,000; actual unsettled upstream work, including retired lookups                |
| lookupTimeoutMs | 5,000           | Integer 1–2,147,483,647; per shared lookup, not per waiter                                  |
| clock           | performance.now | Finite monotonic milliseconds for TTL/deadline checks; custom clock regression fails closed |

Expiry is lazy: expired entries are unusable immediately, removed on access or the next successful cache insertion, and remain within maxEntries until then. Stats returns a frozen `{ entries, pending, closed }` snapshot; entries can include expired items. No keys, contexts, credentials or routes appear in stats. The bounds govern cache storage and native lookups; applications still own HTTP admission/rate limits and control-plane driver timeouts.

## Invalidation and deployment

Invalidate only from trusted application/control-plane code, after committing the authoritative change. Targeted invalidation removes all cached principal/correlation variants and rejects active matching lookup waiters with `RegistryCacheInvalidatedError`. Late results are discarded even if a newer lookup finishes first. Clearing does the same globally. Neither operation revokes routes already returned or cancels database transactions already acquired. Route changes during an active transaction do not move that transaction to another resource.

This is a local in-memory cache running inside each backend process, with no separate deployment. Multi-process applications must deliver authenticated invalidation events to every instance themselves; no Redis/pub/sub client, durable outbox, ordering protocol or event subscription is owned by this package. Duplicate or delayed invalidations safely evict again, potentially causing extra loads. They never install a route payload from an event. After reconnecting an invalidation channel, clear the local cache before resuming traffic; if invalidation delivery cannot meet your suspension/rotation requirements, stop routing through that cache rather than assuming immediate revocation. TTL provides a staleness bound after an authoritative change becomes visible to the provider, not a distributed consistency guarantee. Provider/replica lag can extend effective staleness.

A cached active route remains usable until invalidation/expiry even if the provider becomes unavailable; once expired or invalidated, lookup failure propagates. A cached suspended route remains denied until refresh. Keep TTL/negative TTL consistent with the application's availability and revocation requirements. Credential values belong in a separate application-owned secret resolver; secretRef/resource revision changes do not automatically close old pools. Resource pinning, rotation and pool disposal remain adapter/application responsibilities.

## Failure and shutdown lifecycle

`RegistryCacheTimeoutError` ends waiters when a shared deadline expires. Deadlines are checked when joining a load and before publishing a result, in addition to a timer. `RegistryCacheCapacityError` rejects new distinct loads when actual outstanding work is full. These paths do not cancel the provider, free its real capacity prematurely or permit a late result to repopulate the cache. Late failures are consumed. Existing unexpired cache hits remain usable under lookup pressure.

`close()` is terminal and idempotent, returning the same promise. It synchronously retires the cache, clears stored routes and rejects lookup waiters with `RegistryCacheClosedError`. It then waits for every actual provider operation to settle. Resolve rejects after closure; invalidate/clear throw. Work not yet dispatched is skipped. The provider, its connections and external event subscriptions are not closed by this wrapper. A provider that never settles can keep close pending indefinitely: configure native provider deadlines; a cache timer cannot cancel I/O under the existing TenantRegistry interface.

During application shutdown, stop admitting requests, stop your invalidation subscription, retire/drain this cache, wait for already-acquired database work to settle, then close the application-owned provider and data pools. Never destroy a provider pool merely because a cache waiter timed out. No automatic transaction or business-callback retry occurs.

## Verification

18 unit/concurrency cases cover identity-safe keys, single-load sharing, TTL/LRU/negative-cache bounds, failures, route validation, invalidation storms and old/new races, absolute deadlines, reentrant invalidation and terminal draining. Real HTTP/PostgreSQL integration tests use a read-only control-plane role separate from tenant data credentials and exercise concurrent RLS routing, resource/secret revision changes, suspension, missing routes, provider failure, late native results a native advisory-lock timeout that retains capacity, and shutdown during an actual pg_sleep query. These tests also pass on Node 22. Packed JavaScript and fully strict TypeScript consumer checks and a browser import-boundary build verify exports and portability.

```sh
node --import tsx --test tests/registry.test.ts
node --import tsx --test tests/registry.integration.ts # Docker + localhost HTTP
```
