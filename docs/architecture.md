# Architecture decision: portable tenant boundary

Implemented foundation, November 6, 2026. The broader [implementation plan](implementation-plan.md) remains the roadmap; only the adapters listed below exist today.

## Dependency direction

```text
Framework (Fetch / Hono / NestJS / other backend)
    -> TenantGuard authorizer -> immutable explicit TenantContext
    -> portable multi-source router -> DatabaseAdapter<Client>
    -> driver-owned transaction/session -> database

Optional Node AsyncLocalStorage carrier -> portable ContextCarrier contract
```

Core contains no Node, framework, driver or ORM imports. It accepts opaque, case-sensitive tenant IDs (1–256 JavaScript string code units, no surrounding whitespace/control characters). Numeric IDs must be converted to an application's canonical string representation at the authorization boundary. UUID encoding belongs to the PostgreSQL adapter, which currently requires canonical lowercase UUIDs for its UUID policy. No normalization occurs in core.

`createTenantGuard({ authorize, carrier? })` is the common entry point. `authorize` receives a framework-specific input and must return a tenant context only after authentication, membership and tenant-status checks. Returning undefined denies access; provider failures propagate. Context snapshots are frozen and contain only tenantId, optional principalId and optional correlationId. No credentials are carried in request context.

`guard.run(input, context => ...)` works without any ambient state. Fetch handlers and Hono context variables use this explicit context. On Node, supply `nodeContext` or an isolated `createNodeContextCarrier()` for asynchronous propagation. The default Node carrier is shared by NestJS and legacy TypeORM convenience helpers. Custom carriers must be passed explicitly and do not affect those helpers.

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

| Area                            | Implemented                                                                                                           | Still planned                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Portable core                   | Explicit scopes, authorization contract, routing/capability contracts                                                 | Registry cache/provisioning, full diagnostics                                                        |
| Node                            | Default and isolated AsyncLocalStorage carriers                                                                       | Worker/stream-specific lifecycle certification                                                       |
| Fetch                           | Request handler wrapper; explicit context                                                                             | Platform-specific runtime certification                                                              |
| Hono                            | Typed middleware; explicit context or supplied Node carrier; request-level concurrency tests                          | Bun/Deno/Workers certification, full HTTP server example                                             |
| NestJS                          | Authorizer option, legacy resolver, interceptor/decorator; subscription lifecycle tests                               | Full HTTP/e2e and non-HTTP integrations                                                              |
| PostgreSQL                      | UUID policies, direct pg adapter with guarded lifecycle, TypeORM helpers; shared real-database conformance            | Policy-expression analysis, partition/proxy certification and TypeORM lifecycle parity               |
| SQL Server                      | Native RLS policy helpers, dedicated Tedious pool, verified session cleanup, real conformance/lifecycle tests         | Azure SQL, authentication/runtime/version expansion and policy audit CLI                             |
| MongoDB                         | Scoped JSON CRUD and single-stream aggregation, replica-set transactions, bounded session cleanup; real conformance   | Application filtering only; standalone, sharding, arbitrary BSON/pipelines and Mongoose are deferred |
| MySQL / MariaDB                 | Native-driver scoped CRUD, binary tenant predicates, dedicated pools and verified reset; same real-engine conformance | Native RLS-equivalent protection, ORM support and complex query operations are not implemented       |
| Other databases/ORMs/frameworks | Public contracts only                                                                                                 | Concrete adapters and real-engine conformance suites                                                 |

Portability checks build core/Fetch/Hono for a browser target and reject Node imports in that graph. They establish an import boundary, not certification of edge deployment or database connectivity. Packed core/Node/Fetch/PostgreSQL/SQL Server/MySQL/MariaDB/MongoDB packages are installed into an isolated temporary consumer offline and tested as JavaScript and TypeScript.

## Phase 0 verification and limitations

The previous integration test had never completed locally. Running it against PostgreSQL exposed an incorrect expectation for TypeORM update/delete results. It now checks the actual `[rows, affectedCount]` tuple, retaining both zero visible rows and zero affected rows assertions.

CI uses clean frozen-lockfile installs, formatting, strict TypeScript unused-symbol checks, unit tests, portability bundles, package builds, packed-package consumer smoke tests and PostgreSQL integration testing. Node 22 and 24 are configured as CI targets; local results do not claim remote CI has already run. No independent security review has occurred.

Remaining foundation work includes production pool/registry lifecycle, nested transaction specification beyond explicit rejection, additional framework and database adapters, runtime certification and independent review. The full roadmap is not complete. The direct pg and conformance milestone is recorded in [progress](progress.md).

## MongoDB lifecycle

The MongoDB adapter implements the same explicit-context routing contract with application-filter capabilities. Each scope creates an explicit logical session over an owned MongoClient and serializes transactional operations. Scalar-string ownership predicates and binary collation guard CRUD; the aggregation compiler prepends ownership and a declared-field projection, tracks fields and rejects stages that add streams or write results. Replica-set and ordinary-collection metadata are required before business work.

Work/request/cleanup deadlines, poisoned failures, expired facades, abort/endSession and client retirement on uncertainty protect the lifecycle. Retiring a shared resource can interrupt other scopes; infrastructure must replace it. No connection tenant variable or native RLS is implied. See the [MongoDB guide](../packages/mongodb/README.md) for the exact grammar, ownership and retry contract.
