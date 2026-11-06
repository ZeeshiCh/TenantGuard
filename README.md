# TenantGuard

Multi-tenancy foundations for JavaScript and TypeScript backends.

Early, unpublished prototype. The portable core supports explicit tenant context, authorization contracts and typed routing across multiple named data sources. Node, NestJS, Hono and Fetch integrations are implemented. PostgreSQL has direct pg and TypeORM integrations; SQL Server has a direct Tedious adapter with native RLS. MySQL and MariaDB have restricted CRUD adapters with application-filter isolation. MongoDB has restricted CRUD and aggregation; SQLite has worker-owned scoped CRUD over database files. Both use application-filter isolation. Prisma has a restricted scoped adapter verified on PostgreSQL, MySQL and MariaDB.

See the [implementation plan](docs/implementation-plan.md), [architecture and current support](docs/architecture.md), and [security model](docs/security.md).

## Develop

Requires Node.js 22.16+, pnpm 11.25.0 and Docker for database tests.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:integration
```

`pnpm check` runs formatting, strict type checks, unit tests, browser-target portability builds, package builds and clean packed-package JavaScript/TypeScript consumer tests, including direct pg, SQL Server, MySQL, MariaDB, MongoDB, SQLite and Prisma entry points. Database tests sequentially launch disposable PostgreSQL 17, SQL Server 2022 Developer, MySQL 8.4, MariaDB 11.8 and authenticated MongoDB 8.0 replica-set containers through Testcontainers; SQLite tests use real temporary database files. SQL Server uses an x86-64 image and needs at least 3 GiB of container memory. CI also configures Node 22 and 24 checks. `pnpm generate:prisma` generates fixture clients and schema metadata automatically before type checks/integration tests. `pnpm format` formats sources and documentation.

## Portable authorization

The same core works with any backend that can invoke a callback. Authentication comes first; the authorizer must verify tenant membership and status.

```ts
import { createTenantGuard } from '@tenantguard/core';

const guard = createTenantGuard({
  authorize: async (request: Request) => {
    const user = await authenticate(request); // Your application implementation.
    const membership = await findAuthorizedMembership(user);
    return membership
      ? { tenantId: membership.tenantId, principalId: user.id }
      : undefined;
  },
});

await guard.run(request, async (context) => {
  // Pass context explicitly to your services or tenant router.
  await service.execute(context);
});
```

Tenant IDs are bounded, case-sensitive strings. TenantGuard does not trust raw tenant headers or authenticate credentials. Database adapters validate their own encodings.

## Direct pg adapter

`@tenantguard/postgres/pg` exports `createPgAdapter`. It accepts dedicated pg pools and declared protected tables, then works through the portable router with explicit tenant context from any Node framework. It pins a connection, checks role/table safety flags, sets transaction-local tenant context, bounds work and cleanup, and destroys connections that cannot be safely reused.

```ts
const adapter = createPgAdapter({
  resolvePool: (route) => lookupAllowlistedPool(route.resource),
  tables: [{ schema: 'public', table: 'orders' }],
});
```

The client exposes parameterized, single data statements rather than the raw PoolClient. Commit failures and cleanup failures carry outcome information so callers can avoid unsafe automatic retries. See the [pg adapter guide](packages/postgres/README.md) for imports, configuration, pool ownership, restrictions and error semantics. These safeguards apply to the direct adapter; they do not replace TypeORM's connection handling.

`adapterConformanceCases` from `@tenantguard/testing` supplies runner-independent isolation/CRUD/rollback cases. Both PostgreSQL adapters run it against a real database; see the [conformance guide](packages/testing/README.md).

## SQL Server

`@tenantguard/sqlserver` exports `sqlServerPolicyBatches`, `createSqlServerPool` and `createSqlServerAdapter`. The direct adapter uses the same portable router as PostgreSQL, with `adapter: 'sqlserver'` and `mode: 'database-policy'` in server-controlled routes.

Native FILTER and AFTER INSERT / AFTER UPDATE BLOCK predicates enforce the tenant boundary. The adapter pins a physical connection through commit/rollback, explicitly clears SESSION_CONTEXT, resets and verifies the session, and destroys unsafe connections. It serializes TDS requests and bounds acquisition, requests, work, locks and cleanup.

See the [SQL Server guide](packages/sqlserver/README.md) for migrations, least-privilege grants, typed parameters, error outcomes and supported topology. Both database families run the same reusable conformance cases against real engines. Local SQL Server tests run under x86-64 emulation; native Linux CI is configured separately. The audit CLI still supports PostgreSQL only.

## MySQL and MariaDB

`@tenantguard/mysql` and `@tenantguard/mariadb` provide native-driver pools and adapters with an allowlisted `client.table('orders').find/insert/update/delete` facade. They inject tenant identity on writes, prohibit ID/tenant reassignment and scope reads/updates/deletes with byte-exact tenant predicates. Values are bound; raw SQL, joins and operator expressions are not exposed.

These adapters declare `application-filter` mode. Direct native SQL can bypass them; strict database-enforcement mode rejects them. This is a different guarantee from native RLS. Both use pinned InnoDB transactions, full driver resets, advisory-lock cleanup, bounded work and destruction of unsafe connections. Case-insensitive database defaults do not merge tenant IDs.

See the [MySQL guide](packages/mysql/README.md), [MariaDB guide](packages/mariadb/README.md) and [shared CRUD contract](packages/scoped-sql/README.md). The same seven conformance cases run independently against each real engine. They integrate with Node, NestJS, Hono and other Node backends through the same explicit-context router; they do not add MySQL/MariaDB support to the PostgreSQL-only TypeORM adapter.

## MongoDB

`@tenantguard/mongodb` exposes `createMongoResource` and `createMongoAdapter` with tenant-scoped collection CRUD and a bounded aggregation allowlist. It uses explicit sessions and replica-set transactions, scalar ownership predicates and binary collation. Aggregation stages that read other streams or write results are rejected. Cleanup aborts/ends logical sessions and retires the owned client when safety is uncertain.

The same seven conformance cases run against a real authenticated MongoDB replica set. This adapter uses `application-filter` mode, which strict routing rejects. It integrates through the same explicit-context router for Node, NestJS, Hono and other Node JS/TS backends. See the [MongoDB guide](packages/mongodb/README.md) for configuration, supported grammar and lifecycle guarantees.

## SQLite

`@tenantguard/sqlite` provides `createSqliteResource` and `createSqliteAdapter` for existing database files using Node's built-in SQLite driver (Node >=22.16). A private worker and connection own each tenant scope, with serialized CRUD, binary scalar tenant predicates, explicit transactions and verified rollback/close before the next scope. Failed cleanup retires the resource.

The same seven conformance cases run against real SQLite files, supplemented by lock, commit, automatic rollback, deadline and shutdown tests. This is application-filter isolation; native file access bypasses it and strict routing rejects it. It uses the same explicit-context router for Node, NestJS, Hono and other Node JS/TS backends. See the [SQLite guide](packages/sqlite/README.md) for provisioning, transaction limits and deployment requirements.

## Prisma

`@tenantguard/prisma` provides `createPrismaResource`, `createPrismaAdapter` and a companion schema metadata generator. Its allowlisted scalar model facade scopes CRUD inside owned interactive transactions, rejects nested/relation/raw entry points and disconnects each fresh client after transaction settlement. It uses application-filter isolation, which strict routing rejects.

The same conformance cases run separately on real PostgreSQL, MySQL and MariaDB using Prisma 7.10.1. Metadata checks refuse unsafe tenant column types/collations; tests also cover rollback, native transaction expiry, blocked updates and connection closure. Node, NestJS, Hono and other Node JS/TS backends use the same explicit-context router. See the [Prisma guide](packages/prisma/README.md) for generation, pool ownership, schema requirements and error outcomes.

## Node and TypeORM

Node-specific context APIs now live in `@tenantguard/node`, not core. Supply `nodeContext` to the guard when using the convenience TypeORM helper:

```ts
import { createTenantGuard } from '@tenantguard/core';
import { nodeContext } from '@tenantguard/node';
import { withTenantTransaction } from '@tenantguard/typeorm';

const guard = createTenantGuard({
  authorize: verifyMembership,
  carrier: nodeContext,
});
const orders = await guard.run(request, () =>
  withTenantTransaction(dataSource, (manager) =>
    manager.query('SELECT * FROM orders'),
  ),
);
```

The PostgreSQL UUID policy requires canonical lowercase UUID tenant IDs. Every query must use the callback manager. Await all work; do not return a manager or launch detached queries. Nested helper calls are rejected: query through the existing manager. Direct DataSource/global repository calls do not inherit the scoped connection.

For explicit-context data access, `createTenantRouter` and `createTypeormPostgresAdapter` work without a Node ambient tenant scope. See [architecture](docs/architecture.md).

## Hono and Fetch

```ts
import { Hono } from 'hono';
import { createTenantGuard } from '@tenantguard/core';
import { tenantMiddleware, type TenantEnv } from '@tenantguard/hono';

const app = new Hono<TenantEnv>();
app.use(
  '*',
  tenantMiddleware(
    createTenantGuard({
      authorize: async (c) => verifyMembership(c.req.raw),
    }),
  ),
);
app.get('/tenant', (c) => c.json(c.get('tenant')));
```

Supply the default Node carrier when using Node ambient helpers. Without it, pass `c.get('tenant')` explicitly to services/router. The Fetch adapter exposes `withTenant(guard, (request, context) => Response)`. Both map denied membership to 403 and let operational errors reach the host. Runtime-specific edge/driver compatibility is not yet certified.

## NestJS

Import `TenantGuardModule.forRoot({ authorize })`, then apply `@UseInterceptors(TenantGuardInterceptor)` to protected controllers. Authentication guards run first. The authorizer returns `{ tenantId, principalId? }` after membership verification. `@CurrentTenant()` provides that context. The module uses the default Node carrier; database work still requires a scoped transaction or router call.

The older `resolveTenant` option remains supported but is deprecated. See the [example](examples/nestjs-typeorm-saas/README.md).

## PostgreSQL migrations and auditing

Apply `tenantPolicySql('orders')` from `@tenantguard/postgres` in an owner-run migration after creating `tenant_id uuid NOT NULL`. Use a separate restricted runtime role without superuser/BYPASSRLS privileges. Grant only necessary CRUD privileges, use tenant-aware constraints and indexes, and review the [security guide](docs/security.md).

After building:

```sh
DATABASE_URL=postgresql://... node packages/cli/dist/index.js audit
```

The CLI inventories user tables and exits 1 for missing RLS/FORCE/policies or operational errors. It does not prove policy correctness or certify isolation.

## Layout and release status

`packages/`: core, node, fetch, hono, postgres, sqlserver, mysql, mariadb, mongodb, sqlite, scoped-sql, prisma, typeorm, nestjs, testing and cli. `examples/`: NestJS + TypeORM orders endpoint. `apps/docs` and `apps/playground` remain placeholders.

Packages are ESM with TypeScript declarations. No npm packages or hosted services have been published, and package-name availability has not been checked. The [complete roadmap](docs/implementation-plan.md) covers remaining databases, ORMs, frameworks, runtime support, tooling, security review and deployment.
