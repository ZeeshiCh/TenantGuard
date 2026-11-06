# TenantGuard

Multi-tenancy foundations for JavaScript and TypeScript backends.

Early, unpublished prototype. The portable core supports explicit tenant context, authorization contracts and typed routing across multiple named data sources. Node, NestJS, Hono and Fetch integrations are implemented. PostgreSQL has direct pg and TypeORM integrations; other databases have contracts, not implemented adapters.

See the [implementation plan](docs/implementation-plan.md), [architecture and current support](docs/architecture.md), and [security model](docs/security.md).

## Develop

Requires Node.js 22+, pnpm 11.25.0 and Docker for PostgreSQL tests.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:integration
```

`pnpm check` runs formatting, strict type checks, unit tests, browser-target portability builds, package builds and clean packed-package JavaScript/TypeScript consumer tests, including the direct pg entry point. Database tests launch disposable PostgreSQL 17 through Testcontainers. CI also configures Node 22 and 24 checks. `pnpm format` formats sources and documentation.

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

`packages/`: core, node, fetch, hono, postgres, typeorm, nestjs, testing and cli. `examples/`: NestJS + TypeORM orders endpoint. `apps/docs` and `apps/playground` remain placeholders.

Packages are ESM with TypeScript declarations. No npm packages or hosted services have been published, and package-name availability has not been checked. The [complete roadmap](docs/implementation-plan.md) covers remaining databases, ORMs, frameworks, runtime support, tooling, security review and deployment.
