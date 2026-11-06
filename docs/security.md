# Security model

The portable core and framework adapters provide authorization/context/routing boundaries. The database guarantees below describe only the implemented PostgreSQL + TypeORM path. Other database adapters remain planned. See [architecture](architecture.md) for current support.

Core tenant IDs are case-sensitive. The PostgreSQL UUID adapter requires canonical lowercase UUIDs to avoid treating different string identities as one database UUID. Trusted context constructors do not authenticate or authorize; use a membership-checking authorizer at request boundaries.

TenantGuard protects against accidentally omitted tenant predicates in queries executed by a restricted application role. It trusts application code to authenticate users, authorize tenant membership, and set the correct context. A raw header, URL parameter or unsigned token is not a verified tenant identity.

The application database role must be NOSUPERUSER NOBYPASSRLS, must not own tables or have schema/DDL privileges, must not inherit privileged roles, and must not be allowed to SET ROLE to a privileged identity. The transaction adapter checks the current role's direct superuser/BYPASSRLS attributes, but cannot prove the complete privilege graph. Use a separate owner for migrations. FORCE RLS is defense in depth, not a substitute for least privilege.

The policy generator creates a permissive policy to allow matching rows and a restrictive policy to bound other permissive policies. Both use USING and WITH CHECK. Missing or empty tenant settings produce no matches; malformed settings fail the query. Tenant columns must be UUID NOT NULL. Policies apply to ordinary CRUD, not TRUNCATE. Do not grant TRUNCATE. Review views, partitions, security-definer functions, referential-integrity error disclosures and side channels separately.

Tenant context is transaction-local. All queries must use the manager supplied by withTenantTransaction. Session-level tenant settings are unsupported: never use SET or set_config(..., false) for tenant context on the application pool. PostgreSQL restores prior session settings after a transaction; a contaminated pool must be discarded. Each request or background job must enter its own runWithTenant scope and await its database work.

RLS using a custom setting does not protect against arbitrary SQL injection or malicious application code: the database role can change that setting. Parameterize queries and secure application credentials. TenantGuard does not implement identity verification, tenant provisioning, per-tenant encryption, rate limits or a security sandbox.

The audit CLI checks catalog flags and policy presence only. It does not validate policy semantics, effective role membership, grants, owners, functions or views. Its output must not be used as certification.

References: [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [transaction-local configuration](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET).
