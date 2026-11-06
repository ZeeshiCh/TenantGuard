# Architecture decision: portable tenant boundary

Implemented foundation, November 6, 2026. The broader [implementation plan](implementation-plan.md) remains the roadmap; only the adapters listed below exist today.

## Dependency direction

```text
Framework (Fetch / Hono / NestJS / Express / Fastify / Koa / other backend)
    -> TenantGuard authorizer -> immutable explicit TenantContext
    -> portable multi-source router -> DatabaseAdapter<Client>
    -> driver-owned transaction/session -> database

Optional Node AsyncLocalStorage carrier -> portable ContextCarrier contract
```

Core contains no Node, framework, driver or ORM imports. It accepts opaque, case-sensitive tenant IDs (1–256 JavaScript string code units, no surrounding whitespace/control characters). Numeric IDs must be converted to an application's canonical string representation at the authorization boundary. UUID encoding belongs to the PostgreSQL adapter, which currently requires canonical lowercase UUIDs for its UUID policy. No normalization occurs in core.

`createTenantGuard({ authorize, carrier? })` is the common entry point. `authorize` receives a framework-specific input and must return a tenant context only after authentication, membership and tenant-status checks. Returning undefined denies access; provider failures propagate. Context snapshots are frozen and contain only tenantId, optional principalId and optional correlationId. No credentials are carried in request context.

`guard.run(input, context => ...)` works without any ambient state. Fetch handlers and Hono context variables use this explicit context. On Node, supply `nodeContext` or an isolated `createNodeContextCarrier()` for asynchronous propagation. The default Node carrier is shared by Express, Fastify, Koa, NestJS and legacy TypeORM convenience helpers. Custom carriers must be passed explicitly and do not affect those helpers.

`createTenantContext`, `runWithContext` and `runWithTenant` are trusted application primitives, not authentication APIs or unforgeable security tokens. Application code and configured plugins are trusted. Core does not defend against arbitrary malicious application code or SQL injection.

Node scopes reject a different tenant or principal while another scope is active. The portable explicit-context path has no global or stack-based ambient fallback: such a fallback would mix concurrent requests. Async resources created inside a Node scope can retain its context after the parent callback completes. Await work; create new authorized scopes for jobs and reauthorize detached work.

## Multiple databases

`createTenantRouter` receives named sources, each with an adapter and an explicit isolation mode, plus a server-controlled `TenantRegistry`. Every run takes a context and source name. The router snapshots input context and registry output, requires an active route matching tenant, source, adapter and isolation mode, and rejects missing routes or invalid resource references before invoking a driver.

Source types preserve each client's API: an SQL source can expose an EntityManager while another source exposes a document client. There is no common pretend SQL API for unrelated engines. The registry returns opaque resource/secret references rather than client-controlled URLs. No registry cache, secret manager, provisioning system or pool manager is implemented yet.

Modes are `database-policy`, `database-per-tenant` and `application-filter`. Adapter capabilities are declarations by trusted adapters, not independent security proofs. A requested unsupported mode is rejected at construction, and strict mode disallows application filtering. Separate-resource mode alone cannot prove credential isolation; adapters must document and verify that in their implementation.

A DatabaseAdapter owns acquisition, enforcement, transaction/session lifetime and cleanup before its run promise resolves. It must discard connections when cleanup is uncertain. Clients must not escape callbacks. Core does not implement those lifecycle details or intercept arbitrary external queries.

The `createTypeormPostgresAdapter(resolveSource)` bridges the portable router to existing PostgreSQL enforcement. Its resolver maps allowlisted resource references to configured DataSources. Only database-policy mode is currently supported by this adapter. Named sources do not imply cross-source ACID transactions. Nested tenant transaction helpers are rejected; use the callback manager for queries in the existing transaction. Savepoint/reuse behavior is deferred until separately specified and tested.

## Direct PostgreSQL lifecycle

The `@tenantguard/postgres/pg` subpath provides `createPgAdapter` without adding a framework or ORM dependency. It consumes the same DatabaseAdapter contract and explicit context as TypeORM. The SQL helper root entry point does not load the driver adapter.

The adapter requires a dedicated pg pool and declared ordinary protected tables. Before callback execution it checks role identity, reachable privileged roles, FORCE/enabled RLS, table ownership/TRUNCATE/schema CREATE privileges, a UUID NOT NULL tenant column and an all-command PUBLIC restrictive policy. Policy expressions and undeclared tables still require independent review.

Connections are pinned through transaction-local settings and commit/rollback. Acquisition, work, statements, locks and cleanup have bounded limits. A late-acquired connection is destroyed. The promise-only query facade uses unnamed extended-protocol statements and rejects raw transaction/session commands. Pending or swallowed failed queries cannot lead to commit. Closed/escaped facades reject new work.

Cleanup verifies no session tenant remains, resets settings/role and releases advisory locks. Cleanup uncertainty, socket errors, timeouts and safety failures destroy the client. Errors distinguish committed, not-committed and unknown outcomes where necessary; callers must not equate every failure with safe-to-retry rollback. A callback timeout cannot cancel arbitrary non-database application side effects.

The TypeORM adapter keeps its own lifecycle; the direct adapter does not wrap or certify ORM pool behavior. See the [pg guide](../packages/postgres/README.md) for details and unsupported features.

Reusable `adapterConformanceCases` are independent of a test runner and driver. Fixtures map each driver's operations to common seeded records; cases check isolation, CRUD, rejected ownership changes, missing context/routes, concurrency and requested rollback guarantees. Both TypeORM and direct pg execute the suite against PostgreSQL. Driver-specific lifecycle tests supplement it.

## SQL Server session ownership

The SQL Server adapter implements the same portable DatabaseAdapter contract using Tedious and an adapter-owned physical connection pool. This deliberately avoids ORM or node-mssql transaction helpers that return a lease to their pool at commit/rollback, before TenantGuard can clear session state.

Policy migrations generate a schema-bound inline predicate and enabled FILTER/AFTER INSERT/AFTER UPDATE BLOCK predicates. Runtime context is SESSION_CONTEXT, not transaction-local. Explicit clearing, verification, driver reset and a second verification all occur on the pinned connection before release. Reset or clearing uncertainty destroys that connection. Read-only poisoned keys are rejected through destruction rather than exposed to another tenant.

The adapter validates effective privileges, declared policy bindings and tenant columns, serializes requests and checks tenant/user/database/transaction/options after each data batch. Persistent SET options use a TDS batch rather than sp_executesql. Reusable conformance tests plus real request cancellation, lock timeouts, role grants and backend termination tests verify this lifecycle.

This is a trusted parameterized T-SQL batch interface, not a general SQL parser: embedded transaction/session management is outside its contract. Database-policy mode does not certify arbitrary function bodies, modules or undeclared tables. SQL Server 2022 is tested locally under x86-64 emulation on ARM; native Linux CI is configured but not run remotely. See the [SQL Server guide](../packages/sqlserver/README.md).

## MySQL-family scoped CRUD

MySQL and MariaDB use separate native drivers and factories over a shared scoped-sql compiler/lifecycle package. Their capabilities contain only application-filter, so the router's strict mode rejects them. Outside-facade visibility is explicitly tested to avoid equating this mode with database RLS.

The callback exposes only registered table repositories and equality-based CRUD. Tenant IDs are injected on insert, immutable on update, and independently ANDed into every read/update/delete predicate. A byte-exact BINARY check defeats case/accent/PAD SPACE collation aliases, while UTF-16 validation prevents lossy UTF-8 identity collisions. The compiler is a restricted grammar builder, not SQL rewriting or arbitrary-fragment filtering.

Dedicated physical pools pin transactions, reject non-InnoDB/invalid tenant schemas, serialize prepared operations, poison swallowed failures, release advisory locks and fully reset before reuse. Native MySQL2/MariaDB reset methods handle both server state and driver prepared caches; callbacks cannot use raw connections. Tests exercise the same conformance cases on both engines plus real lock/request/work deadlines, cleanup, collation aliases and socket termination. Low-level infrastructure remains trusted and may bypass application filtering; triggers/constraints require separate review.

See the [shared guide](../packages/scoped-sql/README.md). The compiler source has a browser import-boundary check, but concrete drivers and lifecycle are Node-only. No raw SQL, joins, upserts or ORM integration is claimed by this milestone.

## Current support

| Area                            | Implemented                                                                                                                                                            | Still planned                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Portable core                   | Explicit scopes, authorization contract, routing/capability contracts                                                                                                  | Provisioning, full diagnostics                                                                                                   |
| Registry cache                  | Portable bounded TTL/LRU cache, full-context keys, lookup coalescing, targeted/global invalidation, terminal drain; real HTTP/PostgreSQL tests                         | Distributed event transports, provisioning and owned resource/pool lifecycle                                                     |
| Tenant resources                | Bounded owned resource generations, idle/LRU eviction, compare-and-set secret/resource rotation, lifecycle leases and shutdown deadlines; real PostgreSQL/SQLite tests | Cross-process coordination, broader native failure certification and production performance certification                        |
| Tenant lifecycle                | Portable provisioning/migration/recovery controller and local reference store; durable PostgreSQL CAS, transaction-owned admission and atomic verified activation      | Durable backends beyond PostgreSQL, cross-database/external provisioning, global schema coordination and durable event transport |
| Node                            | Default and isolated AsyncLocalStorage carriers                                                                                                                        | Worker/stream-specific lifecycle certification                                                                                   |
| Fetch                           | Request handler wrapper; explicit context                                                                                                                              | Platform-specific runtime certification                                                                                          |
| Hono                            | Typed middleware; explicit context or supplied Node carrier; request-level concurrency tests                                                                           | Bun/Deno/Workers certification, full HTTP server example                                                                         |
| NestJS                          | Authorizer option, legacy resolver, interceptor/decorator; subscription lifecycle tests                                                                                | Full HTTP/e2e and non-HTTP integrations                                                                                          |
| Express / Fastify / Koa         | Guard authorization, shared Node context, custom carriers; real HTTP isolation, error and disconnect tests on majors 5 / 5 / 3                                         | Other majors, WebSockets, workers and long-lived streaming certification                                                         |
| PostgreSQL                      | UUID policies, direct pg adapter with guarded lifecycle, TypeORM helpers; shared real-database conformance                                                             | Policy-expression analysis, partition/proxy certification and TypeORM lifecycle parity                                           |
| SQL Server                      | Native RLS policy helpers, dedicated Tedious pool, verified session cleanup, real conformance/lifecycle tests                                                          | Azure SQL and authentication/runtime/version expansion                                                                           |
| MongoDB                         | Scoped JSON CRUD and single-stream aggregation, replica-set transactions, bounded session cleanup; real conformance                                                    | Application filtering only; standalone/sharded deployments and arbitrary BSON/pipelines are deferred                             |
| MySQL / MariaDB                 | Native-driver scoped CRUD, binary tenant predicates, dedicated pools and verified reset; same real-engine conformance                                                  | Native RLS-equivalent protection and complex direct queries remain deferred; ORM scope is listed separately                      |
| SQLite                          | Worker-owned file CRUD, binary/type ownership predicates, transaction-state verification and close per scope; real conformance                                         | Application filtering only; native file access bypasses it; provisioning, ORM/runtime/storage expansion are deferred             |
| Prisma                          | Generated scalar-model metadata, allowlisted tenant CRUD, owned interactive transactions and disconnect per scope; real PostgreSQL/MySQL/MariaDB conformance           | Other Prisma providers/versions, relation/query parity, shared pools, extensions and native-policy mode                          |
| Drizzle                         | Concrete scalar-table CRUD, binary ownership predicates and native connection/transaction ownership; real PostgreSQL/MySQL/MariaDB conformance                         | Other providers/drivers, full query/relation parity, external pools, runtime hooks and native-policy mode                        |
| Mongoose                        | Isolated scalar-model CRUD, shared aggregation policy and explicit session ownership; real replica-set conformance                                                     | Existing model/plugin/query parity, broad BSON/schema support, sharded/Atlas certification and native-policy mode                |
| Other databases/ORMs/frameworks | Public contracts only                                                                                                                                                  | Concrete adapters and real-engine conformance suites                                                                             |

Portability checks build core/Fetch/Hono for a browser target and reject Node imports in that graph. They establish an import boundary, not certification of edge deployment or database connectivity. Packed core/Node/Fetch/PostgreSQL/SQL Server/MySQL/MariaDB/MongoDB/SQLite/Prisma/Drizzle packages are installed into an isolated temporary consumer offline and tested as JavaScript and TypeScript. Mongoose has a separate fully strict consumer using its actual driver dependency closure, so driver 7 sessions/BSON are not flattened into the direct adapter’s driver 6 closure.

## Phase 0 verification and limitations

The previous integration test had never completed locally. Running it against PostgreSQL exposed an incorrect expectation for TypeORM update/delete results. It now checks the actual `[rows, affectedCount]` tuple, retaining both zero visible rows and zero affected rows assertions.

CI uses clean frozen-lockfile installs, formatting, strict TypeScript unused-symbol checks, unit tests, portability bundles, package builds, packed-package consumer smoke tests and PostgreSQL integration testing. Node 22 and 24 are configured as CI targets; local results do not claim remote CI has already run. No independent security review has occurred.

Remaining foundation work includes distributed publication delivery, broader lifecycle backends and provisioning targets, nested transaction specification beyond explicit rejection, additional framework and database adapters, runtime certification and independent review. The full roadmap is not complete. The direct pg and conformance milestone is recorded in [progress](progress.md).

## MongoDB lifecycle

The MongoDB adapter implements the same explicit-context routing contract with application-filter capabilities. Each scope creates an explicit logical session over an owned MongoClient and serializes transactional operations. Scalar-string ownership predicates and binary collation guard CRUD; the aggregation compiler prepends ownership and a declared-field projection, tracks fields and rejects stages that add streams or write results. Replica-set and ordinary-collection metadata are required before business work.

Work/request/cleanup deadlines, poisoned failures, expired facades, abort/endSession and client retirement on uncertainty protect the lifecycle. Retiring a shared resource can interrupt other scopes; infrastructure must replace it. No connection tenant variable or native RLS is implied. See the [MongoDB guide](../packages/mongodb/README.md) for the exact grammar, ownership and retry contract.

## SQLite lifecycle

SQLite reuses the portable CRUD compiler through its pure compiler subpath, with SQLite-specific quoting and binary scalar-TEXT ownership predicates. The concrete Node adapter implements the same explicit-context routing contract in application-filter mode. Existing database files and ordinary tables with a TEXT NOT NULL tenant column are required; file selection is trusted infrastructure.

One bounded FIFO queue per resource admits one scope at a time. Each scope opens a fresh worker-owned connection, configures verified safety settings and begins IMMEDIATE, then serializes generated CRUD. Failed/pending work cannot commit, including after SQLite automatically rolls back a transaction. Cleanup rolls back if needed, verifies transaction state and closes the connection/worker before admission of the next scope. Uncertain cleanup retires the resource; native work can delay worker termination and file-lock release. See the [SQLite guide](../packages/sqlite/README.md) for precise deadlines, outcomes and deployment limits.

## Prisma lifecycle

The Prisma adapter uses the same portable routing contract and declares application-filter mode. A companion generator preserves the schema metadata needed to reject relation/list/non-supported scalar entry points and resolve table/column mappings. Business code receives a frozen scalar-model CRUD facade rather than a native Prisma client or an extension that misses nested operations.

Every run obtains a fresh plain client with its own driver-owned pool, uses a Serializable interactive transaction, serializes operations and disconnects after transaction settlement. Swallowed failures, pending work, expired facades and nested scopes fail closed. Resource/client creation, requests, work, transaction settlement and cleanup have finite bounds. Uncertain cleanup retires the resource; native socket destruction is outside Prisma's public API. Provider metadata checks require exact ownership comparison semantics and transactional tables. See the [Prisma guide](../packages/prisma/README.md) for the tested provider/version matrix and precise ownership/outcome limits.

## Drizzle lifecycle

The Drizzle adapter uses actual Drizzle table definitions/operators on owned node-postgres/mysql2 connections and declares application-filter mode. Only concrete scalar schemas and allowlisted CRUD are admitted; aliased tables, SQL-valued defaults, runtime hooks and arbitrary caller query expressions are rejected. Adapter-owned binary predicates preserve exact tenant identity even with permissive database collations. Live metadata requires ordinary supported tenant columns and transactional tables.

Each scope creates a fresh physical connection, pins Drizzle to it and owns Serializable BEGIN/COMMIT/ROLLBACK. Operations serialize, caught failures poison work and escaped facades cannot continue. Bounded acquisition/work/request/cleanup, socket failure handling, rollback and confirmed closure precede resolution. Unsafe sessions are destroyed rather than pooled; closure uncertainty retires resources. The factory accepts connection configuration rather than external ORM/pool objects. See the [Drizzle guide](../packages/drizzle/README.md) for exact guarantees, deployment scope and error outcomes.

## Mongoose lifecycle

The direct MongoDB and Mongoose adapters now share the driver-independent scoped-mongo ownership/aggregation policy. Mongoose creates an isolated instance/connection/model registry from declared scalar fields, with buffering, automatic DDL, implicit casts and application model features excluded. The public facade returns plain rows/counts rather than queries, hydrated documents or native handles. Every model operation carries explicit scalar ownership and binary collation.

Replica-set metadata precedes session creation. Each scope explicitly starts a snapshot/majority transaction and serializes Mongoose calls on its owned session, without callback retry helpers. Actual native promises remain tracked past request deadlines; cleanup drains them before abort/endSession, including late session acquisition. Uncertain cleanup/commit or socket failure terminally destroys the connection against reuse. See the [Mongoose guide](../packages/mongoose/README.md) for the restricted model API and tested failure/retirement behavior.

## Express, Fastify and Koa lifecycle

Express middleware and Fastify callback-style preHandler hooks call their continuation inside the default Node carrier after guard authorization. Koa wraps await next() in the scope. The guard's own optional carrier is preserved as well. Authorization denial ends the request with 403; provider failures, invalid contexts and downstream errors retain framework error handling. No client-supplied tenant header or mutable request field becomes trusted context.

The same real TCP HTTP conformance suite checks Express 5, Fastify 5 and Koa 3 with overlapping requests, distinct principals, case-sensitive tenants, public routes, provider/handler failures, custom carriers and disconnects. Koa upstream error middleware resumes outside the nested scope; Express/Fastify downstream error handlers inherit it. Packed adapters have strict TypeScript/JavaScript consumers using the installed framework peer trees, preserving transitive dependency versions. They execute in the Node application process and work with every explicit-context database router; no separate service is deployed. Streaming protocols, workers and automatic cancellation/revocation of detached resources remain outside this certification.

## Registry cache and invalidation

`@tenantguard/registry` wraps the existing TenantRegistry interface without adding database or framework dependencies. Keys include tenant, principal, correlation ID and source; revision is stored in the frozen validated route because the interface does not accept an expected revision. Successful routes have bounded TTL/LRU storage, optional missing-route caching and no stale-on-error fallback. Every router still validates the active route and selected adapter/mode. Membership authorization remains outside this routing cache.

Concurrent identical lookups share a tracked upstream operation. Invalidation removes all matching identity variants, rejects waiters and fences late results; a newer load cannot be overwritten by the old one. Timeouts reject waiters while actual unsettled I/O keeps consuming bounded pending capacity. Absolute deadlines are checked on joins and publication. Terminal close rejects waiters immediately, clears entries and drains native work, without closing an application-owned provider or pool. Upstream native deadlines are required for bounded shutdown if a provider can hang.

Trusted control-plane events must invalidate each backend instance after authoritative updates. Local invalidation is not distributed revocation, does not revoke already-returned routes or move active transactions, and cannot hide replica lag. Reconnect handling should clear before traffic resumes. See the [registry guide](../packages/registry/README.md) for defaults, error types, lifecycle order and deployment limits. The real HTTP/PostgreSQL suite verifies shared loads, separate registry credentials, RLS tenant routing, secret/resource revision changes, suspension/creation, outages, late results and draining.

## Bounded tenant resource ownership

`@tenantguard/resources` maintains an explicitly registered active route per tenant/source/adapter. Initial registration is trusted control-plane work; replacement requires the expected current revision, and unchanged revisions cannot silently change resource/secret/mode. Queued/requested old generations reject rather than reopening an obsolete pool after idle eviction. Registered metadata remains bounded independently of native resource count. Registry invalidation and managed route activation must be coordinated on every instance.

Identical acquisitions coalesce creation. Global/per-tenant resource bounds count native creation, draining generations, disposal and quarantined failures; concurrent leases and acquisition queues have separate bounds. Automatic idle eviction and pressure-driven LRU eviction operate only on unused ready resources. `createPooledAdapter` holds a lease through the delegated adapter's complete transaction/cleanup promise, preserving explicit context and scoped client types for every backend. Native pool socket/worker limits remain factory configuration.

Rotation lazily loads the new secret/reference generation while already-acquired transactions remain pinned. A factory must return a new exclusively owned resource and clean partial allocations on rejection. Callback failures retire that resource. Failed/uncertain destruction closes admission and retains quarantined capacity. Disposal/shutdown deadlines report without cancelling real I/O or forcing active transactions closed; actual late work remains tracked and disposed. A shutdown timeout leaves the manager terminal and its stable close promise rejected even if native draining subsequently finishes.

The package has portable import boundaries and real PostgreSQL/SQLite wrapper certification. Tests include actual PostgreSQL role password rotation, RLS concurrent scopes, native advisory-lock stalls and pool.end draining, plus SQLite file rotation with an active worker transaction. See the [resource guide](../packages/resources/README.md) for limits, lifecycle order and deployment boundaries.

## Provisioning and migration lifecycle

`@tenantguard/lifecycle` persists consecutive state versions, applied schemaVersion and an operation target/ID. Provisioning passes through pending/provisioning; migrations first mark an active tenant migrating. Only successful work and explicit verification can publish an active target. Failed/interrupted operations stay inactive and require explicit version/operation-ID reconciliation. A currently recorded completed command is idempotent without replaying SQL. Suspension drains admissions; resume verifies a new route revision. Core and registry now recognize provisioning and continue rejecting every non-active route.

The PostgreSQL backend serializes a tenant/source through a pinned control session and reuses that connection for transactional execution. It commits schema/data changes and activation metadata together. Request admission lives in the real native pg data transaction, with a shared advisory lock and authoritative exact-route check; management waits for an exclusive transaction lock. Data-connection loss aborts its work before releasing admission. Cached active routes cannot bypass an inactive/new generation. Metadata, control execution and admitted data must be co-located in the same PostgreSQL database.

Execution phases expire their native facades, reject transaction-control/multiple statements, poison caught native failures and drain unawaited queries before rollback. Actual tasks/acquisitions retain capacity after deadline reports. A lost management connection or uncertain COMMIT can leave inactive/unknown durable outcomes: inspect state and reconcile explicitly, without automatic DDL replay. Post-commit hooks coordinate application-owned cache invalidation/resource reconciliation and can fail independently of committed state. No distributed outbox or global revocation guarantee is supplied.

The portable memory store stages metadata atomically but is single-process and non-durable. Other stores require target-specific admission/fencing rather than a lock on an unrelated control connection. Tenant-key fences do not coordinate shared-schema migrations across every affected tenant. See the [lifecycle guide](../packages/lifecycle/README.md) for supported targets, role/bootstrap setup, publication and shutdown limits.

## Diagnostic execution

`@tenantguard/cli` runs independently of backend frameworks, in local shells or CI/deployment jobs. Strict JSON config resolves every explicit environment reference before starting any connection. Offline doctor stops there; connected doctor/audit use bounded owned child processes and six engine-specific metadata collectors. Exact pinned `tenant-audit` and `db-deploy-doctor` CLI binaries supply existing relational/readiness checks where supported. Parent processes sanitize known reports, preserve stable rule IDs, await child closure and remove temporary config. Missing metadata or tool/deadline/cleanup failure produces an incomplete result. See [CLI execution and configuration](../packages/cli/README.md) and [published ecosystem integration](ecosystem.md).
