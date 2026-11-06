# TenantGuard complete implementation plan

Status: proposed implementation roadmap, November 6, 2026. This document describes future work; it is not a claim of implemented support. No hosting resources or npm packages have been created.

Current milestone: the portable core and Node/NestJS/Hono integrations, PostgreSQL (direct pg and TypeORM), SQL Server native RLS, MySQL/MariaDB scoped CRUD, MongoDB scoped CRUD/aggregation and SQLite worker-owned file CRUD are implemented locally. A restricted Prisma 7.10.1 scalar CRUD adapter is also verified on PostgreSQL, MySQL and MariaDB with owned interactive transactions and generated schema metadata. Drizzle 0.45.4 scoped CRUD is verified on the same three engines with owned native transactions and binary tenant predicates. Mongoose 9.12.0 scoped models/aggregation and explicit sessions are verified on a MongoDB replica set. MongoDB uses application-filter isolation and replica-set transactions; SQLite uses application-filter isolation with explicit transactions and fresh per-scope connections; arbitrary pipelines, bulk/upsert operations, full Mongoose model/plugin parity and sharded deployments remain future work. See [current support](architecture.md) and [verified progress](progress.md). The original baseline below is historical; this plan still includes substantial unfinished release work.

## 1. Product and scope

TenantGuard will be an open-source, MIT-licensed JS/TS library installed inside a backend application. It resolves authorized tenant identities, carries request/job context, binds data access to a tenant, manages tenant-to-database routing, and tests/audits the resulting boundaries. There is no required TenantGuard server, hosted control plane, or subscription.

Target: plain Node.js, NestJS, Hono, Express, Fastify and Koa, with a public integration contract for other backends. Fetch API integration provides a portable starting point for other request-based frameworks. Framework independence does not imply that every runtime, database driver and deployment combination is supported automatically.

A complete first stable release includes all phases below and a published compatibility matrix. Broader third-party backends use the documented adapter contract until individually certified. Authentication remains the application's responsibility; TenantGuard verifies authorization through a required user-supplied membership resolver.

## 2. Current baseline and changes required

Implemented prototype: AsyncLocalStorage context, UUID-only identity validation, PostgreSQL policy SQL, PostgreSQL-only TypeORM transactions, NestJS interceptor, a visibility assertion helper, catalog inventory CLI, one example and GitHub Actions.

Unit checks and builds passed in the previous session. PostgreSQL integration tests have not been verified locally because the Docker runtime was unavailable; re-run them before extending security claims.

Required architectural changes:

- Move Node-specific AsyncLocalStorage into a dedicated context adapter; core must not import node built-ins.
- Make tenant IDs opaque, bounded, case-sensitive strings by default. Database adapters validate UUID/string/integer encodings explicitly. Remove unconditional UUID validation and lowercasing from core.
- Replace the hard-coded PostgreSQL TypeORM path with capability-based adapter composition.
- Separate verified tenant identity from physical database/shard routing and credentials.
- Reject nested tenant switches; nested transactions reuse the active transaction or supported savepoints, and reject incompatible nesting. Do not silently start an independent transaction that appears atomic.
- Upgrade test helpers and catalog inventory into capability-aware verification tools.
- Fix documentation/package-manager inconsistencies, add formatting/linting and reproducible clean-install checks.

## 3. Isolation modes and database commitments

Each configured data source declares an isolation mode. Never silently downgrade its enforcement level.

| Database               | Shared-data mode                                                                              | Stronger separate-resource mode                                     | Planned direct driver                                 |
| ---------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| PostgreSQL             | Native RLS with USING + WITH CHECK, FORCE RLS, restricted roles and transaction-local context | Database per tenant with restricted credentials                     | pg                                                    |
| SQL Server / Azure SQL | Native security policies with filter/block predicates; explicit session-context cleanup       | Database per tenant with restricted credentials                     | mssql                                                 |
| MySQL                  | Tenant-scoped repository/query APIs; application-enforced                                     | Database per tenant with restricted credentials                     | mysql2                                                |
| MariaDB                | Tenant-scoped repository/query APIs; application-enforced; separately tested from MySQL       | Database per tenant with restricted credentials                     | mariadb                                               |
| MongoDB                | Tenant-scoped collection APIs; application-enforced                                           | Database per tenant with restricted credentials                     | mongodb                                               |
| SQLite                 | Tenant-scoped repository APIs; application-enforced                                           | File per tenant; process/OS permissions determine the real boundary | selected Node SQLite driver after compatibility spike |

MySQL/MariaDB/MongoDB/SQLite shared-data support will not be marketed as equivalent to PostgreSQL RLS. SQLite files opened by the same process are not a sandbox against compromised application code. Separate databases with a single all-powerful credential provide routing separation, not a strong credential boundary.

PostgreSQL schema-per-tenant is an optional advanced mode after the stable release, requiring safe identifier quoting, search_path hardening, schema privileges and separate tests. Unsupported database engines can use the driver contract; they are not advertised as certified.

Three explicit enforcement labels:

- `database-policy`: database-native row policy; subject to documented trusted-role and application assumptions.
- `database-per-tenant`: route to a tenant resource, ideally with credentials restricted to that resource.
- `application-filter`: scoped access APIs; direct/unwrapped database calls can bypass isolation.

Startup validation compares requested guarantees with adapter capabilities and rejects incompatible configurations. Strict mode rejects application-filter configurations. Every diagnostic and audit report identifies the actual enforcement mode.

## 4. Architecture and package boundaries

Keep pnpm + Turborepo and publish only packages whose contracts are useful independently. Proposed package names require availability checks.

| Layer              | Packages                                                          | Responsibility                                                                              |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Portable contracts | @tenantguard/core                                                 | Tenant IDs, verified context, errors, scopes, adapter capabilities, explicit-context API    |
| Node propagation   | @tenantguard/node                                                 | AsyncLocalStorage carrier; plain Node integration                                           |
| Framework adapters | @tenantguard/nestjs, hono, express, fastify, koa, fetch           | Lifecycle hooks, request extraction, authorization resolver, scoped handler execution       |
| Database adapters  | @tenantguard/postgres, sqlserver, mysql, mariadb, mongodb, sqlite | Driver lifecycle, tenant routing, isolation mode, policy/migration support where applicable |
| ORM adapters       | @tenantguard/typeorm, prisma, drizzle, mongoose                   | Scoped clients/repositories; transactions; explicit supported query surface                 |
| Tooling            | @tenantguard/testing, cli                                         | Cross-tenant contract tests, catalog audits, config validation, migration generation        |

Database-specific behavior stays in database adapters; framework adapters do not depend on an ORM. Driver/framework dependencies are optional peer dependencies. Applications install only the pieces they need.

Core contracts: TenantIdentity, TenantContext, ContextCarrier, TenantAuthorizer, TenantRegistry, TenantRouter, DatabaseAdapter, TenantSession, AdapterCapabilities and AuditFinding. Registry results include an internal data-source key, isolation mode, resource reference and secret reference. They never accept a client-supplied connection string.

Maintain multiple named data sources in one application: for example orders in PostgreSQL and events in MongoDB. The verified tenant maps to a route for each source. Transactions are atomic within a supported single database connection/session; no distributed ACID promise. Cross-database workflows use application outbox/saga patterns.

## 5. Request and job lifecycle

1. Existing authentication verifies a session/JWT/API credential.
2. A framework adapter extracts a candidate tenant from a header, subdomain, path or authenticated principal.
3. A required authorization callback checks membership and tenant status. Candidate tenant input alone is never trusted.
4. Core creates an immutable context with tenant ID, principal reference and correlation ID. Background jobs reauthorize against trusted job metadata and current tenant status.
5. The router looks up a server-controlled data-source/resource mapping and secret reference.
6. A tenant-scoped operation acquires a connection/session and begins a transaction when required. Native-policy adapters set tenant context on that same connection.
7. Business logic uses the scoped client. Reads and writes are constrained according to the configured mode.
8. Commit/rollback completes; context and resources are cleaned up. A connection with uncertain cleanup is destroyed rather than returned to the pool.

Do not keep database transactions open for the full lifetime of streaming responses. WebSocket messages get separate scopes. Queue consumers, scheduled jobs, retries and event handlers create fresh scopes. Lost context denies tenant data access.

Administrative cross-tenant operations use a separate explicit API and privileged credentials, with reason/audit events. No hidden bypass flag on normal request contexts.

## 6. Data-access implementation details

Native-policy SQL adapters:

- PostgreSQL: transaction-local set_config; restricted runtime role; policy/role/ownership inspection; pooled connection contamination tests; migration owner separate from runtime role.
- SQL Server: filter and block predicates; pinned connection/session lifecycle; SESSION_CONTEXT explicitly set and cleared before pool release. Do not assume PostgreSQL transaction-local cleanup semantics. Test cancellation, rollback, pooled reuse and concurrent requests.
- Policy migrations are generated as reviewable files. Runtime request code never creates policies or grants privileges.

Application-filter SQL adapters:

- Require a model manifest: tenant-owned, shared read-only, or separately privileged. Unclassified resources fail configuration validation.
- Compose user filters as tenantPredicate AND userPredicate. Add tenant IDs on inserts and reject conflicting values or tenant-column updates.
- Apply scoping to joins, relation loads, counts, aggregates, upserts, bulk operations, soft deletes and nested writes; reject unsupported operations.
- Tenant-aware composite foreign keys and unique constraints prevent cross-tenant relations where schema capabilities permit.
- Do not rewrite arbitrary SQL text using regex. Raw SQL requires a separate explicit unsafe API and cannot carry the application-filter guarantee.

MongoDB:

- Enforce tenant fields in finds, mutations, bulk operations and upserts; reject tenant reassignment.
- Audit aggregation pipelines including lookup/union/output stages; reject unimplemented stages and dangerous options. A top-level match alone is insufficient.
- Mongoose middleware alone is insufficient; certify model, query and aggregation entry points separately. Direct native collection access remains outside the scoped API.

Connection routing:

- Bounded per-tenant pools, idle eviction, acquisition timeouts, active-session pinning, secret rotation and shutdown handling.
- Registry cache keyed by tenant + source + routing revision; explicit invalidation for suspended/moved tenants.
- Tenant provisioning/migration lifecycle: pending, provisioning, active, suspended, migrating, failed. Never route traffic to an incompletely provisioned resource.
- No arbitrary schema/database identifier interpolation. Explicit identifier validation, server-side allowlists and parameterized values.

## 7. Framework and runtime support

| Integration               | Stable-release commitment                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Plain Node.js             | Callback wrapper and explicit scopes for HTTP, workers and jobs                                                        |
| NestJS                    | Module, injectable services, decorators, authorization hook, HTTP interceptor, documented worker/WebSocket integration |
| Hono                      | Typed middleware and context variables; Node first; portable explicit-context path                                     |
| Express                   | Middleware, request types, async error propagation and cleanup                                                         |
| Fastify                   | Plugin, request decoration and lifecycle hooks                                                                         |
| Koa                       | Middleware with async scope lifetime tests                                                                             |
| Fetch-compatible backends | Request-handler wrapper; integration guide for frameworks without a dedicated package                                  |
| Other JS/TS backends      | Public context/adapter contract and conformance suite; certification requires tests                                    |

Publish JavaScript and TypeScript declarations. Start with ESM; support CommonJS only after package-consumption tests pass. Core must bundle without Node polyfills. Full database adapters remain server-side.

Runtime certification is independent of framework certification. Start with supported Node LTS versions verified at implementation time. Add Bun and Deno only after their context and driver tests pass. Hono on edge platforms uses explicit context by default; enable platform context APIs only in separately tested builds. A framework working on Workers does not imply that a TCP driver or transaction API works there.

## 8. Testing and audit requirements

Build reusable adapter contract suites and execute against real databases, not only mocked drivers:

- Tenant A/B fixtures: reads, inserts, updates, deletes, joins, nested relations, aggregates, bulk writes, upserts and ownership changes.
- Missing/invalid context, untrusted tenant claims, revoked membership, suspended tenants and nested switches.
- Hundreds of concurrent interleaved operations; single-connection pool reuse; retries, exceptions, timeouts, cancellation and rollback.
- Tenant registry cache isolation, route changes, credential rotation, bounded-pool behavior and cross-source mapping errors.
- ORM-specific bypass paths and unsupported operations must be rejected or clearly outside the guarantee.
- Native-policy role bypass, unexpected policies, ownership, views/functions and connection cleanup tests.
- Real framework HTTP tests, request cancellation, async propagation, streams, worker scopes and TypeScript/JavaScript consumer fixtures.
- Portable-core bundle tests plus runtime-specific CI; no supported label without an executable test job.

CLI commands: init, doctor, audit, generate-policy and test-isolation. Audit outputs human-readable and JSON reports with stable finding IDs and documented exit codes. Schema/role inspections differ by database. Application-filter audits assess configuration and schema; they cannot certify that every application query uses a wrapper. Default commands are read-only; applying migrations is explicit.

Maintain a versioned compatibility table for engine + version + driver + ORM + isolation mode + runtime. Test adapters independently plus representative end-to-end framework combinations; do not claim every Cartesian combination by inference. Benchmark context overhead, pool churn and representative scoped queries; publish reproducible methodology instead of inventing a performance target before a baseline exists.

## 9. Where it will be deployed

The library executes inside each developer's own backend process. Users keep their application hosting, database provider and credentials. No tenant data goes to a TenantGuard-operated service. Optional diagnostics are local/application-controlled; no mandatory telemetry.

| Artifact                    | Planned destination                   | Operational details                                                                                     |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Source, issues and releases | Public GitHub repository              | Repository owner/name selected before publication; currently no remote is assumed                       |
| JS/TS packages              | npm under @tenantguard/* if available | GitHub Actions trusted publishing, provenance, protected release workflow and versioned changelogs      |
| Documentation               | GitHub Pages                          | Static documentation; expected URL https://<owner>.github.io/<repository>/ until a domain is chosen     |
| Demo container images       | GitHub Container Registry             | Reproducible images tagged by release and immutable digest                                              |
| Public interactive demo     | Render web service                    | One small backend container with separate restricted PostgreSQL credentials; synthetic data only        |
| Demo database               | Managed PostgreSQL in the same region | Dedicated demo instance/database; migration credentials isolated from service credentials               |
| Full multi-DB showcase      | Local Docker Compose and CI           | PostgreSQL, SQL Server, MySQL, MariaDB, MongoDB and SQLite examples; not six always-on public databases |

The public demo starts with Hono and PostgreSQL; the NestJS, Express, Fastify and other database examples run locally and in CI. The demo displays its exact adapter/mode/version, two authenticated synthetic tenants, allowed access, denied cross-tenant attempts and last successful test evidence. It does not display real connection strings or allow arbitrary SQL. Tenant-scoped writes, quotas, rate limits and reset jobs prevent abuse.

Deployment pipeline: pull request checks → full adapter tests → tagged prerelease → packed-package install smoke tests → protected release → npm packages and container images → static docs → demo migration job → service rollout → health/smoke/isolation checks. Pin package/image versions and design backward-compatible migrations; application rollback cannot automatically undo destructive database changes.

Required setup before actual deployment: GitHub repository ownership, npm scope access, trusted-publisher configuration, Pages enablement, Render account/project/region/plan, database secrets and a maintenance owner. No domain or hosted resource is provisioned by this plan. Live-demo compute/database costs depend on the selected plan; no free-tier promise. Library use requires no TenantGuard-hosted infrastructure.

## 10. Implementation phases and completion gates

Effort estimates assume one experienced engineer working substantially full-time. They are planning ranges, not delivery commitments; security review scheduling and unexpected adapter gaps can extend them.

| Phase                         | Estimate  | Concrete deliverables and exit gate                                                                                                              |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Stabilize prototype        | 1 week    | Clean installs/builds, repository conventions, baseline integration test pass, threat model and API decisions                                    |
| 1. Portable architecture      | 1–2 weeks | Opaque tenant IDs, portable core, Node carrier, authorization/router/capabilities contracts, explicit-context path, nested transaction semantics |
| 2. SQL native-policy adapters | 2–3 weeks | Harden PostgreSQL; SQL Server driver, migrations and session cleanup; real-database conformance pass                                             |
| 3. Remaining databases        | 3–4 weeks | MySQL, MariaDB, MongoDB, SQLite; scoped APIs; separate-resource routing; capability and bypass-path tests                                        |
| 4. Framework integrations     | 2–3 weeks | Node, NestJS, Hono, Express, Fastify, Koa and Fetch integration tests and guides                                                                 |
| 5. ORM integrations           | 3–4 weeks | TypeORM, Prisma, Drizzle and Mongoose with operation allowlists, unsupported-operation rejection and consumption fixtures                        |
| 6. Operations/tooling         | 2–3 weeks | Routing/pool lifecycle, migration/provisioning helpers, audit CLI, diagnostics, contract-test helpers and benchmark suite                        |
| 7. Examples/deployment        | 1–2 weeks | Full local showcase, documentation site, reproducible containers, release workflows and public demo staging                                      |
| 8. Release hardening          | 2–3 weeks | Independent security review, findings resolved, compatibility matrix verified, install/upgrade docs and stable release                           |

Total planning range: roughly 17–25 engineer-weeks, with some overlap possible. The original six-week PostgreSQL MVP is a smaller scope and cannot represent this full multi-database/framework/ORM commitment.

Prereleases may expose completed, tested subsets: PostgreSQL + Node/NestJS/Hono first; native SQL Server next; remaining database/ORM adapters after certification. The stable-completion definition still includes the entire matrix above. Deployment of any public subset must list its actual support status.

## 11. Stable release definition of done

- All six database families have at least one certified direct-driver integration and documented enforcement modes.
- All named framework adapters plus generic Node/Fetch entry points pass lifecycle tests.
- ORM compatibility is explicitly listed by engine/operation/version; supported combinations pass real-database tests.
- No context/pool leak, tenant reassignment or cross-tenant relationship failures remain in the supported test matrix.
- Strict mode rejects weaker-than-requested isolation; CLI never equates policy presence with proof of security.
- TypeScript and plain JavaScript consumers can install packed/published artifacts in clean projects.
- Independent review findings are resolved or documented with affected modes disabled from stable support.
- Versioned docs, runnable examples, security reporting process, maintenance policy, release provenance and rollback runbooks are published.
- Public demo uses synthetic data; deployment smoke and isolation checks pass; no credentials are committed.

## 12. Reference basis

- PostgreSQL RLS, including owner/superuser bypass and policy behavior: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- SQL Server filter/block predicates and session-context approach: https://learn.microsoft.com/en-us/sql/relational-databases/security/row-level-security
- MongoDB multi-tenancy, including application enforcement for shared collections: https://www.mongodb.com/docs/atlas/build-multi-tenant-arch/
- MySQL view CHECK OPTION semantics (not a claim of native PostgreSQL-equivalent RLS): https://dev.mysql.com/doc/refman/8.4/en/view-check-option.html
- SQLite permissions and omitted GRANT/REVOKE support: https://www.sqlite.org/omitted.html
- Hono runtime scope: https://hono.dev/docs
- Cloudflare platform-specific AsyncLocalStorage: https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/
- GitHub Pages static hosting: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- Render container deployment: https://render.com/docs/deploying-an-image
- npm trusted publishing: https://docs.npmjs.com/trusted-publishers/
