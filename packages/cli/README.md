# @tenantguard/cli

Read-only, explicitly scoped database diagnostics for Node >=22.16. Run the CLI in a developer shell, CI job or deployment environment with access to the intended database. It requires no hosted TenantGuard service and works independently of the backend framework.

After building the workspace:

```sh
node packages/cli/dist/index.js doctor --config examples/tenantguard.diagnostics.json
node packages/cli/dist/index.js doctor --config examples/tenantguard.diagnostics.json --connect --json
node packages/cli/dist/index.js audit --config examples/tenantguard.diagnostics.json --json
```

The installed package exposes the same commands as `tenantguard`. `doctor` validates configuration and all environment references offline by default; `--connect` also inspects catalogs and deployment readiness. `audit` connects and inspects isolation metadata. Neither command changes schemas, grants, policies or business rows. Configuration errors prevent every connection from starting.

## Configuration

Only explicit JSON configuration is accepted. The previous prototype's `DATABASE_URL=... tenantguard audit` invocation is replaced by required `--config` and declared targets. No executable config, automatic `.env` loading, schema discovery or URL arguments are supported.

```json
{
  "version": 1,
  "concurrency": 2,
  "sources": [
    {
      "name": "orders",
      "engine": "postgres",
      "mode": "database-policy",
      "urlEnv": "TG_POSTGRES_URL",
      "targets": [
        { "schema": "public", "table": "orders", "tenantColumn": "tenant_id" }
      ]
    },
    {
      "name": "archive",
      "engine": "sqlite",
      "mode": "application-filter",
      "filenameEnv": "TG_SQLITE_FILE",
      "targets": [{ "table": "orders", "tenantColumn": "tenant_id" }]
    }
  ]
}
```

Set the referenced environment variables through your secret manager or shell. SQL connection URLs require explicit nonempty username/password and a database; MongoDB requires an explicit database and authenticated identity for connected checks. SQLite requires an absolute path to an existing ordinary file; diagnostics never create it. Keep source aliases and identifiers free of secrets because they appear in reports.

Unknown fields, duplicate aliases/targets, invalid identifiers, mismatched MySQL database scopes and unsupported isolation modes are rejected. Identifiers use ASCII letters, digits and underscores, begin with a letter or underscore, and are at most 63 characters. Each source has 1–128 targets; each config has 1–32 sources. `concurrency` is 1–4 (default 2). `timeoutMs` is 200–60000 per source (default 10000), shared across native and published-tool phases. `idColumn` defaults to `id` and must differ from `tenantColumn`. Schemas default to `public`, `dbo` or `main` where applicable. SQL Server targets optionally declare `securitySchema`, `predicateName` and `policyName` to match the native adapter's helper names.

TLS defaults to certificate/hostname verification. `tls: "disabled"` explicitly permits local plaintext connections and emits a warning; SQL Server alone accepts `tls: "insecure"` for encrypted but unverified development servers. Use trusted certificates in deployed environments. SQL URL query options are rejected; MongoDB only accepts validated `authSource`, `replicaSet` and `directConnection`. SRV URLs cannot specify a port or direct connection. `NODE_EXTRA_CA_CERTS` is forwarded to diagnostic subprocesses. Integrated authentication, arbitrary driver options and multi-host MongoDB seed-list URLs are outside this config version.

`strict: true` rejects application-filter sources during validation. This is a capability requirement, not a claim that a successful catalog inspection proves isolation.

## Engine coverage

| Engine     | Native catalog checks                                                                                                                   | Additional shipped tool                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| PostgreSQL | Effective elevated role paths, UUID ownership, enabled/forced RLS, policy bindings and supported helper expressions                     | `tenant-audit@0.2.0` for audit; `db-deploy-doctor@0.2.0` for connected doctor |
| SQL Server | Elevated/impersonation permissions, UUID ownership, enabled schema-bound filter and write-block bindings, supported function definition | Native checks only                                                            |
| MySQL      | Live engine identity, InnoDB, required ownership, tenant-leading index/collation, direct elevated grants                                | Both published tools, according to command                                    |
| MariaDB    | Same native application-filter checks, including explicit engine verification                                                           | Connected doctor only; published tenant-audit 0.2.0 does not support MariaDB  |
| MongoDB    | Authenticated role/privilege metadata, replica-set sessions, collection/validator/index/collation metadata                              | Native checks only                                                            |
| SQLite     | Existing read-only file, ordinary tables, required TEXT ownership and tenant-leading binary indexes                                     | Connected doctor only                                                         |

MySQL, MariaDB, MongoDB and SQLite require scoped application queries; catalog checks cannot enforce query scoping. MongoDB diagnostics require replica-set session support because that is the adapter's transaction contract. PostgreSQL/SQL Server recognize the supported TenantGuard helper templates; custom or invisible policy definitions yield an incomplete inspection rather than an inferred pass. Effective MySQL role inheritance is not fully resolved and is explicitly reported as a limitation. Other engine/tool coverage gaps are included in findings.

Use the restricted **runtime credentials**, not the migration owner, to inspect effective access. Catalog visibility is required: unavailable metadata yields an incomplete result. PostgreSQL uses a read-only transaction; MySQL/MariaDB use read-only transactions; SQLite opens read-only. All engines execute metadata inspection only. Collectors can inspect broader catalogs, but findings are scoped to configured targets. No cross-tenant data or write probes run.

## Reports and lifecycle

Human output is the default; `--json` returns a versioned report with `scope`, stable finding codes, `complete`, `connected`, `outcome`, `limitations` and `exitCode`. `--fail-on warning` includes warnings in the failure threshold.

| Exit | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| 0    | No errors observed in the declared scope; warnings may remain                      |
| 1    | Observed findings meet the failure threshold                                       |
| 2    | Invalid arguments, configuration, environment references or unsupported runtime    |
| 3    | Inspection, metadata visibility, timeout, tool execution or cleanup was incomplete |

Invalid configuration takes precedence over incomplete inspection, which takes precedence over findings. No outcome certifies isolation, arbitrary policy semantics or production readiness. Offline doctor reports configuration observations only.

Owned database workers and published CLI jobs run in separate bounded processes. Connection values travel to native workers over IPC; published jobs receive only their explicit connection environment variable and an owner-only temporary config. They do not receive credential arguments or implicit driver credential variables. Native driver errors, raw upstream evidence and connection strings are excluded from reports. Temporary configs are removed after execution. SIGINT/SIGTERM stops owned jobs and exits 130/143 without emitting a successful report; deadlines kill diagnostic children and await process closure before releasing concurrency slots. Diagnostic jobs do not own application connections or run application callbacks.

The package also exports `diagnose`, `main`, `parseDiagnosticConfig` and report/config types without running the CLI on import. See [ecosystem integration](../../docs/ecosystem.md) for the published-tool reuse boundary.

## Initialize configuration

```sh
tenantguard init --engine postgres --output tenantguard.json
tenantguard init --engine mongodb --tenant-column tenantId --output mongo.json
```

Supported engines are the six in the coverage table. `--table` defaults to `orders`, `--tenant-column` to `tenant_id`, and optional `--schema` follows engine rules. The generated source alias is `main`. `--url-env` selects the environment reference (default `TG_DATABASE_URL`, or `TG_SQLITE_FILE` for SQLite). No credentials are requested, inferred, printed or written. Review the generated config and set its referenced secret before connected commands. Creation is exclusive with mode 0600: existing files, including symlinks, are never overwritten. There is no force option. A failed disk write is incomplete and can leave a partial new file for explicit operator cleanup.

## Generate native policies offline

```sh
tenantguard generate-policy --config tenantguard.json --source main
tenantguard generate-policy --config tenantguard.json --source main --output migration.sql
tenantguard generate-policy --config tenantguard.json --source main --json
```

Generation validates JSON configuration but does not resolve environment references or connect. It uses the exact supported PostgreSQL/SQL Server policy helpers. Select `--source` when multiple sources exist. Application-filter engines are rejected because these helpers cannot create native tenant RLS there. SQL goes to stdout by default; `--json` provides an `artifact` with an engine and ordered `batches`. SQL Server text uses `GO` batch separators: programmatic runners should execute JSON batches individually. Output files use the same exclusive creation as init.

Review generated SQL and run it separately with migration-owner credentials after creating the required UUID ownership column. Generation never applies SQL, grants privileges or drops existing objects. These migrations are not idempotent; existing policy/function names must be handled explicitly by your migration process. Multiple configured tables yield multiple ordered helper batches.

## Test supplied fixture read isolation

```sh
tenantguard test-isolation --config tenantguard.json --source main \
  --target public.orders \
  --tenant-a-env TG_TENANT_A --tenant-b-env TG_TENANT_B \
  --row-a-env TG_ROW_A --row-b-env TG_ROW_B --json
```

Provide two pre-existing fixture rows, each owned by its corresponding tenant. The command **does not create fixtures or execute writes**. Tenant/row values are resolved only from the explicit environment references and are excluded from reports and arguments. Use non-sensitive synthetic fixtures in staging/CI. Distinct tenant IDs and distinct string row IDs are required; values are bounded to 256 characters without surrounding whitespace, controls or invalid Unicode. Native-policy tenants must be canonical lowercase UUIDs. The target must exactly match one configured target label (`public.orders`, `dbo.orders`, `main.orders`, or the table/collection name for sources without a declared schema).

The command first performs native catalog checks for the selected target and then bounded reads across A/B/A scopes. Each scope checks its own anchor row and attempts to read the foreign anchor, projecting only ownership and ID fields with a two-row bound. PostgreSQL/SQL Server use direct sessions and the native helper context without adding an application tenant predicate; they also check that both anchors are hidden with no tenant context. PostgreSQL uses a read-only transaction; SQL Server rolls back its read transaction and destroys the owned session.

MySQL, MariaDB, MongoDB and SQLite execute the **actual bundled direct scoped adapters**, including their transaction/cleanup lifecycle. They test that adapter path, not arbitrary application queries, ORM adapters, membership authorization or framework handlers. SQLite transactions can acquire write locks despite performing only reads. Catalog/adapter activity can affect server logs, statistics and normal locking. Own fixture absence/invisibility yields exit 3; observed foreign/missing-context visibility yields exit 1. `ISOLATION.READ_BOUNDARY_OBSERVED` describes only the supplied read matrix. Existing catalog errors still affect the final exit status, and `--fail-on warning` also fails application-filter/path limitations.

No write, delete, missing-context application request, background job, arbitrary schema or whole-dataset guarantee is inferred. Fixture preparation, cleanup and authorization are application-owned. Keep the real integration suite for write/rollback conformance. See the [benchmark guide](../../benchmarks/README.md) for separate performance measurements.
