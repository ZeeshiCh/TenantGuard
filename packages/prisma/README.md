# @tenantguard/prisma

Restricted tenant-scoped CRUD over Prisma interactive transactions, verified with Prisma 7.10.1 on PostgreSQL 17, MySQL 8.4 and MariaDB 11.8. This unpublished ESM package uses the portable `DatabaseAdapter<PrismaScopedClient>` contract. Node, NestJS, Hono and other Node JS/TS backends provide the same explicitly authorized tenant context.

This is application-filter isolation. Strict routing rejects it. Native Prisma clients, extensions and raw database calls can bypass the facade. PostgreSQL support here does not automatically install or configure RLS or inherit the direct pg adapter's native-policy guarantees.

## Generate client and schema metadata

Install the adapter from the local workspace/packed artifact until packages are published. The application supplies Prisma CLI/client and the provider's driver adapter, pinned to the tested 7.10.1 versions. Use the application schema to generate both Prisma Client and TenantGuard metadata:

```prisma
generator client {
  provider = "prisma-client"
  output = "./generated/prisma"
  moduleFormat = "esm"
}
generator tenantguard {
  provider = "tenantguard-prisma-generator"
  output = "./generated/tenantguard"
}
datasource db {
  provider = "postgresql"
}
model Order {
  id String @id
  tenantId String @map("tenant_id")
  value String
  @@map("orders")
}
```

Run `pnpm prisma generate` from the application with the installed generator binary on PATH, then apply your reviewed migrations separately. The companion generator uses Prisma's generator protocol and DMMF to write `datamodel.json`, preserving scalar/relation kinds, required/list flags and model/column/schema mappings. Ship that metadata with your generated client; regenerate both after schema changes. This avoids relying on private PrismaClient internals or incomplete query-extension interception. Do not fabricate metadata from request input.

The workspace's `pnpm generate:prisma` generates both fixture clients and metadata, with a schema/tooling hash cache. Type checking and integration scripts invoke it automatically. Generated fixture output is ignored by Git. Prisma setup scripts are explicitly enabled in pnpm-workspace.yaml; first generation needs the platform schema engine. No databases are provisioned by generation.

## Configure the resource and router

```ts
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { createTenantRouter } from '@tenantguard/core';
import {
  createPrismaResource,
  createPrismaAdapter,
  type PrismaDatamodel,
} from '@tenantguard/prisma';

const datamodel = JSON.parse(
  readFileSync(
    new URL('./generated/tenantguard/datamodel.json', import.meta.url),
    'utf8',
  ),
) as PrismaDatamodel;
const resource = createPrismaResource({
  provider: 'postgresql',
  datamodel,
  createClient: () =>
    new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 4000,
        lock_timeout: 1000,
        idle_in_transaction_session_timeout: 10000,
      }),
    }),
});
const adapter = createPrismaAdapter({
  resolveResource: (route) => {
    if (route.resource !== 'orders-main') throw new Error('Unknown resource');
    return resource;
  },
  models: {
    orders: {
      model: 'Order',
      tenantField: 'tenantId',
      idField: 'id',
      fields: ['id', 'tenantId', 'value'],
    },
  },
});
const router = createTenantRouter({
  sources: { orders: { adapter, mode: 'application-filter' } },
  registry: {
    resolve: async (context, source) => ({
      tenantId: context.tenantId,
      source,
      adapter: 'prisma',
      resource: 'orders-main',
      revision: '1',
      status: 'active',
      mode: 'application-filter',
    }),
  },
});

// Obtained from the application's membership authorizer, after authentication.
const result = await router.run(authorizedContext, 'orders', async (client) => {
  const orders = client.model('orders');
  await orders.insert({ id: 'order-1', value: 'created' });
  await orders.update({ id: 'order-1' }, { value: 'ready' });
  return orders.find({ id: 'order-1' }, { limit: 10 });
});

// After stopping request admission:
await resource.close();
```

The factory must construct a **fresh, plain, unextended PrismaClient with its own driver adapter and owned pool for each scope**. Do not return a singleton, a transaction client, an extended client, an externally shared native pool or a client used outside this adapter. Client identity reuse is rejected; pool ownership/extensions cannot be proven through Prisma's public structural interface and remain trusted infrastructure contracts. The package does not import the application's generated client at runtime; generated clients are checked against `PrismaClientLike` by TypeScript in real fixtures.

Each run disconnects its client after transaction settlement. Connections are not reused between adapter scopes. This deliberately trades pool/engine startup overhead for lifecycle isolation and avoids returning an uncertain connection to the next tenant's application pool. Bound application concurrency and native driver connect/acquisition/statement/socket limits; per-client pool size is not a global connection limit. Configure native authentication/TLS in the factory.

For MySQL and MariaDB use Prisma's mysql datasource, `PrismaMariaDb` from @prisma/adapter-mariadb and `provider: 'mysql'`. Construct its owned pool from connection configuration inside the factory, with finite connectionLimit/connectTimeout/acquireTimeout/socketTimeout. A tenant String field must map to VARCHAR NOT NULL with `utf8mb4_0900_bin` on MySQL or `utf8mb4_nopad_bin` on MariaDB. A `_bin` collation that still pads spaces is insufficient. Review migrations explicitly; Prisma's schema alone does not express this guarantee. Both engines are tested independently.

Resource and credential lookup must use allowlisted server references. Separate named sources can use different Prisma resources/providers or direct-driver adapters. Transactions apply to one run; there is no cross-source ACID guarantee or automatic tenant provisioning.

## Exact model API and schema requirements

`client.model(alias)` exposes `find`, `insert`, `update` and `delete`, returning promises and materialized rows/counts. There is no native delegate, client, transaction object, raw query, `$extends` or `$transaction` escape hatch.

Models and fields are allowlisted using generated metadata. Tenant and ID must be distinct required String fields. Only non-list scalar String, Int, BigInt, Float, Boolean, DateTime and Bytes fields are supported. Relation/object fields, scalar lists, Json, Decimal, enums, relation filters/includes, nested writes, connect/disconnect, upserts, createMany, aggregate/groupBy, arbitrary Prisma options and raw queries are rejected. Declared-field projections prevent accidental nested relation reads. Root-owned scalar references still require tenant-aware schema/application validation.

Filters accept scalar equality values only. The compiler builds an independent tenant equality inside AND and scalar `equals` filters; it does not spread user-supplied Prisma argument objects into a delegate call. Strings are well-formed Unicode, integer numbers must be safe, bigints signed 64-bit, dates valid and byte arrays copied. Mutable inputs are snapshotted before queueing; unsupported objects, accessors, functions and operator objects are rejected. The actual Prisma field type must accept the supplied scalar; native validation failures poison the transaction. Returned Date/Bytes/integer decoding follows Prisma's generated client. Row generics are application type assertions rather than runtime schema coercion.

Find defaults to 100 rows, ID ascending and offset 0. Limit is 1–1000, offset a bounded nonnegative integer; sorting uses a declared field and asc/desc. Inserts require an ID and inject tenant identity, rejecting a supplied foreign tenant. Updates cannot change ID/tenant and accept scalar assignments only. Update/delete require a non-tenant filter and return Prisma's affected count. Database defaults, keys and other constraints remain application-owned.

Before business work, fixed internal metadata queries run inside the interactive transaction. PostgreSQL requires ordinary tables and ordinary TEXT/VARCHAR NOT NULL tenant columns using deterministic collations. UUID/citext/domain tenant encodings, views and partitioned tables are not supported here. MySQL/MariaDB require ordinary InnoDB tables and ordinary VARCHAR NOT NULL tenant columns with the approved binary NO PAD collations above. Missing/invisible metadata fails closed. These checks preserve case/accent/padding distinctions without unsupported ORM query rewrites. Read results are additionally checked for exact tenant identity.

Metadata checks do not audit every grant, mapped field, policy expression, function, trigger or schema semantic. Schema/DDL must remain trusted and consistent with generated clients; review concurrent privileged changes, tenant-aware unique/FK constraints, cascades, triggers and global existence leaks. Native RLS can add protection only when independently configured and integrated; this adapter does not set PostgreSQL tenant session variables.

## Transaction handling and outcomes

Every run uses an interactive transaction with Serializable isolation and explicit maxWait/timeout. Facade calls serialize, including when users call Promise.all. All calls stay on the callback's transaction client. Caught validation/database errors poison the scope, stop queued operations and force rollback; unawaited work cannot commit. Nested scopes, detached scope reentry and escaped facades are rejected. Business callbacks are never automatically rerun, including after serialization conflicts.

Default limits are maxWaitMs 5000, transactionTimeoutMs 30000, operationTimeoutMs 25000, requestTimeoutMs 5000 and cleanupTimeoutMs 5000. Each accepts 1ms–300s. Resource resolution and client creation are bounded by maxWaitMs separately; Prisma receives maxWait/timeout for native transaction handling. The work deadline begins at business callback execution. A transaction-settlement watchdog also bounds the acquisition/transaction path by maxWait + transactionTimeout + cleanup; cleanup/disconnection waits are separately bounded. Keep operationTimeout below transactionTimeout for the clearest callback error semantics.

On callback failure Prisma owns native rollback; the adapter waits for the transaction promise to settle before disconnecting its dedicated client. If settlement or disconnection cannot be confirmed, the resource is terminally retired, active clients are asked to disconnect and subsequent scopes are rejected. Late client factories disconnect their clients without starting transactions. A settled but failed commit closes that client and reports unknown outcome; the resource can serve a fresh owned client when cleanup succeeded. Calling close retires the resource and asks active clients to disconnect; pending factory results are disposed on arrival.

Ordinary callback errors preserve identity when transaction settlement and cleanup succeed and the callback was not commit-ready. PrismaLifecycleError aggregates primary/cleanup failures and exposes commitOutcome (`not-committed`, `committed`, `unknown`). Once the business callback has returned successfully, a Prisma transaction rejection is conservatively unknown because the public API does not provide a native commit acknowledgment separate from that rejection. Cleanup failure after successful transaction resolution reports committed. Use the aggregate's outcome after a lifecycle failure; individual timeout errors describe their phase.

Public Prisma APIs do not expose native socket destruction or a rollback acknowledgment hook. `$disconnect()` can wait on native work; deadlines/quarantine prevent reuse but do not prove immediate server-side cancellation or physical termination. Configure bounded native driver/server timeouts and reconcile unknown operations through idempotency records. Arbitrary callback side effects cannot be undone by transaction rollback or timeouts. Retired resources require explicit replacement, with no hidden reconnection/retry by this adapter.

## Verified scope

The same seven reusable conformance cases run independently with real generated Prisma clients on PostgreSQL, MySQL and MariaDB using restricted runtime credentials. Additional real checks cover native access bypass, binary aliases, relation/nested/operator refusal, caught constraint failures, serialization, expired facades, work/native transaction expiry, pending writes, unsafe collations, blocked updates and native connection closure after rollback. Fault-injection tests cover late factories, stale clients, failed/uncertain commits, disconnection failures and bounded retirement.

The Prisma suites also pass separately on Node 22. The packed package consumer executes the installed metadata generator through the real Prisma CLI, exercises the adapter's public contract and resolves installed TypeScript declarations. The full database regression suite still includes direct PostgreSQL, SQL Server, MySQL, MariaDB, MongoDB and SQLite adapters.

Only Prisma 7.10.1 with PostgreSQL/MySQL/MariaDB is verified by this milestone. Prisma 8 prereleases, other versions/providers, Accelerate/Data Proxy, externally shared pools, extensions, Prisma relation/query parity, native-policy mode, distributed transactions, edge/Bun/Deno runtimes, benchmarks and independent security review remain future work. No package has been published or hosted service deployed; this library runs inside your backend alongside your generated Prisma client and database resources.

References: [Prisma interactive transactions and limits](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions), [generating Prisma Client](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/generating-prisma-client), [extension limitations for nested operations](https://docs.prisma.io/docs/orm/v6/prisma-client/client-extensions).
