# @tenantguard/mongodb

Restricted tenant-scoped CRUD and aggregation for Node.js backends using the official MongoDB driver. This unpublished ESM package implements the portable `DatabaseAdapter<MongoScopedClient>` contract. Node, NestJS, Hono and other Node JS/TS frameworks supply the same explicitly authorized context; no framework-specific database dependency is needed. Core/Fetch/Hono remain portable, but this driver adapter requires Node and MongoDB connectivity.

## Configure and run

Provision an ordinary collection on a replica set before serving requests. Use tenant-aware unique indexes, schema validation requiring a scalar string tenant field, and separate migration/runtime credentials. Give the runtime user only the necessary database/collection CRUD and listCollections metadata privileges. The adapter does not provision users, indexes, schemas or databases.

```ts
import { createTenantRouter } from '@tenantguard/core';
import { createMongoAdapter, createMongoResource } from '@tenantguard/mongodb';

const resource = createMongoResource({
  uri: process.env.MONGODB_URI!,
  database: 'orders_db',
  clientOptions: { maxPoolSize: 10 },
});
const adapter = createMongoAdapter({
  resolveResource: (route) => {
    if (route.resource !== 'orders-main') throw new Error('Unknown resource');
    return resource;
  },
  collections: {
    orders: {
      collection: 'orders',
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
      adapter: 'mongodb',
      resource: 'orders-main',
      revision: '1',
      status: 'active',
      mode: 'application-filter',
    }),
  },
});

// Your authentication/authorization boundary supplies this context.
const rows = await router.run(authorizedContext, 'orders', async (client) => {
  const orders = client.collection('orders');
  await orders.insert({ id: 'order-1', value: 'created' });
  await orders.update({ id: 'order-1' }, { value: 'ready' });
  return orders.find({ id: 'order-1' }, { limit: 10 });
});
// On application shutdown:
await resource.close();
```

Map each named data source to its own adapter; a single router can also contain PostgreSQL, SQL Server, MySQL and MariaDB sources. Transactions apply to one adapter run, with no cross-source ACID guarantee. Resource and credential lookup must be server-controlled. The resource owns its MongoClient; the raw `resource.client` is trusted infrastructure and bypasses facade guarantees. Do not share it with application query code.

## Exact query surface

`collection(alias)` exposes `find`, `insert`, `update`, `delete` and `aggregate`, with promises returning materialized results; there is no native cursor/client/session escape hatch. `find` accepts equality filters, a declared-field sort with 1/-1 directions, and a limit (default 100, maximum 1000). Unknown identifiers, dotted paths and `$` keys are rejected. Equality values are compiled under `$eq`; arbitrary Mongo query operators and JavaScript expressions are unavailable.

Inputs are snapshotted synchronously before operations enter the queue. The initial data grammar is plain JSON: strings with well-formed Unicode, finite safe-range numbers, booleans, null, arrays and plain nested records. Cycles, accessors, functions, BSON Code, ObjectId, Date, RegExp, toBSON hooks, special prototypes and non-JSON values are rejected. Use application string IDs and explicit encodings for dates and other BSON types. Documents have bounded nesting/node counts; native MongoDB size limits still apply. Registered field and collection names are flat ASCII identifiers. Returned values are driver-decoded data; existing collection contents and embedded ownership relationships require application schema review.

Inserts require the configured ID field and inject the current tenant, rejecting a supplied foreign tenant. Updates use generated `$set` with no upsert and cannot change the tenant, configured ID or `_id`. Update/delete require at least one non-tenant filter; they affect all matching own documents and return matched/deleted counts. No replacement updates, pipeline updates, raw operators, bulk API, joins or schema mutations are exposed. Configure tenant-aware uniqueness yourself.

All reads/updates/deletes use a scalar-string ownership check in addition to equality. This prevents Mongo's array matching behavior from treating an array containing a tenant ID as ownership. Binary `simple` collation is forced, so case/accent/padding aliases do not merge even under case-insensitive collection defaults. Tenant IDs beginning with `$` are literal data. Only declared fields are returned by find or admitted into aggregation; `_id` is omitted unless declared.

## Aggregation safeguards

Aggregation starts with an adapter-owned tenant `$match` and declared-field projection. Permitted subsequent stages are:

- `$match`: the same declared/current-field equality grammar.
- `$sort`: current fields with directions 1/-1.
- `$skip`: positive integer up to 100000; `$limit`: 1–1000.
- `$project`: inclusion only (1/true), with current fields and no expressions.
- `$group`: `_id` and `$sum`, `$avg`, `$min`, `$max`, with direct current-field references, finite number literals or null. No arbitrary expressions or system variables.
- `$count`: a valid output identifier.

The compiler tracks fields after transformations, permits at most 20 user stages, appends a 1000-result limit and disables disk use. Native server size/memory limits still apply; the result cap is not a scan or memory budget. `$lookup`, `$unionWith`, `$graphLookup`, `$facet`, `$documents`, `$out`, `$merge`, root replacement, executable/custom expressions, search and every unlisted stage are rejected. No stage may introduce documents from another stream or write pipeline results. A leading tenant match alone would be insufficient for arbitrary MongoDB pipelines.

```ts
const totals = await router.run(context, 'orders', (client) =>
  client
    .collection('orders')
    .aggregate([
      { $group: { _id: '$value', total: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]),
);
```

## Transactions and cleanup

Each run verifies replica-set topology and ordinary collection metadata, creates a fresh explicit logical session and uses the Core transaction API with snapshot reads, majority writes and primary read preference. Sessions remain owned by that run until commit/abort and endSession. Operations serialize even when callers use Promise.all, as MongoDB transactions do not support parallel native operations. Business callbacks are never automatically rerun. Driver protocol retries of a commit command are distinct from rerunning business logic.

Swallowed validation/database errors poison the transaction. Unawaited operations prevent commit. Nested scopes, detached scope reentry and expired facades are rejected. Default request/work/cleanup deadlines are 5/30/5 seconds, each configurable from 1ms to 300s. Driver connect/selection/socket/pool-wait limits are fixed at 5 seconds; server maxTimeMS and maxCommitTimeMS supplement explicit deadlines. The driver 6.22 deprecates timeoutMS, so it is not used to establish these bounds. Deadlines do not cancel arbitrary callback side effects.

Cleanup drains outstanding native promises before aborting and ending a session. If draining/cleanup cannot complete within its bound, or commit outcome is uncertain, the entire owned MongoClient is retired and closed rather than returning an uncertain session to its pool. This may interrupt concurrent scopes on that resource. `closed` is terminal for the adapter: replace retired resources through your infrastructure resolver; no automatic reopening or retry occurs. MongoDB has no SQL-style connection tenant variable to reset; tenant ownership resides in generated predicates and the session carries transaction state.

Ordinary callback errors retain identity after successful cleanup. `MongoLifecycleError` aggregates primary/cleanup errors and exposes `commitOutcome` (`not-committed`, `committed`, `unknown`). Reconcile uncertain writes using application idempotency records; do not blindly retry all failures. A timeout during commit can still mean writes committed. Close resources during orderly shutdown; direct calls to the infrastructure client remain trusted and can reconnect independently of the facade contract.

## Guarantee and verified scope

This is **application-filter** isolation. Strict router mode rejects it. Native access using the same credentials can read foreign documents; there is no native MongoDB tenant RLS claim. Application code, provisioning and schema administrators are trusted. Metadata checks are preflight checks, not protection against privileged concurrent DDL. Tenant-aware indexes, embedded references, global constraint existence leaks, validation rules and triggers/change consumers require separate review. A new transaction is not a sandbox for arbitrary user code.

Tests use an authenticated MongoDB 8.0 replica-set container pinned by digest, a separate readWrite runtime user and a collection with case-insensitive default collation. The same seven reusable adapter conformance cases run with real CRUD/transactions. Additional real tests cover aggregation, aliases/array ownership, caught server errors, session ending, timeout rollback, expired facades, raw bypass and view rejection. Fault-injection unit tests cover uncertain commit, stalled native requests, late resolution and cleanup retirement.

Standalone servers, sharded/mongos deployments, views/time-series/capped collections, Atlas/failover certification, Mongoose, edge runtimes and arbitrary BSON/query/aggregation support remain deferred. No package has been published or hosted service deployed. Install the library inside your backend and connect to your own replica set.

References: [MongoDB transaction APIs](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/), [shared-collection multi-tenancy](https://www.mongodb.com/docs/atlas/build-multi-tenant-arch/), [lookup semantics](https://www.mongodb.com/docs/manual/reference/operator/aggregation/lookup/).
