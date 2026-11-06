# @tenantguard/mongoose

Restricted tenant-scoped Mongoose CRUD, aggregation and explicit replica-set transactions. Verified with Mongoose 9.12.0 on MongoDB 8.0, including Node 22. This unpublished ESM package implements the portable `DatabaseAdapter<MongooseScopedClient>` contract for Node, NestJS, Hono and other Node JS/TS backends.

This is application-filter isolation. Strict routing rejects it. Unwrapped Mongoose/native access can read other tenants; no MongoDB-native RLS guarantee is implied.

## Configure owned models

The adapter creates an isolated Mongoose instance, connection and model registry from declared scalar fields. It does not accept existing application Model/Schema/Connection objects or silently inherit their middleware, plugins, virtuals, transforms or casting behavior. Declare the supported model shape explicitly and provision collections/indexes separately.

```ts
import { createTenantRouter } from '@tenantguard/core';
import {
  createMongooseResource,
  createMongooseAdapter,
} from '@tenantguard/mongoose';

const resource = createMongooseResource({
  uri: process.env.MONGODB_URI!,
  database: 'orders_db',
  connectionOptions: { maxPoolSize: 10 },
  models: {
    orders: {
      collection: 'orders',
      tenantField: 'tenantId',
      idField: 'id',
      fields: {
        id: { type: 'string', required: true },
        tenantId: { type: 'string', required: true },
        value: { type: 'string', required: true },
      },
    },
  },
});
const adapter = createMongooseAdapter({
  resolveResource: (route) => {
    if (route.resource !== 'orders-main') throw new Error('Unknown resource');
    return resource;
  },
});
const router = createTenantRouter({
  sources: { orders: { adapter, mode: 'application-filter' } },
  registry: {
    resolve: async (context, source) => ({
      tenantId: context.tenantId,
      source,
      adapter: 'mongoose',
      resource: 'orders-main',
      revision: '1',
      status: 'active',
      mode: 'application-filter',
    }),
  },
});

// Obtained after authentication and tenant membership authorization.
const rows = await router.run(authorizedContext, 'orders', async (client) => {
  const orders = client.model<{ id: string; tenantId: string; value: string }>(
    'orders',
  );
  await orders.insert({ id: 'order-1', value: 'created' });
  await orders.update({ id: 'order-1' }, { value: 'ready' });
  return orders.find({ id: 'order-1' }, { limit: 10 });
});

// Stop admitting requests before orderly shutdown:
await resource.close();
```

Use existing ordinary collections on a replica set. Provision tenant-aware unique indexes, server validation and any cross-document constraints through trusted migrations. The runtime principal needs collection CRUD and metadata visibility; authentication/TLS are configured in the URI/cloneable connectionOptions. Resource references, credentials, database names and declarations are server-controlled. No implicit collection/index creation occurs: autoCreate/autoIndex and command buffering are disabled.

The resource owns a dedicated connection pool, default maximum 10, with 5s server selection/connect/socket/pool-wait limits and read/write retries disabled. Connection configuration and declarations are snapshotted. The public resource exposes closed/close, not a connection, model, schema or native client. Default-instance plugins are not inherited. Mongoose SchemaType defaults are shared across instances, so construction also rejects inherited setters/getters, defaults and extra type options (for example a global String lowercase transform) before opening a connection. Arbitrary mutation of Mongoose primitives by trusted application code remains outside a sandbox guarantee.

Multiple named sources can route to independent Mongoose resources or other TenantGuard adapters. A transaction applies to one run; no distributed ACID guarantee or tenant provisioning is implemented.

## Exact CRUD and schema surface

`client.model(alias)` exposes promise-returning `find`, `insert`, `update`, `delete` and `aggregate`. Callbacks receive materialized plain data/counts, never Mongoose Query/Aggregate objects, hydrated documents, save/session methods, cursors, model constructors or transaction handles.

Fields support string, number and boolean, with an optional boolean required flag. Tenant and ID must be distinct required string fields. Hooks, refs, populate, aliases, setters/getters, custom validators, defaults, timestamps, discriminators, nested documents, arrays, Mixed, ObjectId, Date, Buffer and custom schema types are outside this initial contract. Unknown declaration options are rejected. `_id`, `__v` and Mongoose-reserved document paths are rejected; use ordinary application field names. The native ObjectId `_id` stays internal, id virtuals and version keys are disabled, and queries project only declared fields.

Primitive input types must match declarations before Mongoose executes. Coercion such as numeric tenant filters into strings is rejected, and schema casting is disabled per field. Values are snapshotted, strings must be well-formed Unicode and numbers finite within the shared policy's safe range. Null is a query value; Mongoose required validation rejects invalid null/missing values on writes. Row generics are application assertions, not certification that previously stored data matches every declared type.

Find accepts declared-field scalar equality filters and optional limit/sort. Limit defaults to 100 and is bounded to 1–1000; sort uses declared fields with 1/-1 directions. Inserts require an application ID and inject tenant identity, rejecting a different supplied tenant. Updates use generated $set assignments, run validators and prohibit tenant/ID/_id changes. Update/delete require a non-tenant filter and return matched/deleted counts. Operator objects, arbitrary Mongoose options, nested writes, replacements, upserts, bulk APIs, raw collection/query access and populate are refused. Native/server validation and constraints remain active; caught failures poison the transaction.

Every read/update/delete includes scalar-string ownership and binary simple collation. Arrays containing a tenant ID, case/accent/padding aliases and ordinary Mongo array-matching semantics cannot widen the tenant boundary. Supplied tenant filters remain constrained independently. Read results are checked for exact tenant identity. Context strings retain the core's authorization/length/whitespace/control-character requirements; IDs beginning with $ are treated as literal data.

Mongoose built-in required/type validation runs on owned models. This is not a drop-in wrapper that preserves arbitrary existing application model semantics. Reproduce any additional application validation outside the facade and enforce critical invariants with reviewed server schema/indexes; do not assume an omitted legacy plugin still runs.

## Aggregation safeguards

The native MongoDB and Mongoose adapters share @tenantguard/scoped-mongo, a portable policy/compiler with no driver, BSON or session dependency. Aggregation starts with adapter-owned scalar ownership matching and declared-field projection. Subsequent permitted stages are:

- $match using the restricted field equality grammar.
- $sort on current fields with 1/-1 directions.
- $skip as a positive integer up to 100000; $limit from 1–1000.
- $project with inclusion only (1/true), without expressions.
- $group with _id and $sum/$avg/$min/$max using direct current-field references, finite number literals or null.
- $count into a valid output identifier.

Fields are tracked after transformations. At most 20 user stages are accepted, a final 1000-row limit is appended, and disk use is disabled. The cap is not a scan/memory budget; native server limits and request deadlines still apply.

$lookup, $unionWith, $graphLookup, $facet, $documents, $out, $merge, root replacement, executable/custom expressions, search/vector stages, system variables, unbounded array accumulators and all unlisted stages are rejected before execution. No stage may bring in a foreign stream or write results. A leading tenant match alone is insufficient for arbitrary pipelines. Mongoose aggregation does not cast the pipeline into a broader application query language.

```ts
const totals = await router.run(context, 'orders', (client) =>
  client
    .model('orders')
    .aggregate([
      { $group: { _id: '$value', total: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]),
);
```

## Transactions, deadlines and retirement

Each scope verifies replica-set topology and existing ordinary collection metadata before creating a session. Views, capped/time-series collections, standalone and mongos/sharded topologies are not supported. Transactions explicitly use snapshot reads, majority writes and primary read preference; every Mongoose operation receives the same owned session. Native model calls serialize, including when callbacks use Promise.all.

The adapter uses the driver's explicit start/commit/abort API rather than Mongoose Connection.transaction or withTransaction, whose callbacks can be retried. Business callbacks are never automatically rerun. Driver protocol retries of a commit command are distinct from rerunning application work. No hydrated documents escape, so Mongoose document change-tracking rollback semantics are not exposed.

Caught schema/query/ownership errors poison the scope and block later operations/commit. Pending unawaited work cannot commit. Nested scopes, detached scope reentry and expired repositories reject further use. Defaults are acquireTimeoutMs 5000, requestTimeoutMs 5000, operationTimeoutMs 30000 and cleanupTimeoutMs 5000; each accepts 1ms–300s. Native selection/connect/socket limits remain 5s, with execution/commit server limits supplementing explicit timers. Resource resolution and connection readiness are separately bounded. A callback deadline cannot cancel arbitrary application side effects.

All actual native promises, including metadata, connection and asynchronous session acquisition, remain tracked after a caller-facing timeout. Cleanup drains them before aborting an active transaction and ending the session. A late session is ended before safe reuse, even when its acquisition deadline expired. If draining/abort/endSession cannot be confirmed within the cleanup bound, or commit outcome is unknown, the entire owned Mongoose connection is terminally destroyed. Socket/disconnection failures also retire it. This can interrupt other scopes on that pool; new work requires an explicit replacement resource.

Mongoose destroy prevents reopening and removes the connection from its instance's registry. Connection/OS shutdown can still wait on native work; retirement deadlines do not prove immediate server-side cancellation. Cleanup/retirement phases have separate bounds. Closing a resource blocks new facade work and asks active sessions to close, while arbitrary business callbacks may continue until their own deadline. Stop request admission before shutdown.

Ordinary callback errors preserve identity when abort/end succeed. MongooseLifecycleError aggregates primary/cleanup errors and includes commitOutcome (not-committed, committed, unknown). Cleanup failure after acknowledged commit is committed; a lost/failed commit attempt is conservatively unknown. MongooseTimeoutError carries phase/outcome; read the lifecycle aggregate outcome after a cleanup failure. Use idempotency records and reconcile uncertain writes rather than blindly retrying.

## Verified support and deployment

Tests use a real authenticated MongoDB 8.0 replica set pinned by digest, separate runtime credentials, binary tenant-aware uniqueness and a case-insensitive collection default. The exact same seven reusable conformance cases pass. Additional real tests cover aggregation escape paths, scalar/array/collation aliases, validation/constraint rollback, default-plugin isolation, plain results, native session ending, callback expiry, pending writes, views and active shutdown. Opt-in failpoints in the disposable test server prove request draining and connection retirement during actual blocked native commands. Production resources do not enable those failpoints.

Fault-injection tests cover standalone refusal, failed/uncertain commit, abort/end failures, transport errors, stalled queries and late/stalled session acquisition. The suite also passes separately on Node 22. Packed JavaScript and fully strict TypeScript consumers install the actual Mongoose dependency closure independently of the direct MongoDB driver's closure. Mongoose 9.12 uses MongoDB driver 7 while the direct adapter uses driver 6; shared primitive policy does not mix their BSON/session classes. Both adapters are exercised in the same repository, and the real Mongoose fixture uses the direct driver for admin observation.

Mongoose 9.12.0 and MongoDB 8.0 on a replica set are the verified scope. Existing Model/Schema wrappers, arbitrary plugins/validators, populate/discriminators, broad BSON/schema support, mongos/Atlas/failover certification, edge/Bun/Deno, performance certification, native-policy mode and independent review remain future work. Application code, provisioning, native access, triggers/consumers and embedded/related ownership rules remain trusted/reviewed boundaries. No package or service is published or deployed; install the library inside your backend with your own replica set and migrations.

References: [Mongoose transaction/session APIs](https://mongoosejs.com/docs/transactions.html), [connection ownership and destroy](https://mongoosejs.com/docs/api/connection.html), [Mongoose aggregation](https://mongoosejs.com/docs/api/aggregate.html).
