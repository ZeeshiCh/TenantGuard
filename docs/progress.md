# Implementation progress

## Foundation milestone — November 6, 2026

Phase 0 baseline and the first portable-core milestone are implemented locally. The complete multi-database release remains in progress.

Completed:

- Formatting and TypeScript unused-symbol checks; frozen-lockfile installation instructions and CI configuration for Node 22/24.
- Framework/driver-independent core; opaque case-sensitive IDs; immutable authorization context; explicit-context API.
- Node carrier split into its own package; default and isolated AsyncLocalStorage carriers with nested tenant/principal-switch rejection.
- Named-source routing with typed clients, server-side registry contract, capability validation and strict isolation-mode checking.
- Fetch wrapper and typed Hono middleware, including application-specific Hono context variables; NestJS authorization callback with legacy resolver compatibility.
- PostgreSQL-specific UUID encoding validation; TypeORM explicit-context router bridge; rejection of accidental independent nested transactions.
- Architecture/trust-boundary documentation and current support matrix.

Verified locally:

- 33 unit tests, including interleaved Hono requests and two different client types routed through the same core API.
- Real PostgreSQL 17 integration suite: missing context, tenant visibility, cross-tenant read/write restrictions, rollback, one-connection pool reuse, permissive-policy interaction, concurrent tenants, nested helper rejection and explicit router execution.
- All nine library package builds; browser-target bundles for core/Fetch/Hono.
- Packed core/Node/Fetch packages installed offline into a fresh temporary consumer; JavaScript execution and TypeScript declaration resolution.

CI is configured but has not been run on a GitHub remote. PostgreSQL's integration suite is one end-to-end test with multiple security assertions. It is not independent security review or certification of all PostgreSQL features.

The reusable conformance and direct pg follow-up is recorded below. SQL Server and the remaining database/framework/ORM adapters remain on the [complete plan](implementation-plan.md).

No packages have been published and no application has been deployed. Database families other than PostgreSQL remain unimplemented. Bun/Deno/edge runtimes, full framework HTTP servers and distributed transaction semantics are not certified by this milestone.

## Reusable conformance and direct pg milestone — November 6, 2026

Implemented:

- Runner-independent adapter conformance cases with fresh fixtures, driver-specific CRUD hooks, positive write checks, cross-tenant denial, concurrent scopes, rollback and reliable fixture cleanup.
- Direct Node pg adapter under @tenantguard/postgres/pg, composed with the portable multi-source router and explicit contexts.
- Dedicated-pool acquisition deadlines, late-client destruction, pinned transactions, transaction-local tenant/timeout/search-path settings, closed client facades and swallowed-query failure tracking.
- Runtime and reachable-role checks, declared-table RLS/FORCE/ownership/TRUNCATE/schema privilege checks, UUID column checks and restrictive-policy presence checks.
- Bounded rollback/session cleanup; destruction on contamination, timeout, socket errors, uncertain commit or cleanup failure; explicit commit-outcome errors.
- Packed PostgreSQL entry-point and declaration testing in an offline clean JavaScript/TypeScript consumer using locally packed driver/type dependencies.

Validation: 67 unit tests and 31 real PostgreSQL integration tests (including parent tests), with both adapters running the same seven conformance cases and 13 direct-driver lifecycle subtests. Package builds, formatting/type checks, portability bundles and clean packed-package consumers pass locally. GitHub CI has not been run remotely.

Remaining work includes policy-expression analysis, PostgreSQL partitions/pooling proxies, TypeORM lifecycle parity, pool/registry management beyond the driver-owned dedicated pool, other databases and independent review. This milestone certifies neither arbitrary SQL nor every PostgreSQL deployment topology. Nothing has been published or deployed.

## SQL Server native RLS milestone — November 6, 2026

Implemented @tenantguard/sqlserver with schema-bound filter/block policy migrations, UUID validation, a dedicated physical Tedious pool and an explicit-context adapter for the portable router. The connection remains pinned through commit/rollback, explicit SESSION_CONTEXT clearing, verification, driver reset and final verification. Unsafe, read-only-poisoned, timed-out or broken sessions are destroyed. The adapter serializes requests, validates effective privileges and declared policy bindings, and reports uncertain/committed outcomes when required.

SQL Server executes the exact same seven adapter conformance cases as both PostgreSQL adapters. Additional lifecycle cases cover reuse/clearing, contamination, swallowed errors, read-only keys, operation/request/lock deadlines, serialized requests, effective impersonation grants, inherited control, disabled policies and killed sessions. Unit tests cover lifecycle fault injection. Clean JavaScript/TypeScript consumer fixtures install actual packed artifacts with their local driver dependency closure, including SQL Server.

Verified locally: 95 unit tests and 52 real-database integration tests (including parent tests), with no skips. All ten package builds, strict type/format checks, portable bundles and clean packed-package consumers pass. Integration files run sequentially to bound database memory. The SQL Server 2022 Developer image is pinned by digest and uses synthetic ephemeral data.

Local SQL Server execution used x86-64 emulation on ARM. This is real-engine test evidence, not a claim that Microsoft supports emulation for production. Native x86-64 Linux CI is configured but not run on a remote in this session. Azure SQL, Windows/AAD authentication, MARS and other topologies remain uncertified. Policy-expression auditing, SQL Server CLI auditing and independent security review remain future work. Nothing has been published or deployed.

## MySQL and MariaDB scoped CRUD milestone — November 6, 2026

Implemented @tenantguard/mysql and @tenantguard/mariadb over a shared @tenantguard/scoped-sql implementation. The native MySQL2 and MariaDB drivers are separately exercised. Registered-table CRUD injects tenant ownership, adds independent byte-exact tenant predicates, prohibits ownership/ID changes, rejects SQL fragments and snapshots values. The adapters declare application-filter mode; strict database-enforcement mode rejects them. ORM integration and native RLS-equivalent protection are not claimed.

Dedicated physical pools bound acquisition/creation and discard late/broken sessions. Pinned InnoDB transactions, full resets, UTF8MB4 restoration, explicit advisory-lock release, schema checks and poisoned swallowed errors are implemented. Cleanup tests verify user variables, temporary-table removal, advisory locks, case/accent/padding aliases, nontransactional-table refusal, lock/request/work deadlines, serialized operations and killed sessions. Ill-formed surrogate tenant IDs are rejected before UTF-8 conversion.

Both engines pass the exact same seven reusable conformance cases as PostgreSQL and SQL Server. The complete regression run passes 94 real-database tests (including parents) with no skips; unit checks pass 114 tests. All thirteen package builds, strict type/format checks, portable boundaries (including the pure CRUD compiler) and clean packed JavaScript/TypeScript consumers pass locally.

MySQL 8.4 and MariaDB 11.8 images are pinned by multi-platform digest and ran natively on the local ARM Docker host; manifests also include x86-64 for configured CI. All integration files run sequentially. Remote CI, other compatible engines/proxies, complex query/ORM support, complete trigger/constraint auditing and independent security review remain future work. The audit CLI remains PostgreSQL-only. Nothing has been published or deployed.

## MongoDB scoped CRUD and aggregation milestone — November 6, 2026

Implemented @tenantguard/mongodb with an owned official-driver MongoClient resource and the portable explicit-context adapter contract. Registered collection CRUD injects tenant ownership, requires scalar string tenant fields and binary collation, snapshots restricted JSON inputs and rejects ownership/ID changes. The aggregation compiler prepends ownership and declared-field projection, tracks transformed fields and admits only bounded single-stream match/sort/skip/limit/project/group/count operations. Foreign-collection reads, nested pipelines, result writes, executable expressions and unlisted stages are rejected.

Replica-set transactions use explicit logical sessions, snapshot reads and majority writes. Native operations serialize; swallowed errors and pending work cannot commit. Bounded request/work/cleanup, late-resolution checks, expired facades, explicit abort/endSession and terminal client retirement protect session lifecycle. Business callbacks are not automatically retried. Commit/cleanup errors carry commitOutcome, including uncertain writes. The installed MongoDB driver 6.22 deprecates timeoutMS; explicit promise deadlines, server execution/commit limits and transport timeouts establish the bounds instead.

The exact same seven reusable conformance cases pass against a real authenticated MongoDB 8.0 replica set with separate runtime credentials. Additional real tests verify aggregation safeguards, array/case/accent/padding ownership aliases, raw bypass, caught validation/server-error rollback, ended sessions, deadline rollback, escaped facades and view refusal. Unit fault injection verifies standalone refusal, late resolution, stalled native operations, cleanup retirement and ambiguous commits. The official multi-platform image is pinned by digest; this local run used native ARM Docker with synthetic ephemeral data, not a failover/sharding certification.

Verification: all 126 unit tests and 112 real-database integration tests (including parents) pass with no skips. All fourteen library builds, strict format/type checks, portable compiler boundaries and clean packed JavaScript/TypeScript consumers pass. MongoDB contributes 12 unit tests and 18 integration tests including its parent; all existing database suites were rerun sequentially.

The adapter declares application-filter mode and strict routing rejects it. It supports Node, NestJS, Hono and other Node JS/TS backends through the same router without framework coupling. Arbitrary BSON/query/pipeline support, bulk/upserts, Mongoose, standalone/sharded deployments, Atlas/failover certification, SQLite and remaining release phases are deferred. Remote CI has not been executed, and no package or service has been published or deployed. See the [MongoDB guide](../packages/mongodb/README.md).

## SQLite scoped CRUD and transaction cleanup milestone — November 6, 2026

Implemented @tenantguard/sqlite using Node's built-in SQLite driver in private worker threads, with no native npm addon or external database server. It uses the portable explicit-context router, accepts existing server-controlled database files and declares application-filter isolation. The shared SQL compiler now has a tested SQLite dialect and pure compiler export, with declared-field CRUD, bound values, binary scalar-TEXT tenant predicates and immutable ownership. Strict routing rejects this mode, and native file access bypasses the facade.

Each resource admits one scope through a bounded FIFO queue. Every scope owns a fresh worker/connection and BEGIN IMMEDIATE transaction. Verified safety settings and table metadata, serialized requests, explicit transaction-state checks, poisoned failures, queue/request/work/cleanup deadlines and closed facades guard execution. Cleanup rolls back active transactions and verifies/closes the connection and worker before admitting the next scope. Uncertain cleanup retires the resource; worker termination may wait for native work and retain file locks until it completes, so caller deadlines do not certify immediate cancellation. Commit/cleanup failures expose commitOutcome and no callback is automatically retried.

All seven shared adapter conformance cases run against a real on-disk SQLite database. Additional real cases cover case/accent/padding/BLOB ownership aliases, injection, swallowed validation/constraint failures, automatic ROLLBACK conflicts, deferred foreign-key commit failures, busy BEGIN/COMMIT, event-loop responsiveness, timeouts, escaped facades, pending writes, queue expiry, late resolution, unsafe schemas/views/virtual tables, typed bindings, active shutdown, resource retirement and durable writes through a separate connection. Unit transport tests cover reply correlation, native error state, worker failure and terminal shutdown.

Verified locally: all 134 unit tests and 138 real-database integration tests (including parents) pass without skips. SQLite contributes eight unit tests and 26 integration tests including its parent. All fifteen library builds, strict type/format checks, portable import boundaries and clean packed JavaScript/TypeScript consumers pass. The packed SQLite consumer executes an actual worker from its installed tarball against a database file, rather than checking imports alone. The full existing PostgreSQL, SQL Server, MySQL, MariaDB and MongoDB suites were rerun after the shared compiler change.

The SQLite-focused suite also passes separately on Node v22.23.4 with SQLite 3.53.4, in addition to the local Node v25.9.0 / SQLite 3.53.0 run. The adapter and workspace require Node >=22.16.0 for the transaction-state API. Node 22 marks node:sqlite experimental; Node 22/24 remote CI remains configured but was not run on a remote in this session.

Node, NestJS, Hono and other Node JS/TS backends use the same adapter contract. Bun/Deno/D1/libSQL, network filesystems, encrypted drivers, arbitrary raw/aggregate/ORM APIs, file provisioning, database-per-tenant enforcement labeling, performance certification and independent security review remain future work. All six planned database families now have local direct-driver implementations with their documented enforcement limits; this does not complete the broader stable-release roadmap. No package or service has been published or deployed. See the [SQLite guide](../packages/sqlite/README.md).

## Prisma scoped CRUD and owned transaction milestone — November 6, 2026

Implemented @tenantguard/prisma with a restricted scalar-model facade over Prisma 7.10.1 interactive transactions. The companion generator uses Prisma's generator protocol/DMMF to preserve model/column/schema mappings, scalar/relation kinds and required/list flags; it does not rely on private client internals. Generated metadata rejects relations, nested writes, unsupported scalars and arbitrary Prisma argument objects before database work. CRUD injects independent tenant filters, restricts projections, snapshots values and prohibits ownership/ID changes.

PostgreSQL requires ordinary deterministic TEXT/VARCHAR NOT NULL tenant columns; MySQL/MariaDB require ordinary InnoDB VARCHAR NOT NULL columns with approved binary NO PAD collations. Unsafe database collations fail before business callbacks. The adapter uses application-filter mode, which strict routing rejects; native Prisma access bypasses its scope and PostgreSQL RLS is not automatically configured.

Each scope creates a fresh plain PrismaClient with its own driver-owned pool, uses a Serializable interactive transaction, serializes operations and disconnects after transaction settlement. Reused client identities, nested scopes, pending operations, caught failures and expired facades fail closed. Factory/resolver, request, work, native transaction, settlement and cleanup limits are bounded. Uncertain cleanup retires resources; lifecycle errors report commitOutcome. Prisma public APIs do not expose physical socket destruction or a separate rollback acknowledgment, so native timeout configuration and trusted owned-pool factories remain necessary. No callback is automatically retried.

The exact same seven reusable conformance cases pass independently against real PostgreSQL 17, MySQL 8.4 and MariaDB 11.8 using actual generated clients and restricted runtime credentials. Additional real tests cover native bypass, ownership aliases, rejected relations/operators/nested writes, swallowed validation/constraint failures, expired facades, work/native transaction expiry, pending writes, unsafe collations, blocked updates and physical connection closure after rollback. The MySQL fixture enables RSA public-key retrieval for its disposable local server; production authentication/TLS remains application configuration.

Validation: all 152 unit tests and 195 real-database integration tests (including parents) pass without skips. Prisma contributes 18 unit tests and 57 integration tests including three parents. All sixteen library builds, strict type/format checks, portable guard boundaries and clean packed JavaScript/TypeScript consumers pass. The clean consumer also executes the installed companion generator through the real Prisma CLI and verifies mapped metadata. Frozen-lockfile offline installation succeeds. All existing database suites were rerun sequentially.

The three Prisma real-engine suites additionally pass on Node 22 (57 tests), besides the local regression runtime. Prisma CLI/client/driver adapters/generator helper are pinned to 7.10.1; fixture clients/metadata are generated before type checks and integration tests and ignored by Git. CLI/engine setup scripts are explicitly allowlisted. Remote Node 22/24 CI remains configured but was not run remotely in this session.

Node, NestJS, Hono and other Node JS/TS backends use the same explicit-context routing contract. Other Prisma providers/versions, Prisma 8 prereleases, shared external pools, extensions, full relation/query parity, native-policy mode, edge runtimes, benchmarks and independent review remain future work. No package or service has been published or deployed. See the [Prisma guide](../packages/prisma/README.md).

## Drizzle scoped CRUD and native transaction milestone — November 6, 2026

Implemented @tenantguard/drizzle with actual Drizzle 0.45.4 tables/builders on owned node-postgres/mysql2 connections. The restricted facade admits concrete scalar tables, declared projections and equality CRUD. It rejects aliases/proxy projections, caller SQL objects/operators, relations, runtime hooks, SQL-valued defaults, custom/generated columns and raw/query-builder entry points. Inputs are snapshotted and ID/tenant fields are immutable.

Independent byte-exact ownership predicates use explicit PostgreSQL COLLATE C or MySQL/MariaDB binary comparison in addition to ordinary equality. Supplied tenant filters also compare exactly. Tests cover permissive defaults and PostgreSQL nondeterministic collations; users need not change database collations to the Prisma adapter's allowlist. Live metadata requires ordinary supported tenant columns and transactional tables. The mode is application-filter, strict routing rejects it and unwrapped Drizzle access bypasses it.

Each scope owns a fresh physical connection and Serializable BEGIN/COMMIT/ROLLBACK, with Drizzle pinned to that same native session. There is no external pool or raw ORM handle in callbacks. Serialized work, poisoned caught failures, pending-operation checks, expired facades and nested-scope rejection guard execution. Finite acquisition/request/work/cleanup, native lock limits, socket failure handling, rollback/closure verification and connection destruction prevent reuse of uncertain sessions. Closing uncertainty retires resources; commit/cleanup failures carry commitOutcome and callbacks are never automatically retried.

All seven shared conformance cases pass independently against real PostgreSQL 17, MySQL 8.4 and MariaDB 11.8 with restricted runtime credentials. Additional real checks cover native bypass, case/accent/padding aliases, foreign tenant filters, SQL/operator refusal, swallowed failures, serialized operations, escaped repositories, pending writes, lock/request/work deadlines, view/engine/schema refusal and native connection closure. Unit fault injection covers socket/listener failures, late connections, rollback/close failure and ambiguous commits. The three real-engine suites additionally pass on Node 22 (63 tests including parents).

Full local regression: 171 unit tests and 258 real-database integration tests pass with no skipped test cases. Drizzle contributes 19 unit tests and 63 integration tests including its three parents. All seventeen library builds, strict source checks, formatting, browser guard boundaries and clean packed JavaScript/TypeScript consumers pass. Installed consumers exercise actual Drizzle definitions and CommonJS tables crossing the ESM boundary. Frozen-lockfile offline installation succeeds.

Drizzle 0.45.4's upstream declarations include errors and optional driver references absent from a focused installation. The original package consumer retains full strict declaration checking; a separate Drizzle consumer uses strict usage checking with skipLibCheck and negative type assertions for forbidden SQL values and incomplete connection options. This validation limit is documented rather than installing unrelated database drivers or weakening every package consumer.

The adapter integrates through the existing explicit-context router for Node, NestJS, Hono and other Node JS/TS backends. Other Drizzle providers/drivers, SQLite/SQL Server ORM support, full relation/query parity, external pools, native-policy mode, global connection admission, benchmarks and independent review remain future work. Remote CI has not been executed; no package or service has been published or deployed. See the [Drizzle guide](../packages/drizzle/README.md).

## Mongoose scoped models, aggregation and transactions milestone — November 6, 2026

Implemented @tenantguard/mongoose with a private Mongoose 9.12.0 instance, owned connection/model registry and explicit scalar declarations. It exposes plain-data tenant CRUD/aggregation without existing application Model/Schema objects, plugins, populate, casts, hydrated documents or raw handles. Required string identity, primitive type checks, immutable ownership, scalar-string predicates and simple collation protect reads/writes against array and collation aliases.

Extracted the existing MongoDB guard/compiler into portable @tenantguard/scoped-mongo, preserving native MongoDB exports and adding a pure guards subpath. Both adapters use the same bounded aggregation allowlist and field tracking; foreign-stream reads, nested/output/executable stages and unlisted operators fail before execution. Sharing policy avoids mixing Mongoose's driver 7 BSON/session classes with the direct adapter's driver 6 objects.

Sessions explicitly use snapshot reads, majority writes and primary read preference. Mongoose calls serialize and every native operation receives its owned session. Caught errors/pending work cannot commit; nested/detached scopes and expired facades are rejected. Real native promises, including asynchronous session creation, remain tracked after deadline expiry. Cleanup drains before abort/endSession; uncertainty/failed commit destroys and retires the entire connection. No callback is automatically retried, and lifecycle errors carry commitOutcome.

A further regression test demonstrated that Mongoose SchemaType defaults are shared across instances: a global String lowercase setter rewrote a tenant ID in a standalone probe despite creating an isolated Mongoose instance. Resource construction now rejects inherited transforms/defaults/extra type options and reserved document paths before opening a connection. This fix has its own atomic commit and regression tests; default-instance plugin isolation is tested separately.

The exact same seven reusable conformance cases pass against a real authenticated MongoDB 8.0 replica set, pinned by digest, with separate runtime credentials, binary tenant-aware indexes and a case-insensitive collection default. Additional real checks cover aggregation escape paths, scalar/array/case/accent/padding ownership, strict routing/native bypass, cast/operator refusal, caught schema/native failures, default plugins, plain results, session ending, deadlines, pending writes, views and active shutdown. Opt-in failCommand server stalls prove actual request draining and connection retirement; production resources do not enable test commands. The complete 23-test Mongoose real-engine suite also passes on Node 22.

Full local verification: 190 unit tests and 281 real-database integration tests (including parents) pass without skipped test cases. Mongoose contributes 19 unit tests and 23 integration tests including its parent. All nineteen library builds, strict source/format checks, portable guard boundaries and clean packed JavaScript/TypeScript consumers pass. The Mongoose consumer uses full strict declaration/usage checking and its actual dependency closure independently of the native adapter's driver-major closure. Existing package consumer guarantees, including the documented Drizzle-specific declaration workaround, are preserved.

Node, NestJS, Hono and other Node JS/TS backends use the same explicit-context router. The mode remains application-filter and strict routing rejects it. Existing-model/plugin parity, broader BSON/schema support, sharded/Atlas/failover certification, native-policy mode, edge runtimes, performance certification and independent review remain future work. Remote CI has not been executed, and no package or service has been published or deployed. See the [Mongoose guide](../packages/mongoose/README.md) and [shared policy guide](../packages/scoped-mongo/README.md).
