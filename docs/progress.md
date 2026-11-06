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
