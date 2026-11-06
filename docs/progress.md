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
