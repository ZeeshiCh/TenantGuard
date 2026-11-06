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

## Current support

| Area                            | Implemented                                                                                                | Still planned                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Portable core                   | Explicit scopes, authorization contract, routing/capability contracts                                      | Registry cache/provisioning, full diagnostics                                          |
| Node                            | Default and isolated AsyncLocalStorage carriers                                                            | Worker/stream-specific lifecycle certification                                         |
| Fetch                           | Request handler wrapper; explicit context                                                                  | Platform-specific runtime certification                                                |
| Hono                            | Typed middleware; explicit context or supplied Node carrier; request-level concurrency tests               | Bun/Deno/Workers certification, full HTTP server example                               |
| NestJS                          | Authorizer option, legacy resolver, interceptor/decorator; subscription lifecycle tests                    | Full HTTP/e2e and non-HTTP integrations                                                |
| PostgreSQL                      | UUID policies, direct pg adapter with guarded lifecycle, TypeORM helpers; shared real-database conformance | Policy-expression analysis, partition/proxy certification and TypeORM lifecycle parity |
| Other databases/ORMs/frameworks | Public contracts only                                                                                      | Concrete adapters and real-engine conformance suites                                   |

Portability checks build core/Fetch/Hono for a browser target and reject Node imports in that graph. They establish an import boundary, not certification of edge deployment or database connectivity. Packed core/Node/Fetch/PostgreSQL packages are installed into an isolated temporary consumer offline and tested as JavaScript and TypeScript.

## Phase 0 verification and limitations

The previous integration test had never completed locally. Running it against PostgreSQL exposed an incorrect expectation for TypeORM update/delete results. It now checks the actual `[rows, affectedCount]` tuple, retaining both zero visible rows and zero affected rows assertions.

CI uses clean frozen-lockfile installs, formatting, strict TypeScript unused-symbol checks, unit tests, portability bundles, package builds, packed-package consumer smoke tests and PostgreSQL integration testing. Node 22 and 24 are configured as CI targets; local results do not claim remote CI has already run. No independent security review has occurred.

Remaining foundation work includes production pool/registry lifecycle, nested transaction specification beyond explicit rejection, additional framework and database adapters, runtime certification and independent review. The full roadmap is not complete. The direct pg and conformance milestone is recorded in [progress](progress.md).
