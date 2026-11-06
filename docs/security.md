# Security model

The portable core and framework adapters provide authorization/context/routing boundaries. PostgreSQL policies are implemented through TypeORM and direct pg paths. SQL Server native RLS is implemented through a dedicated Tedious adapter; its session-specific boundary is described below. MySQL and MariaDB use application-filter CRUD adapters as described below; MongoDB and SQLite remain planned. See [architecture](architecture.md) for current support.

Core tenant IDs are case-sensitive. The PostgreSQL UUID adapter requires canonical lowercase UUIDs to avoid treating different string identities as one database UUID. Trusted context constructors do not authenticate or authorize; use a membership-checking authorizer at request boundaries.

TenantGuard protects against accidentally omitted tenant predicates in queries executed by a restricted application role. It trusts application code to authenticate users, authorize tenant membership, and set the correct context. A raw header, URL parameter or unsigned token is not a verified tenant identity.

The application database role must be NOSUPERUSER NOBYPASSRLS, must not own tables or have schema/DDL privileges, must not inherit privileged roles, and must not be allowed to SET ROLE to a privileged identity. The transaction adapter checks the current role's direct superuser/BYPASSRLS attributes, but cannot prove the complete privilege graph. Use a separate owner for migrations. FORCE RLS is defense in depth, not a substitute for least privilege.

The policy generator creates a permissive policy to allow matching rows and a restrictive policy to bound other permissive policies. Both use USING and WITH CHECK. Missing or empty tenant settings produce no matches; malformed settings fail the query. Tenant columns must be UUID NOT NULL. Policies apply to ordinary CRUD, not TRUNCATE. Do not grant TRUNCATE. Review views, partitions, security-definer functions, referential-integrity error disclosures and side channels separately.

Tenant context is transaction-local. All queries must use the manager supplied by withTenantTransaction or the callback client supplied by the direct pg adapter. Session-level tenant settings are unsupported: never use SET or set_config(..., false) for tenant context on the application pool. PostgreSQL restores prior session settings after a transaction; a contaminated pool must be discarded. Each request or background job must establish its own authorized context and await its database work. The direct router path uses explicit context; the TypeORM convenience helper uses the Node carrier. runWithTenant is a trusted application primitive, not a membership check.

RLS using a custom setting does not protect against arbitrary SQL injection or malicious application code: the database role can change that setting. Parameterize queries and secure application credentials. TenantGuard does not implement identity verification, tenant provisioning, per-tenant encryption, rate limits or a security sandbox.

The audit CLI checks catalog flags and policy presence only. It does not validate policy semantics, effective role membership, grants, owners, functions or views. Its output must not be used as certification.

References: [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [transaction-local configuration](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET).

## Direct pg adapter boundary

The direct adapter requires dedicated pools and performs additional role, declared-table and session checks, with bounded cleanup and connection destruction when reuse is uncertain. Its query facade rejects transaction/session commands and multiple SQL statements; it is not a sandbox against malicious trusted SQL/functions. Policy expressions, all undeclared tables, SECURITY DEFINER functions, views and privileged infrastructure still need independent review. The presence of a restrictive policy does not prove that its predicate is correct.

After a COMMIT attempt, an error may mean writes already committed or that their outcome is unknown. Read commitOutcome on PgTimeoutError/PgCleanupError/PgCommitError, preserve idempotency keys and reconcile uncertain operations instead of blindly retrying. Ordinary callback errors are preserved when rollback succeeds. See the [direct adapter guide](../packages/postgres/README.md) for pool ownership and supported statements.

TypeORM retains its existing lifecycle implementation and does not automatically gain the direct adapter's cleanup/timeout protections. No independent security review or PostgreSQL partition/proxy certification is claimed.

## SQL Server boundary

Native policies filter reads/updates/deletes and block foreign inserts or ownership changes. SESSION_CONTEXT is session-scoped and remains after rollback, so the adapter clears it explicitly, verifies state, resets the physical connection and verifies again before pooling. Read-only keys, uncertain cleanup, timeout and socket failures force destruction. Runtime logins must not be able to alter policies/predicate functions, manage security or impersonate privileged principals. Required policy metadata must be visible; unknown permission checks fail closed.

The T-SQL data-batch prefix check is not a parser or SQL injection defense. Do not embed transaction/session management in callback batches or expose arbitrary SQL to users. Such contract violations can have already-committed effects; outcome reporting cannot undo them. Policy functions, signed/impersonating modules, broader role grants and undeclared tables require independent review. The SQL Server adapter does not imply Azure SQL or arbitrary topology certification, and the audit CLI is still PostgreSQL-only.

See the [SQL Server guide](../packages/sqlserver/README.md) for pool ownership, grants, commit outcomes and the local emulation/native CI distinction.

## MySQL and MariaDB application-filter boundary

These engines use a restricted generated CRUD surface, not native tenant row policies. Every query through that surface includes independent, byte-exact tenant predicates; inserts inject the tenant and updates cannot change it. Unknown resources/columns, SQL fragments/operators, invalid encodings and unsupported operations are rejected. Raw native access using the same credentials can read foreign rows and is outside this guarantee. Strict router mode refuses these adapters.

Pinned InnoDB transactions, poisoned swallowed failures, verified resets, explicit advisory-lock release and destruction of uncertain sessions protect connection lifecycle. The server sentinel is diagnostic, not an authorization policy. Least privilege, tenant-aware keys/FKs and review of triggers/stored routines/cascades remain necessary; global constraint errors can reveal existence information. Table/column metadata checks are not a full grant or schema-security audit. See the [shared guide](../packages/scoped-sql/README.md) for the exact supported CRUD grammar and operational limits.

## MongoDB application-filter boundary

MongoDB shared collections are isolated only through the restricted facade; native driver access bypasses it and strict routing refuses it. Generated ownership checks require a root scalar string with binary equality, excluding array-valued ownership and collation aliases. Aggregation admits only stages over the already scoped stream; foreign-stream reads, nested pipelines, result writes and executable expressions are forbidden. Existing embedded documents still require application ownership/schema review.

Logical sessions carry transaction state, not tenant authorization. Explicit abort/endSession follows drained operations; uncertain cleanup or commit retires the owned client, which can disrupt concurrent scopes. Business callbacks are never automatically retried. Interpret MongoLifecycleError.commitOutcome before reconciliation/retry. Snapshot transactions and metadata preflight do not protect against privileged DDL or compromised trusted application code. See the [MongoDB guide](../packages/mongodb/README.md) for tested topology, limits and error semantics.

## SQLite application-filter boundary

SQLite ownership is enforced by generated CRUD predicates requiring scalar TEXT and BINARY equality. Native file access bypasses those predicates; strict routing refuses the adapter. The private worker exposes neither raw SQL nor connection/transaction handles. Existing files, migration code, OS permissions and schema are trusted. Review triggers, cascades, references and global constraints for indirect effects and existence leaks; schema metadata alone does not certify them.

Fresh per-scope connections and explicit transaction-state checks prevent context/transaction reuse. Caught errors, automatic rollback conflicts and unawaited work cannot silently turn later statements into autocommit writes. Cleanup rolls back active transactions, verifies state and closes the connection and worker. On uncertainty the resource is terminally retired, with no callback retries or silent reopening. Native calls can delay worker termination/file-lock release even after the caller's deadline. SqliteLifecycleError.commitOutcome distinguishes uncertain/committed operations from confirmed rollback. See the [SQLite guide](../packages/sqlite/README.md) for exact storage/runtime and termination limits.

## Prisma application-filter boundary

The Prisma adapter exposes generated scalar CRUD with independent tenant predicates, not native Prisma clients or arbitrary extension/query arguments. Schema-derived metadata rejects relation/list fields and nested operations; live database checks refuse unsafe tenant types/collations and nontransactional tables. This is application filtering: native Prisma/raw access bypasses it, and strict routing rejects it. Generated client/metadata, unextended factories, dedicated pool ownership, schema and application code remain trusted.

Fresh clients are disconnected after settled interactive transactions. Caught errors and pending work cannot commit. If transaction cleanup/disconnection cannot be confirmed, resources are quarantined against reuse; Prisma public APIs cannot certify immediate physical socket destruction. Commit-ready failures can have unknown outcome, while disconnection failure after successful transaction resolution is committed. Read PrismaLifecycleError.commitOutcome before retry/reconciliation. No business callback is automatically retried. Triggers, cascades, references, policy expressions and global constraint leaks need separate review. See the [Prisma guide](../packages/prisma/README.md).

## Drizzle application-filter boundary

Drizzle CRUD uses declared concrete scalar tables with independent binary tenant predicates; raw SQL objects, operators, relations, hooks, aliases and native handles are not exposed through the facade. Native Drizzle access using the same credentials bypasses it and strict routing rejects this mode. Live table/type checks and explicit binary comparisons supplement schema validation; they are not a complete privilege, trigger, cascade, policy or constraint audit. Drizzle schema objects and migration/DDL code remain trusted and immutable during use.

Owned native connections pin each transaction and are never reused between scopes. Caught failures/pending work cannot commit; socket errors, timeouts and cleanup failures trigger rollback/closure or destruction. Closing uncertainty retires the resource. DrizzleLifecycleError.commitOutcome distinguishes acknowledged commit from not-committed/unknown outcomes; no callback is automatically retried. Native/OS cancellation and arbitrary callback side effects are outside timer guarantees. See the [Drizzle guide](../packages/drizzle/README.md) for supported drivers and lifecycle limits.

## Mongoose application-filter boundary

Owned isolated models replace interception of arbitrary application models: callbacks receive only declared scalar CRUD/plain rows and guarded aggregation. Existing middleware, plugins, populate, virtuals, setters/getters and native handles are not inherited/exposed. Schema declarations and values reject unsupported features before queries; primitive types must match and implicit casts are disabled. Resource construction refuses inherited global SchemaType transforms/defaults and reserved paths, preventing global lowercase/setter settings from rewriting tenant identity. Shared ownership checks require root scalar strings and simple collation; guarded pipelines cannot read foreign streams, execute custom code or write results.

Explicit sessions carry snapshot/majority transactions and every native model call is serialized. Caught failures/pending work cannot commit. Cleanup drains all actual promises before abort/endSession, and uncertain cleanup/commit retires the entire connection rather than recycling a session. Native server-stall tests verify both draining and retirement. MongooseLifecycleError.commitOutcome governs reconciliation; callbacks are not automatically retried. Native access, privileged schema changes, existing data validation and relationship/consumer effects remain outside the application-filter guarantee. Strict routing rejects it. See the [Mongoose guide](../packages/mongoose/README.md).

## HTTP framework authorization boundaries

Express, Fastify and Koa adapters invoke the application guard after authentication and create a frozen Node tenant scope only for authorized continuations. Undefined memberships and authorization denials return 403. Other errors propagate; a downstream authorization error is not reclassified as an initial denial. Tenant headers are not interpreted by adapters. Protect every relevant route, including error/retry paths, through framework middleware order or Fastify encapsulation. Database isolation still comes from the configured database adapter and its operating mode.

Request isolation uses AsyncLocalStorage.run, preserving any guard carrier as well. Public requests do not inherit protected contexts. A response or client disconnect does not revoke already-created async resources or cancel database operations. Await work and authorize jobs separately; do not assume detached tasks lose tenant access at response completion. Koa upstream middleware runs outside the nested scope, whereas downstream Express/Fastify error handlers can access the authorized context.

## Cached routing metadata

The registry cache is not an authentication/membership cache. It preserves every context identity field in keys and validates/freeze-copies route ownership and references before publication. Known inactive statuses may be cached but are rejected by the router. Invalid routes and provider failures do not become cache entries. Expired entries are never used as outage fallback. Invalidation rejects affected waiters and prevents late native results from repopulating the cache. Timed-out/invalidated native work remains bounded and tracked until settlement.

An active cached route can remain usable until invalidation/TTL expiry. Operators must deliver trusted invalidations to every process for suspension, movement and secret/resource revision changes, and handle reconnect gaps before resuming traffic. This local wrapper supplies no durable event delivery or immediate cluster-wide revocation guarantee. Already-returned routes and acquired transactions are not revoked. No actual secrets should be returned by a registry; secretRef is an opaque application-controlled reference. Cache closure drains provider lookups, but application-owned providers, event subscriptions and data pools require their own shutdown order and native I/O deadlines.

## Managed resource generations

Managed resources are selected only from explicitly registered, active server-controlled routes. The tenant/source/adapter selector and complete resource/revision/secretRef/mode generation must match before work starts. Compare-and-set replacement prevents a stale expected revision from replacing the current registration. Revision values are opaque; control-plane event ordering and authoritative state reconciliation remain application-owned. Idle eviction retains route registration so obsolete metadata cannot silently recreate an old resource.

Resource capacity includes pending native factories, draining leases, actual disposal and quarantined failures. Rotation cannot bypass global/per-tenant bounds, and no uncertain native cleanup is treated as free capacity. Existing leases remain pinned through adapter cleanup; membership authorization and database isolation still belong to the guard and native adapter. Raw resources are trusted infrastructure only. Do not expose native pool handles or detach work from generic manager callbacks.

A cleanup failure retires the whole manager, reports original causes and retains uncertain capacity. Shutdown/disposal deadlines do not cancel I/O or force-close acquired transactions. After a rejected shutdown, real resources can still be live and draining; a stable rejected close promise is not evidence of successful disposal. Native factory/driver deadlines, connection limits and supervision remain required application configuration. Credential values live in an external resolver; route revisions trigger replacement, not database credential mutation or immediate revocation of already-authenticated sessions.
