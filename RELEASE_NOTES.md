# TenantGuard 0.1.0 candidate

TenantGuard is a JavaScript/TypeScript multi-tenancy toolkit that runs inside the application's own backend process. This candidate provides explicit tenant authorization, named data-source routing, scoped database access, lifecycle management and read-only diagnostics without requiring a hosted TenantGuard service.

## Included capabilities

- Portable tenant context, authorization and fail-closed routing contracts.
- Node, Fetch, Hono, NestJS, Express, Fastify and Koa integrations.
- Direct PostgreSQL and SQL Server adapters with native row-level security helpers and hardened session cleanup.
- MySQL and MariaDB scoped InnoDB CRUD adapters.
- MongoDB replica-set scoped CRUD and aggregation safeguards.
- SQLite worker-owned file transactions and cleanup.
- Restricted Prisma, Drizzle, TypeORM and Mongoose integrations.
- Bounded tenant registry cache with coalescing, TTL/LRU eviction and invalidation.
- Bounded per-tenant resource generations, idle eviction, secret rotation and shutdown accounting.
- Tenant provisioning, migration fencing, suspension/resume and explicit recovery lifecycle APIs.
- CLI commands: `doctor`, `audit`, `init`, `generate-policy` and `test-isolation`.
- Reproducible core/PostgreSQL/SQLite benchmark tooling.
- Runnable Node, NestJS and Hono examples and a local multi-database Compose showcase.

## Verified matrix

The candidate has real integration coverage for PostgreSQL 17, SQL Server 2022 Developer, MySQL 8.4, MariaDB 11.8, MongoDB 8 replica sets and SQLite files. ORM coverage includes Prisma 7.10.1, Drizzle 0.45.4, TypeORM 0.3 and Mongoose 9.12. Framework coverage includes NestJS 11, Hono 4, Express 5, Fastify 5 and Koa 3. Local checks use Node 25.9.0; focused compatibility checks also run on Node 22.23.4.

The repository's latest full verification records 282 unit tests, 366 real database/HTTP integration tests, 25 package builds, strict TypeScript checks, formatting, frozen installation, packed JavaScript/TypeScript consumers and focused Node 22 CLI/example checks. The Compose configuration and release archive preflight pass. A Docker-enabled CI job runs the three-example HTTP integration test.

## Security and enforcement boundary

PostgreSQL and SQL Server use native policy enforcement when configured with the generated owner-run migrations. MySQL, MariaDB, MongoDB, SQLite, Prisma, Drizzle and Mongoose use application-filter isolation through restricted facades. Direct native access, undeclared tables, arbitrary SQL, unsupported ORM operations and raw framework bypasses remain outside those guarantees. Authentication and membership authorization remain application-owned.

The CLI is read-only by default. `generate-policy` emits SQL but never applies it. `test-isolation` reads supplied synthetic fixture rows and never creates or mutates fixtures. Diagnostic findings do not certify arbitrary policy semantics, application query coverage or production readiness.

## Upgrade and release caveats

- This is a 0.1.0 candidate; package versions are prepared locally but have not been published.
- Internal workspace dependencies use `workspace:^0.1.0` during development and are rewritten during packing.
- Review generated PostgreSQL/SQL Server policy SQL and execute it with separate migration-owner credentials.
- Use restricted runtime credentials without superuser, bypass-RLS, schema-management or equivalent administrative privileges.
- MySQL/MariaDB require transactional InnoDB tables; MongoDB scoped transactions require a replica set; SQLite requires an existing ordinary database file.
- Cloud proxies, read replicas, sharding, integrated SQL Server authentication, edge runtimes and unlisted ORM/provider versions require separate compatibility testing.
- Run `pnpm release:preflight`, `pnpm release:pack`, `pnpm check`, `pnpm test:integration` and `pnpm test:examples` before publishing.
- npm trusted publishing, GitHub Pages configuration, registry permissions, demo hosting and independent security review are still operator-owned release gates.

See [docs/compatibility.md](docs/compatibility.md), [docs/security.md](docs/security.md), [docs/deployment.md](docs/deployment.md), [docs/release-checklist.md](docs/release-checklist.md) and [examples/README.md](examples/README.md) for the full support and deployment contracts.
