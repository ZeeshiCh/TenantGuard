import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantContext,
  type TenantRoute,
} from '@tenantguard/core';
import { quoteIdentifier, validatePostgresTenantId } from './index.js';

export interface PgTenantClient {
  /** Single SELECT/INSERT/UPDATE/DELETE/WITH/VALUES statement. No transaction control,
   * session commands, named prepared statements, cursors or access to release().
   */
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}
export interface PgProtectedTable {
  readonly schema: string;
  readonly table: string;
  readonly tenantColumn?: string;
}
export interface PgAdapterOptions {
  /** Dedicated pools only. Resolve allowlisted route references, never request URLs. */
  resolvePool(route: Readonly<TenantRoute>): Pool | Promise<Pool>;
  readonly tables: readonly PgProtectedTable[];
  readonly acquireTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
}
export type PgCommitOutcome = 'not-committed' | 'committed' | 'unknown';
export class PgSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgSafetyError';
  }
}
export class PgTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly commitOutcome: PgCommitOutcome = 'not-committed',
  ) {
    super(`PostgreSQL ${phase} timed out`);
    this.name = 'PgTimeoutError';
  }
}
export class PgCleanupError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly commitOutcome: PgCommitOutcome,
  ) {
    super(errors, 'PostgreSQL connection cleanup failed; connection destroyed');
    this.name = 'PgCleanupError';
  }
}
export class PgCommitError extends Error {
  readonly commitOutcome = 'unknown';
  constructor(cause: unknown) {
    super('PostgreSQL commit outcome is unknown; do not retry blindly', {
      cause,
    });
    this.name = 'PgCommitError';
  }
}
const scopes = new AsyncLocalStorage<true>();
const ROLE_SQL = `SELECT current_user = session_user AS identity_ok,
 NULLIF(pg_catalog.current_setting('app.tenant_id', true), '') AS tenant,
 EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE
 (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
 AND pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')) AS privileged`;
const SESSION_SQL = `SELECT current_user = session_user AS identity_ok,
 NULLIF(pg_catalog.current_setting('app.tenant_id', true), '') AS tenant`;
const TABLE_SQL = `SELECT c.relkind, c.relrowsecurity, c.relforcerowsecurity,
 pg_catalog.pg_has_role(session_user, c.relowner, 'MEMBER') AS owns_table,
 pg_catalog.has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
 pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE') AS can_create,
 EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid
 AND a.attname=$3 AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
 AND a.atttypid='pg_catalog.uuid'::pg_catalog.regtype) AS tenant_column,
 EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid
 AND NOT p.polpermissive AND p.polcmd='*' AND 0=ANY(p.polroles)) AS restrictive_policy
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND c.relname=$2`;
function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2147483647)
    throw new TypeError(
      'Timeouts must be positive 32-bit integer milliseconds',
    );
  return result;
}
function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  error: () => Error,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(error());
    }, milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (expired) {
          late?.(value);
        } else resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        if (!expired) reject(reason);
      },
    );
  });
}
function assertSession(row: QueryResultRow | undefined) {
  if (!row || row.identity_ok !== true || row.tenant !== null)
    throw new PgSafetyError(
      'Connection has a changed role or session-level tenant context',
    );
}
/** Direct Node pg adapter. Uses a pinned client for the entire transaction and
 * checks only declared tables; it is not an SQL sandbox or policy-expression auditor.
 */
export function createPgAdapter(
  options: PgAdapterOptions,
): DatabaseAdapter<PgTenantClient> {
  if (!options.tables.length)
    throw new TypeError('Declare at least one protected table');
  const tables = options.tables.map((table) => {
    quoteIdentifier(table.schema);
    quoteIdentifier(table.table);
    quoteIdentifier(table.tenantColumn ?? 'tenant_id');
    return Object.freeze({
      schema: table.schema,
      table: table.table,
      tenantColumn: table.tenantColumn ?? 'tenant_id',
    });
  });
  const searchPath = [
    'pg_catalog',
    ...new Set(tables.map((table) => table.schema)),
    'pg_temp',
  ]
    .map(quoteIdentifier)
    .join(', ');
  const resolvePool = options.resolvePool;
  const acquireMs = duration(options.acquireTimeoutMs, 5000),
    operationMs = duration(options.operationTimeoutMs, 30000),
    cleanupMs = duration(options.cleanupTimeoutMs, 2000);
  const statementMs = duration(options.statementTimeoutMs, 15000),
    lockMs = duration(options.lockTimeoutMs, 5000);
  return Object.freeze({
    name: 'pg',
    capabilities: Object.freeze({
      isolationModes: Object.freeze(['database-policy'] as const),
      transactions: true,
    }),
    async run<T>(
      context: Readonly<TenantContext>,
      route: Readonly<TenantRoute>,
      work: (client: PgTenantClient) => Promise<T>,
    ): Promise<T> {
      const snapshot = createTenantContext(context);
      validatePostgresTenantId(snapshot.tenantId);
      if (
        route.tenantId !== snapshot.tenantId ||
        route.mode !== 'database-policy' ||
        route.status !== 'active' ||
        route.adapter !== 'pg' ||
        typeof route.source !== 'string' ||
        !route.source ||
        typeof route.resource !== 'string' ||
        !route.resource ||
        typeof route.revision !== 'string' ||
        !route.revision ||
        (route.secretRef !== undefined &&
          (typeof route.secretRef !== 'string' || !route.secretRef))
      )
        throw new PgSafetyError('Invalid PostgreSQL tenant route');
      if (scopes.getStore())
        throw new PgSafetyError(
          'Nested or detached pg transactions are unsupported; reuse the scoped client',
        );
      const routing = Object.freeze({ ...route });
      return scopes.run(true, async () => {
        const pool = await bounded(
          Promise.resolve().then(() => resolvePool(routing)),
          acquireMs,
          () => new PgTimeoutError('pool resolution'),
        );
        const client = await bounded(
          pool.connect(),
          acquireMs,
          () => new PgTimeoutError('acquisition'),
          (late) => late.release(true),
        );
        let closed = false;
        let accepting = false,
          broken = false,
          failed = false,
          queryFailed = false;
        let failure: unknown, queryFailure: unknown;
        const state: { outcome: PgCommitOutcome } = {
          outcome: 'not-committed',
        };
        let rejectConnection: (error: unknown) => void = () => {};
        const connectionFailure = new Promise<never>((_resolve, reject) => {
          rejectConnection = reject;
        });
        const onError = (error: Error) => {
          broken = true;
          accepting = false;
          rejectConnection(error);
        };
        client.on('error', onError);
        const pending = new Set<Promise<unknown>>();
        const scoped: PgTenantClient = Object.freeze({
          query<Row extends QueryResultRow = QueryResultRow>(
            text: string,
            values: readonly unknown[] = [],
          ): Promise<QueryResult<Row>> {
            if (!accepting || closed)
              return Promise.reject(
                new PgSafetyError(
                  'Tenant client is outside its active callback',
                ),
              );
            if (
              typeof text !== 'string' ||
              !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|VALUES)\b/i.test(text) ||
              !Array.isArray(values)
            ) {
              queryFailed = true;
              queryFailure = new PgSafetyError(
                'Only single data statements are supported',
              );
              return Promise.reject(queryFailure);
            }
            // Extended protocol rejects multi-statement SQL. Unnamed queries avoid prepared-cache reset hazards.
            const config: QueryConfig<unknown[]> & { queryMode: 'extended' } = {
              text,
              values: [...values],
              queryMode: 'extended',
            };
            const promise = client.query<Row>(config);
            pending.add(promise);
            void promise.then(
              () => {
                pending.delete(promise);
              },
              (error) => {
                pending.delete(promise);
                queryFailed = true;
                queryFailure = error;
              },
            );
            return promise;
          },
        });
        const execute = async (text: string, values?: unknown[]) => {
          if (closed) throw new PgSafetyError('Transaction scope is closed');
          const result = await client.query(text, values);
          if (closed) throw new PgSafetyError('Transaction scope is closed');
          return result;
        };
        let result: T | undefined;
        try {
          const operation = (async () => {
            // Dedicated pools: discard any unfinished transaction before inspecting the session.
            await execute('ROLLBACK');
            const role = (await execute(ROLE_SQL)).rows[0];
            assertSession(role);
            if (role!.privileged !== false)
              throw new PgSafetyError(
                'Runtime role or a reachable role has administrative/RLS bypass privileges',
              );
            for (const table of tables) {
              const row = (
                await execute(TABLE_SQL, [
                  table.schema,
                  table.table,
                  table.tenantColumn,
                ])
              ).rows[0];
              if (
                !row ||
                row.relkind !== 'r' ||
                !row.relrowsecurity ||
                !row.relforcerowsecurity ||
                row.owns_table ||
                row.can_truncate ||
                row.can_create ||
                !row.tenant_column ||
                !row.restrictive_policy
              )
                throw new PgSafetyError(
                  'Declared table lacks required RLS/UUID restrictions or runtime privileges are unsafe',
                );
            }
            await execute('BEGIN');
            await execute(
              `SELECT pg_catalog.set_config('app.tenant_id',$1,true),
 pg_catalog.set_config('statement_timeout',$2,true), pg_catalog.set_config('lock_timeout',$3,true),
 pg_catalog.set_config('idle_in_transaction_session_timeout',$4,true),
 pg_catalog.set_config('row_security','on',true), pg_catalog.set_config('search_path',$5,true)`,
              [
                snapshot.tenantId,
                `${statementMs}ms`,
                `${lockMs}ms`,
                `${operationMs}ms`,
                searchPath,
              ],
            );
            accepting = true;
            let value: T;
            try {
              value = await work(scoped);
            } finally {
              accepting = false;
            }
            if (pending.size) {
              await Promise.allSettled([...pending]);
              throw new PgSafetyError(
                'Callback returned with unawaited queries',
              );
            }
            if (queryFailed) throw queryFailure;
            if (closed || broken)
              throw new PgSafetyError('Connection failed during callback');
            state.outcome = 'unknown';
            const commit = await execute('COMMIT');
            if (commit.command !== 'COMMIT') {
              state.outcome = 'not-committed';
              throw new PgSafetyError('Transaction did not commit');
            }
            state.outcome = 'committed';
            return value;
          })();
          result = await bounded(
            Promise.race([operation, connectionFailure]),
            operationMs,
            () => new PgTimeoutError('operation', state.outcome),
          );
        } catch (error) {
          failed = true;
          failure = error;
        }
        accepting = false;
        closed = true;
        let destroy =
          state.outcome === 'unknown' ||
          broken ||
          failure instanceof PgTimeoutError ||
          failure instanceof PgSafetyError;
        if (!destroy) {
          try {
            for (const sql of [
              'ROLLBACK',
              SESSION_SQL,
              'RESET ROLE',
              'RESET ALL',
              'SELECT pg_catalog.pg_advisory_unlock_all()',
              SESSION_SQL,
            ]) {
              const cleanup = await bounded(
                client.query(sql),
                cleanupMs,
                () => new PgTimeoutError('cleanup', state.outcome),
              );
              if (sql === SESSION_SQL) assertSession(cleanup.rows[0]);
            }
          } catch (cleanup) {
            destroy = true;
            failure = new PgCleanupError(
              failed ? [failure, cleanup] : [cleanup],
              state.outcome,
            );
            failed = true;
          }
        }
        // The pool owns idle error handling once release returns. Never leak an acquired client.
        client.removeListener('error', onError);
        client.release(destroy);
        if (failed) {
          if (
            state.outcome === 'unknown' &&
            !(failure instanceof PgTimeoutError) &&
            !(failure instanceof PgCleanupError)
          )
            throw new PgCommitError(failure);
          throw failure;
        }
        return result as T;
      });
    },
  });
}
