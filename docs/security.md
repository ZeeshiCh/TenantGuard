# Security model

The portable core and framework adapters provide authorization/context/routing boundaries. PostgreSQL policies are implemented through TypeORM and direct pg paths. SQL Server native RLS is implemented through a dedicated Tedious adapter; its session-specific boundary is described below. Other database adapters remain planned. See [architecture](architecture.md) for current support.

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
