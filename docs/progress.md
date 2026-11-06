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

Next milestones:

1. Specify reusable adapter conformance tests and transaction/session capabilities in greater depth.
2. Harden PostgreSQL role/session/connection lifecycle and add a direct pg adapter.
3. Implement SQL Server native-policy adapter and verify session cleanup against a real engine.
4. Add remaining databases, framework adapters and ORMs according to the [complete plan](implementation-plan.md).

No packages have been published and no application has been deployed. Database families other than PostgreSQL remain unimplemented. Bun/Deno/edge runtimes, full framework HTTP servers and distributed transaction semantics are not certified by this milestone.
