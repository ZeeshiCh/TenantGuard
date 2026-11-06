import pg, {
  type PoolConfig,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantRoute,
} from '@tenantguard/core';
import type { PgTenantClient } from '@tenantguard/postgres/pg';
import {
  assertActive,
  duration,
  keySnapshot,
  keyString,
  stateSnapshot,
  routeSnapshot,
  nextVersion,
  LifecycleBusyError,
  LifecycleClosedError,
  LifecycleConflictError,
  LifecycleTimeoutError,
  type LifecycleKey,
  type LifecycleSession,
  type LifecycleState,
  type LifecycleStore,
  type LifecycleTransaction,
} from './state.js';
const CONTROL_SEED = 918276,
  TRAFFIC_SEED = 918277;
export interface PgLifecycleExecution {
  /** One extended-protocol statement. Transaction boundaries belong to the store. */
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}
export interface PgLifecycleLocation {
  readonly schema?: string;
  readonly table?: string;
}
function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u.test(value))
    throw new TypeError('Invalid lifecycle SQL identifier');
  return '"' + value + '"';
}
function location(options: PgLifecycleLocation): string {
  return (
    identifier(options.schema ?? 'public') +
    '.' +
    identifier(options.table ?? 'tenantguard_lifecycle')
  );
}
/** Review/apply explicitly with a control-plane owner. Grant runtime SELECT separately. */
export function pgLifecycleSchemaSql(
  options: PgLifecycleLocation & { readonly managementRole?: string } = {},
): string {
  const table = location(options);
  const management = options.managementRole
    ? `\nCREATE POLICY tenantguard_lifecycle_manage ON ${table} FOR ALL TO ${identifier(options.managementRole)} USING(true) WITH CHECK(true);`
    : '';
  return `CREATE TABLE ${table} (tenant_id text NOT NULL, source text NOT NULL, version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991), state jsonb NOT NULL, PRIMARY KEY(tenant_id,source));
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenantguard_lifecycle_read ON ${table} FOR SELECT USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id',true),''));${management}`;
}
function decode(
  row: { version: string | number; state: LifecycleState } | undefined,
  key: LifecycleKey,
): Readonly<LifecycleState> | undefined {
  if (!row) return undefined;
  const value = stateSnapshot(row.state, key);
  if (value.version !== Number(row.version)) throw new LifecycleConflictError();
  return value;
}
export class PgLifecycleCommitError extends Error {
  readonly outcome = 'unknown';
  constructor(cause: unknown) {
    super(
      'Lifecycle COMMIT outcome is unknown; inspect persisted operation state before reconciliation',
      { cause },
    );
    this.name = 'PgLifecycleCommitError';
  }
}
/** Owned metadata pool. Management credentials require an explicit management RLS policy or BYPASSRLS. */
export function createPgLifecycleStore(
  options: PgLifecycleLocation & {
    readonly connection: PoolConfig;
    readonly maxConnections?: number;
    readonly statementTimeoutMs?: number;
    readonly shutdownTimeoutMs?: number;
  },
): LifecycleStore<PgLifecycleExecution> {
  const table = location(options),
    max = duration(options.maxConnections, 8),
    statementTimeout = duration(options.statementTimeoutMs, 5000),
    shutdownTimeout = duration(options.shutdownTimeoutMs, 30000);
  if (max < 2 || max > 1024)
    throw new RangeError(
      'Lifecycle PostgreSQL pool requires 2–1024 connections',
    );
  const pool = new pg.Pool({
    ...options.connection,
    max,
    connectionTimeoutMillis: Math.min(
      duration(options.connection.connectionTimeoutMillis, 5000),
      statementTimeout,
    ),
    statement_timeout: statementTimeout,
    query_timeout: undefined,
  });
  pool.on('error', () => {});
  let closed = false,
    active = 0,
    closing: Promise<void> | undefined;
  let ended = false,
    finishClose: (() => void) | undefined;
  const checkClose = () => {
    if (ended && active === 0) finishClose?.();
  };
  function session(
    key: LifecycleKey,
    live: () => boolean,
    track: <R extends QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ) => Promise<QueryResult<R>>,
  ): LifecycleSession {
    return Object.freeze({
      async read() {
        if (!live()) throw new LifecycleClosedError();
        return decode(
          (
            await track<{ version: string; state: LifecycleState }>(
              `SELECT version,state FROM ${table} WHERE tenant_id=$1 AND source=$2`,
              [key.tenantId, key.source],
            )
          ).rows[0],
          key,
        );
      },
      async compareAndSet(
        expected: number | undefined,
        next: Readonly<LifecycleState>,
      ) {
        if (!live()) throw new LifecycleClosedError();
        const value = stateSnapshot(next, key);
        if (value.version !== nextVersion(expected))
          throw new TypeError('Nonconsecutive lifecycle version');
        const result =
          expected === undefined
            ? await track(
                `INSERT INTO ${table}(tenant_id,source,version,state) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
                [
                  key.tenantId,
                  key.source,
                  value.version,
                  JSON.stringify(value),
                ],
              )
            : await track(
                `UPDATE ${table} SET version=$3,state=$4::jsonb WHERE tenant_id=$1 AND source=$2 AND version=$5`,
                [
                  key.tenantId,
                  key.source,
                  value.version,
                  JSON.stringify(value),
                  expected,
                ],
              );
        return result.rowCount === 1;
      },
    });
  }
  async function scope<T>(
    input: LifecycleKey,
    kind: 'read' | 'control' | 'exclusive',
    work: (
      transaction: LifecycleTransaction<PgLifecycleExecution>,
    ) => Promise<T>,
    beforeCommit?: () => void,
  ): Promise<T> {
    if (closed) throw new LifecycleClosedError();
    const key = keySnapshot(input);
    active++;
    let client: PoolClient | undefined,
      live = true,
      broken = false,
      failed = false,
      transaction = false;
    const pending = new Set<Promise<unknown>>();
    const onError = () => {
      broken = true;
    };
    try {
      client = await pool.connect();
      client.on('error', onError);
      if (closed) throw new LifecycleClosedError();
      const native = client;
      const track = <R extends QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<QueryResult<R>> => {
        if (!live || broken) return Promise.reject(new LifecycleClosedError());
        // queryMode is supported by pg; current @types/pg omits the property.
        const config = {
          text,
          values: [...values],
          queryMode: 'extended' as const,
        };
        const actual = native.query<R>(config);
        pending.add(actual);
        const result = actual.then(
          (value) => {
            pending.delete(actual);
            return value;
          },
          (error) => {
            pending.delete(actual);
            failed = true;
            throw error;
          },
        );
        void result.catch(() => {});
        return result;
      };
      if (kind === 'control') {
        const result = await track<{ locked: boolean }>(
          `SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1,${CONTROL_SEED})) AS locked`,
          [keyString(key)],
        );
        if (!result.rows[0]!.locked) throw new LifecycleBusyError();
      } else if (kind === 'exclusive') {
        await track('BEGIN');
        transaction = true;
        await track(
          `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,${TRAFFIC_SEED}))`,
          [keyString(key)],
        );
      }
      const recordSession = session(key, () => live && !broken, track);
      const xid =
        kind === 'exclusive'
          ? String(
              (
                await track<{ xid: string }>(
                  'SELECT pg_catalog.txid_current()::text AS xid',
                )
              ).rows[0]!.xid,
            )
          : undefined;
      const result = await work(
        Object.freeze({
          ...recordSession,
          async runPhase<R>(
            callback: (executor: PgLifecycleExecution) => Promise<R>,
          ): Promise<R> {
            let phaseLive = true;
            const executor: Object & PgLifecycleExecution = Object.freeze({
              query<R extends QueryResultRow = QueryResultRow>(
                text: string,
                values: readonly unknown[] = [],
              ): Promise<QueryResult<R>> {
                if (!phaseLive || !live || broken)
                  return Promise.reject(new LifecycleClosedError());
                if (
                  typeof text !== 'string' ||
                  !/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|TRUNCATE)\b/i.test(
                    text,
                  )
                ) {
                  failed = true;
                  return Promise.reject(
                    new TypeError(
                      'Lifecycle execution requires one non-transaction-control SQL statement',
                    ),
                  );
                }
                return track<R>(text, values);
              },
            });
            try {
              const value = await callback(executor);
              phaseLive = false;
              if (pending.size || failed || broken)
                throw new Error(
                  'Lifecycle phase left failed or unawaited native queries',
                );
              return value;
            } finally {
              phaseLive = false;
            }
          },
        }),
      );
      if (pending.size || failed || broken)
        throw new Error('Lifecycle scope left failed or unawaited queries');
      if (kind === 'exclusive') {
        const current = String(
          (
            await track<{ xid: string }>(
              'SELECT pg_catalog.txid_current()::text AS xid',
            )
          ).rows[0]!.xid,
        );
        if (current !== xid)
          throw new Error('Lifecycle transaction boundary changed');
        beforeCommit?.();
        try {
          await track('COMMIT');
          transaction = false;
        } catch (error) {
          throw new PgLifecycleCommitError(error);
        }
      }
      return result;
    } catch (error) {
      live = false;
      await Promise.allSettled([...pending]);
      if (client && transaction && !broken)
        try {
          await client.query('ROLLBACK');
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            'Lifecycle transaction and rollback failed',
          );
        }
      throw error;
    } finally {
      live = false;
      if (client) {
        client.removeListener('error', onError);
        client.release(true);
      }
      active--;
      checkClose();
    }
  }
  return Object.freeze({
    async read(input: LifecycleKey) {
      return scope(input, 'read', async (transaction) => transaction.read());
    },
    withControlLock: <T>(
      key: LifecycleKey,
      work: (session: LifecycleSession) => Promise<T>,
    ) => scope(key, 'control', work),
    withExclusiveLock: <T>(
      key: LifecycleKey,
      work: (
        transaction: LifecycleTransaction<PgLifecycleExecution>,
      ) => Promise<T>,
      beforeCommit?: () => void,
    ) => scope(key, 'exclusive', work, beforeCommit),
    close() {
      if (closing) return closing;
      closed = true;
      const actual = pool.end();
      closing = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new LifecycleTimeoutError('shutdown')),
          shutdownTimeout,
        );
        void actual.then(
          () => {
            ended = true;
            finishClose = () => {
              clearTimeout(timer);
              resolve();
            };
            checkClose();
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      void closing.catch(() => {});
      return closing;
    },
    stats: () => Object.freeze({ closed, operations: active }),
  });
}
/** Requires a genuine PgTenantClient transaction in the same database as the metadata table. */
export function createPgLifecycleAdapter(
  options: PgLifecycleLocation & {
    readonly adapter: DatabaseAdapter<PgTenantClient>;
  },
): DatabaseAdapter<PgTenantClient> {
  const adapter = options.adapter,
    table = location(options);
  if (adapter.name !== 'pg' || !adapter.capabilities.transactions)
    throw new TypeError(
      'Lifecycle admission requires the native transactional pg adapter',
    );
  return Object.freeze({
    name: adapter.name,
    capabilities: adapter.capabilities,
    async run<T>(
      context: Parameters<DatabaseAdapter<PgTenantClient>['run']>[0],
      route: Readonly<TenantRoute>,
      work: (client: PgTenantClient) => Promise<T>,
    ): Promise<T> {
      const trusted = createTenantContext(context),
        routing = routeSnapshot(route),
        key = keySnapshot(routing);
      if (trusted.tenantId !== key.tenantId) throw new LifecycleConflictError();
      return adapter.run(trusted, routing, async (client) => {
        const lock = await client.query<{ locked: boolean; xid: string }>(
          `SELECT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended($1,${TRAFFIC_SEED})) AS locked, pg_catalog.txid_current()::text AS xid`,
          [keyString(key)],
        );
        if (!lock.rows[0]!.locked) throw new LifecycleBusyError();
        const state = decode(
          (
            await client.query<{ version: string; state: LifecycleState }>(
              `SELECT version,state FROM ${table} WHERE tenant_id=$1 AND source=$2`,
              [key.tenantId, key.source],
            )
          ).rows[0],
          key,
        );
        const xid = String(
          (
            await client.query<{ xid: string }>(
              'SELECT pg_catalog.txid_current()::text AS xid',
            )
          ).rows[0]!.xid,
        );
        if (xid !== lock.rows[0]!.xid) throw new LifecycleConflictError();
        assertActive(state, routing);
        return work(client);
      });
    },
  });
}
