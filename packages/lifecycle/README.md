# @tenantguard/lifecycle

Explicit tenant provisioning, migration, suspension/resume and recovery. Requests route only through a verified active generation. The root entry point provides a portable controller, store contracts and a bounded single-process reference store. The `/pg` entry point adds durable PostgreSQL state, transactional schema/data execution and request admission in the actual data transaction.

This is trusted control-plane code. Authentication, management authorization, reviewed migration SQL, secret resolution and deployment coordination are application responsibilities. Ordinary request handlers never create schema or grant privileges.

## PostgreSQL setup

Generate and review bootstrap SQL before applying it with an administrative role:

```ts
import { pgLifecycleSchemaSql } from '@tenantguard/lifecycle/pg';

const bootstrap = pgLifecycleSchemaSql({
  schema: 'public',
  table: 'tenantguard_lifecycle',
  managementRole: 'tenant_migrations',
});
// Apply bootstrap explicitly, then grant this table's SELECT/INSERT/UPDATE
// to tenant_migrations and SELECT only to the restricted runtime role.
```

Bootstrap creates a key/version/JSONB table, forces RLS, installs tenant-filtered SELECT and optionally an explicit management policy. It does not create roles, grant privileges or run automatically. Identifiers are restricted and quoted. The management role needs the appropriate schema/data privileges for reviewed tenant migrations; runtime roles must not inherit it. Give the management role an explicit metadata policy rather than granting global BYPASSRLS. Runtime metadata reads remain filtered by the data transaction's verified tenant context.

```ts
import { createTenantRouter } from '@tenantguard/core';
import { createCachedTenantRegistry } from '@tenantguard/registry';
import {
  createTenantLifecycle,
  createLifecycleRegistry,
} from '@tenantguard/lifecycle';
import {
  createPgLifecycleStore,
  createPgLifecycleAdapter,
} from '@tenantguard/lifecycle/pg';

const store = createPgLifecycleStore({
  connection: managementConnection, // Separate control-plane credentials.
  maxConnections: 8,
  maxPending: 128,
  statementTimeoutMs: 5_000,
});
const registry = createCachedTenantRegistry({
  registry: createLifecycleRegistry(store),
});
const lifecycle = createTenantLifecycle({
  store,
  onChange: async (state) => {
    // Application-owned local publication; deliver trusted events to other instances too.
    registry.invalidate({
      tenantId: state.route.tenantId,
      source: state.route.source,
    });
    await reconcileLocalResourcesWithAuthoritativeState(state);
  },
});
const adapter = createPgLifecycleAdapter({
  // The direct native pg adapter, optionally wrapped by createPooledAdapter.
  adapter: configuredPgAdapter,
});
const router = createTenantRouter({
  strict: true,
  registry,
  sources: { orders: { adapter, mode: 'database-policy' } },
});

await lifecycle.provision({
  route: initialActiveRoute,
  operationId: 'provision-command-123',
  schemaVersion: 'v1',
  work: async (execution) => {
    await reviewedTenantBootstrap(execution, initialActiveRoute);
  },
  verify: async (execution) => {
    await verifyTenantSchemaDataAndPolicies(execution, initialActiveRoute);
  },
});

// After normal request authentication and membership authorization:
await router.run(verifiedContext, 'orders', (client) =>
  client.query('SELECT * FROM public.orders'),
);
```

The connection, configured pg adapter, routes, SQL helpers, resource reconciliation and verified request context in this example are application code. SQL helpers must execute through the supplied execution facade, await their queries and throw on verification failure. Verification resolves without a return value; returning false/true/another value is rejected. The controller cannot infer application-specific schema readiness from an empty verifier.

## Lifecycle states and commands

| Command   | Required state                                                                  | Durable transitions                                                 | Request routing                                          |
| --------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| provision | No existing record                                                              | pending → provisioning → active                                     | Denied until verified activation commits                 |
| migrate   | active, exact expectedVersion, new route revision                               | migrating → active                                                  | New admissions denied; admitted transactions drain first |
| suspend   | active, exact expectedVersion                                                   | suspended, then admission drain                                     | Denied; acquired transactions finish                     |
| resume    | suspended, exact expectedVersion, new route revision                            | migrating → active after verification                               | Denied until verified activation commits                 |
| recover   | pending/provisioning/migrating/failed, matching operationId and expectedVersion | Operation phase → active after explicit reconciliation/verification | Denied while recovery is incomplete                      |

Failures remain inactive, normally failed. Loss of the management session can leave provisioning/migrating persisted because that connection cannot write a failure record; it never makes unfinished work active. Restarting a process does not reset durable state. Recovery is explicit after inspecting the recorded target and actual schema, using idempotent reconciliation appropriate to the observed outcome.

```ts
const current = await store.read({ tenantId, source: 'orders' });
if (!current) throw new Error('No lifecycle state');

await lifecycle.migrate({
  route: nextActiveRoute, // Same tenant/source/adapter/mode; a new opaque revision.
  expectedVersion: current.version,
  operationId: 'migration-command-456',
  schemaVersion: 'v2',
  work: async (execution) => {
    await execution.query('ALTER TABLE tenant_a_payload ADD COLUMN note text');
  },
  verify: async (execution) => {
    const result = await execution.query(
      'SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3',
      ['public', 'tenant_a_payload', 'note'],
    );
    if (result.rows[0]?.n !== 1)
      throw new Error('Migration verification failed');
  },
});
```

The SQL example operates on an allowlisted tenant-specific table. **A tenant/source fence does not cover other tenants or sources sharing a table.** Shared-schema/global migrations need an externally coordinated barrier and compatibility rollout across every affected tenant. PostgreSQL database creation, nontransactional commands, cross-database/server moves and external cloud provisioning are outside the certified transactional backend. Application rollback cannot automatically undo arbitrary external effects or destructive changes.

Use `lifecycle.recover({ key, expectedVersion, operationId, work, verify })` to reconcile an interrupted recorded operation. Its target route/schema/kind come from persisted state; callers cannot silently replace the target during recovery. Repeating the currently recorded completed operation with the same ID and exact target/schema returns its active result and republishes hooks without rerunning work or verification. A failed/incomplete operation never automatically replays. Reusing an ID for another target conflicts. Only the current operation receipt is retained; this is not a complete audit ledger or permanent deduplication history.

Numeric state version is a consecutive compare-and-set token. Route revision and schemaVersion are opaque strings, not sortable semantic versions. Migration/resume cannot change adapter or isolation mode through an existing source. The last applied schemaVersion remains unchanged during an operation/failure; operation.schemaVersion records the intended target. State/route/operation snapshots are validated and frozen, with bounded references and no persisted exception text or credential values.

## Why routing needs the adapter fence

`createLifecycleRegistry` exposes lifecycle routes through the ordinary TenantRegistry interface. The core router rejects every non-active status, including provisioning. Registry caching alone does not revoke an already-cached active route. Always install the corresponding lifecycle adapter as well.

For PostgreSQL, `createPgLifecycleAdapter` acquires a shared transaction-level advisory lock on the real pg data client, checks authoritative metadata and exact route identity, and keeps the lock through commit/rollback. It checks transaction identity before application work so an implicit/autocommit client cannot masquerade as a pinned transaction. Management first persists an inactive state, then obtains the matching exclusive transaction lock before work/verification. Transactional DDL and active metadata commit together. The guard and metadata must be in the **same PostgreSQL primary/database** as the admitted transaction.

A lock held on a separate control-plane connection would be insufficient: losing that connection could release admission while the data transaction still runs. Native data-transaction locking instead makes connection loss abort the data transaction before migration obtains the fence. PostgreSQL locks are automatically released at transaction end; the backend never steals them after a timer or claims cancellation merely because a caller stopped waiting. See [PostgreSQL advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS) and [node-postgres transaction ownership](https://node-postgres.com/features/transactions).

The adapter requires the native transactional pg adapter, optionally wrapped by the resource manager. Existing PostgreSQL isolation/role/policy checks, transaction handling and scoped-client cleanup still apply. Neither the lifecycle record nor its schema version replaces database isolation or request membership authorization. Guard every relevant route/source; unwrapped/raw SQL is outside lifecycle admission guarantees.

## Publication, caches and resource generations

`onChange` runs after durable state transitions, including inactive states before DDL and active state after commit. Use it for trusted cache invalidation and resource reconciliation. Inactive states should retire/remove local managed routes; activation should install the currently authoritative active resource generation. Existing acquired resource leases remain pinned through the native adapter's cleanup.

Metadata fencing keeps stale cached routes and publication failures fail-closed even when an invalidation event is missed. A stale route also remains rejected after a new revision activates. Hook failure can reduce availability; it does not bypass verification. `LifecyclePublicationError` includes `committed: true` and the committed state. For an active state, work/schema publication has already committed: retry the identical completed command to repair publication, never blindly rerun DDL. A hook failure during blocking publication prevents work from starting and leaves the tenant inactive.

Publishers can fail, disconnect or deliver stale events. Re-read authoritative state, reconcile versions, and handle resource compare-and-set conflicts. Across instances, provide authenticated event delivery/reconnect handling yourself. These hooks are not a durable outbox, distributed transaction or exactly-once transport; a process can crash between state commit and hook delivery. Resource registration must never trust a stale event payload as authority. Refer to the [registry](../registry/README.md) and [resource](../resources/README.md) guides for their bounds and lifecycle behavior.

## Execution and concurrency guarantees

A control lock serializes each tenant/source operation. PostgreSQL holds one session-level control lock and reuses that same pinned connection for the exclusive execution transaction and authoritative reads from its publication hooks, avoiding second-connection deadlocks under pool pressure. Independent tenants can proceed concurrently within native capacity. Runtime shared admission and management exclusive admission use another lock namespace. Lock-hash collisions can serialize unrelated keys but never substitute another key's validated metadata.

Each PostgreSQL work/verification phase receives a fresh expiring execution facade. One extended-protocol SQL statement is accepted per call; transaction-control statements are rejected. Caught SQL errors, rejected transaction escapes and outstanding unawaited queries prevent commit. Late phase queries reject without executing. Actual pending native promises drain before rollback/release. Transaction identity is checked before commit, and every checked-out management client is destroyed after its scope to avoid advisory/session contamination. Native pool errors are handled; uncertain COMMIT reports `PgLifecycleCommitError` with outcome unknown.

Control/execution scopes are not recursive. Nested/cross-key management scopes on one store and expired asynchronous control contexts reject rather than silently acquire fresh locks. Callbacks must use their supplied execution facade, not external database handles or detached jobs. Side effects outside it cannot be rolled back/fenced by this backend. A custom store must supply genuine compare-and-set, control serialization, transactional publication and target-specific admission semantics before claiming distributed safety.

| Controller option  | Default | Behavior                                                            |
| ------------------ | ------- | ------------------------------------------------------------------- |
| maxOperations      | 16      | Actual unsettled management commands, including timed-out callbacks |
| operationTimeoutMs | 60,000  | Reporting deadline; actual native work remains tracked and fenced   |
| shutdownTimeoutMs  | 30,000  | Terminal drain reporting deadline                                   |
| onChange           | none    | Application-owned post-transition publication hook                  |

| PostgreSQL store option | Default                      | Behavior                                                                  |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| maxConnections          | 8                            | Owned metadata/control pool; 2–1,024                                      |
| maxPending              | 128                          | All actual active/queued native scopes; 2–100,000                         |
| statementTimeoutMs      | 5,000                        | Server-side statement/lock deadline                                       |
| shutdownTimeoutMs       | 30,000                       | Bounded close reporting; active/queued work stays tracked                 |
| connection              | required                     | Separate management PoolConfig; finite native connection timeout enforced |
| schema/table            | public/tenantguard_lifecycle | Validated, quoted metadata location                                       |

Controller count limits and durations must be positive integers up to 2,147,483,647; PostgreSQL count limits additionally have the bounds above. Native connection acquisition is bounded by the smaller of the configured finite connection timeout and statement timeout. Client-side pg query_timeout is disabled so a rejected waiter is not mistaken for finished native I/O. Pool configuration, database timeouts and supervision remain application-owned. No automatic callback retry occurs.

An operation timeout rejects the caller but retains its actual task/capacity and database fence until settlement. Checkpoints prevent work/verification that finishes after expiry from dispatching activation COMMIT. If COMMIT was already dispatched when a deadline/connection failure occurs, its result can be unknown: inspect durable operation state before recovery. The timeout is not proof of rollback. SQL execution and publication promises must settle before draining completes.

`close()` on controller/store is terminal and idempotent, with one stable promise. New work rejects; actual work and queued native acquisitions remain counted. A close deadline reports without force-closing admitted transactions or discarding late completion. Subsequent close calls return the same rejected promise even if native draining later finishes. Controller close does not own/close a shared store, caches, data pools or event subscriptions. Stop request/management intake and event delivery, drain the controller and data resources, then close the store and external infrastructure. Closing one management process does not suspend healthy tenants cluster-wide.

Errors include LifecycleConflictError, LifecycleBusyError, LifecycleUnavailableError, LifecycleRecoveryError, LifecycleClosedError, LifecycleTimeoutError, LifecyclePublicationError and PgLifecycleCommitError. Native failures propagate; failure-publication/rollback uncertainty can produce AggregateError with original causes. Controller/store stats expose frozen counts and closed state, without tenant IDs or secrets.

## Portable reference backend

`createMemoryLifecycleStore({ maxRecords: 1024, maxLocks: 128, shutdownTimeoutMs: 30000 })` supports the same state machine and transactional metadata staging in one process. Records are not evicted; active/control/admission lock work is bounded, with at least two lock slots. Wrap a database adapter with `createLifecycleAdapter({ store, adapter })` and use `createLifecycleRegistry(store)`.

This reference store loses state on restart and does not coordinate multiple processes. It is appropriate for tests and explicitly single-process use, not durable production provisioning. The root APIs contain no Node/database imports and pass browser import-boundary checks. Other databases/backends can implement the contracts, but durable migration/admission certification beyond PostgreSQL remains future work. A PostgreSQL store deliberately has no separate-control-connection `withAdmission` method: use the native pg lifecycle adapter for its transaction-owned fence.

## Verification and deployment

22 unit/concurrency cases exercise transitions, idempotency, CAS conflicts, stale caches, admission drains, explicit recovery, suspension/resume, verification/publication failures, snapshotting, capacity, shutdown and caller-context preservation. Twelve real PostgreSQL cases plus their parent verify schema/data provisioning, concurrent controllers, actual transactional DDL rollback, durable recovery, restricted metadata credentials, request/management connection loss, operation/close deadlines, phase query safeguards, six concurrent tenants and hook re-reads on a two-connection pool, and queued native acquisition during shutdown. All 35 lifecycle tests pass on Node 22.

```sh
node --import tsx --test tests/lifecycle.test.ts
node --import tsx --test tests/lifecycle.integration.ts # Docker required
```

Packed JavaScript and strict TypeScript consumers check root/pg exports and prevent substituting the metadata connection for native data-transaction admission. The library runs in backend processes and trusted administrative workers/jobs; it needs no TenantGuard-hosted service. State lives in your PostgreSQL database under separately managed credentials. No package, service or production schema is deployed or published by this milestone.
