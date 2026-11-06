import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantContext,
  type TenantRoute,
} from '@tenantguard/core';
import {
  quoteSqlServerIdentifier,
  sqlServerPolicyNames,
  validateSqlServerTenantId,
  type SqlServerProtectedTable,
} from './policy.js';
import {
  positiveMilliseconds,
  type SqlServerResult,
  type SqlServerSessionPool,
  type SqlServerValue,
} from './transport.js';
export type SqlServerCommitOutcome = 'not-committed' | 'committed' | 'unknown';
export class SqlServerSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlServerSafetyError';
  }
}
export class SqlServerTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly commitOutcome: SqlServerCommitOutcome = 'not-committed',
  ) {
    super(`SQL Server ${phase} timed out`);
    this.name = 'SqlServerTimeoutError';
  }
}
export class SqlServerCleanupError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly commitOutcome: SqlServerCommitOutcome,
  ) {
    super(errors, 'SQL Server session cleanup failed; connection destroyed');
    this.name = 'SqlServerCleanupError';
  }
}
export class SqlServerCommitError extends Error {
  readonly commitOutcome = 'unknown';
  constructor(cause: unknown) {
    super('SQL Server commit outcome is unknown; do not retry blindly', {
      cause,
    });
    this.name = 'SqlServerCommitError';
  }
}
export interface SqlServerTenantClient {
  /** Trusted data batches; parameter names omit @. No transaction/session management. */
  query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters?: Readonly<Record<string, SqlServerValue>>,
  ): Promise<SqlServerResult<Row>>;
}
export interface SqlServerAdapterOptions {
  resolvePool(
    route: Readonly<TenantRoute>,
  ): SqlServerSessionPool | Promise<SqlServerSessionPool>;
  readonly tables: readonly SqlServerProtectedTable[];
  readonly acquireTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
}
const scopes = new AsyncLocalStorage<true>();
const SESSION_SQL = `SELECT DB_NAME() AS database_name, USER_NAME() AS user_name,
 ORIGINAL_LOGIN() AS login_name, SUSER_SNAME() AS effective_login,
 CONVERT(nvarchar(256),SESSION_CONTEXT(N'app.tenant_id')) AS tenant,
 @@TRANCOUNT AS transaction_count, CASE WHEN @@TRANCOUNT=0 THEN 0 ELSE XACT_STATE() END AS transaction_state, @@LOCK_TIMEOUT AS lock_timeout, CASE WHEN (@@OPTIONS & 16384)=16384 THEN 1 ELSE 0 END AS xact_abort`;
const permissions = [
  "IS_SRVROLEMEMBER(N'sysadmin')",
  "IS_MEMBER(N'db_owner')",
  "IS_MEMBER(N'db_securityadmin')",
  "IS_MEMBER(N'db_ddladmin')",
  "HAS_PERMS_BY_NAME(NULL,NULL,N'CONTROL SERVER')",
  "HAS_PERMS_BY_NAME(NULL,NULL,N'ALTER ANY LOGIN')",
  "HAS_PERMS_BY_NAME(NULL,NULL,N'IMPERSONATE ANY LOGIN')",
  ...[
    'CONTROL',
    'ALTER ANY SECURITY POLICY',
    'ALTER ANY ROLE',
    'ALTER ANY USER',
    'ALTER ANY SCHEMA',
    'CREATE SCHEMA',
    'CREATE FUNCTION',
  ].map(
    (permission) => `HAS_PERMS_BY_NAME(DB_NAME(),N'DATABASE',N'${permission}')`,
  ),
  `CONVERT(int,CASE WHEN EXISTS (SELECT 1 FROM sys.database_permissions p JOIN sys.user_token t ON t.principal_id=p.grantee_principal_id WHERE p.class=4 AND p.permission_name IN (N'IMPERSONATE',N'CONTROL') AND p.state IN ('G','W')) THEN 1 ELSE 0 END)`,
  `CONVERT(int,CASE WHEN EXISTS (SELECT 1 FROM sys.server_permissions p JOIN sys.login_token t ON t.principal_id=p.grantee_principal_id WHERE p.class=101 AND p.permission_name IN (N'IMPERSONATE',N'CONTROL') AND p.state IN ('G','W')) THEN 1 ELSE 0 END)`,
];
const ROLE_SQL = `SELECT ${permissions.map((permission, index) => `${permission} AS privilege_${index}`).join(', ')}`;
const TABLE_SQL = `SELECT t.object_id,c.system_type_id,c.is_nullable,p.is_enabled,p.is_schema_bound,
 (SELECT TOP(1) f.predicate_definition FROM sys.security_predicates f WHERE f.object_id=p.object_id AND f.target_object_id=t.object_id) AS observed_binding,
 HAS_PERMS_BY_NAME(QUOTENAME(@schema)+N'.'+QUOTENAME(@table),N'OBJECT',N'ALTER') AS table_alter,
 HAS_PERMS_BY_NAME(QUOTENAME(@schema),N'SCHEMA',N'ALTER') AS schema_alter,
 HAS_PERMS_BY_NAME(QUOTENAME(@securitySchema),N'SCHEMA',N'ALTER') AS security_alter,
 HAS_PERMS_BY_NAME(QUOTENAME(@securitySchema)+N'.'+QUOTENAME(@predicate),N'OBJECT',N'ALTER') AS predicate_alter,
 (SELECT COUNT(*) FROM sys.security_predicates f WHERE f.object_id=p.object_id AND f.target_object_id=t.object_id AND (f.predicate_definition=@definition OR f.predicate_definition=N'('+@definition+N')') AND f.predicate_type=0 AND f.operation IS NULL) AS filters,
 (SELECT COUNT(*) FROM sys.security_predicates f WHERE f.object_id=p.object_id AND f.target_object_id=t.object_id AND (f.predicate_definition=@definition OR f.predicate_definition=N'('+@definition+N')') AND f.predicate_type=1 AND f.operation=1) AS insert_blocks,
 (SELECT COUNT(*) FROM sys.security_predicates f WHERE f.object_id=p.object_id AND f.target_object_id=t.object_id AND (f.predicate_definition=@definition OR f.predicate_definition=N'('+@definition+N')') AND f.predicate_type=1 AND f.operation=2) AS update_blocks
 FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
 JOIN sys.columns c ON c.object_id=t.object_id AND c.name=@column
 LEFT JOIN sys.security_policies p ON p.name=@policy AND SCHEMA_NAME(p.schema_id)=@securitySchema
 WHERE s.name=@schema AND t.name=@table`;
function bounded<T>(
  promise: Promise<T>,
  ms: number,
  error: () => Error,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(error());
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (expired) late?.(value);
        else resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        if (!expired) reject(reason);
      },
    );
  });
}
type StateRow = {
  database_name: string;
  user_name: string;
  login_name: string;
  effective_login: string;
  tenant: string | null;
  transaction_count: number;
  transaction_state: number;
  lock_timeout: number;
  xact_abort: number;
};
function sessionRow(result: SqlServerResult): StateRow {
  const row = result.rows[0] as StateRow | undefined;
  if (
    !row ||
    !row.database_name ||
    !row.user_name ||
    !row.login_name ||
    row.effective_login !== row.login_name
  )
    throw new SqlServerSafetyError('SQL Server session identity changed');
  return row;
}
export function createSqlServerAdapter(
  options: SqlServerAdapterOptions,
): DatabaseAdapter<SqlServerTenantClient> {
  if (!options.tables.length)
    throw new TypeError('Declare at least one protected table');
  const tables = options.tables.map(sqlServerPolicyNames),
    resolvePool = options.resolvePool;
  const acquireMs = positiveMilliseconds(options.acquireTimeoutMs, 5000),
    operationMs = positiveMilliseconds(options.operationTimeoutMs, 30000),
    cleanupMs = positiveMilliseconds(options.cleanupTimeoutMs, 2000),
    requestMs = positiveMilliseconds(options.requestTimeoutMs, 15000),
    lockMs = positiveMilliseconds(options.lockTimeoutMs, 5000);
  return Object.freeze({
    name: 'sqlserver',
    capabilities: Object.freeze({
      isolationModes: Object.freeze(['database-policy'] as const),
      transactions: true,
    }),
    async run<T>(
      context: Readonly<TenantContext>,
      route: Readonly<TenantRoute>,
      work: (client: SqlServerTenantClient) => Promise<T>,
    ): Promise<T> {
      const snapshot = createTenantContext(context);
      validateSqlServerTenantId(snapshot.tenantId);
      if (
        route.adapter !== 'sqlserver' ||
        route.tenantId !== snapshot.tenantId ||
        route.status !== 'active' ||
        route.mode !== 'database-policy' ||
        ![route.source, route.resource, route.revision].every(
          (value) => typeof value === 'string' && value.length > 0,
        ) ||
        (route.secretRef !== undefined &&
          (typeof route.secretRef !== 'string' || !route.secretRef))
      )
        throw new SqlServerSafetyError('Invalid SQL Server tenant route');
      if (scopes.getStore())
        throw new SqlServerSafetyError(
          'Nested or detached SQL Server scopes are unsupported; reuse the client',
        );
      const routing = Object.freeze({ ...route });
      return scopes.run(true, async () => {
        const pool = await bounded(
          Promise.resolve().then(() => resolvePool(routing)),
          acquireMs,
          () => new SqlServerTimeoutError('pool resolution'),
        );
        const session = await bounded(
          pool.acquire(),
          acquireMs,
          () => new SqlServerTimeoutError('acquisition'),
          (late) => late.release(true),
        );
        const state: { outcome: SqlServerCommitOutcome } = {
          outcome: 'not-committed',
        };
        let accepting = false,
          closed = false,
          broken = false,
          failed = false,
          queryFailed = false,
          failure: unknown,
          queryFailure: unknown;
        let rejectConnection: (error: unknown) => void = () => {};
        const connectionFailure = new Promise<never>((_resolve, reject) => {
          rejectConnection = reject;
        });
        let detach: () => void;
        try {
          detach = session.onError((error) => {
            broken = true;
            accepting = false;
            rejectConnection(error);
          });
        } catch (error) {
          session.release(true);
          throw error;
        }
        const execute = async (
          text: string,
          parameters?: Readonly<Record<string, SqlServerValue>>,
          batch = false,
        ) => {
          if (closed || broken)
            throw new SqlServerSafetyError('SQL Server scope is closed');
          const result = batch
            ? await session.batch(text, requestMs)
            : await session.query(text, parameters, requestMs);
          if (closed || broken)
            throw new SqlServerSafetyError('SQL Server scope is closed');
          return result;
        };
        let baseline: StateRow | undefined;
        const assertScope = async () => {
          const row = sessionRow(await execute(SESSION_SQL));
          if (
            row.database_name !== baseline?.database_name ||
            row.user_name !== baseline.user_name ||
            row.login_name !== baseline.login_name ||
            row.tenant !== snapshot.tenantId ||
            row.transaction_count !== 1 ||
            row.transaction_state !== 1 ||
            row.lock_timeout !== lockMs ||
            row.xact_abort !== 1
          ) {
            if (row.transaction_count === 0) state.outcome = 'unknown';
            throw new SqlServerSafetyError(
              'SQL Server transaction, tenant or identity changed during data access',
            );
          }
        };
        let queue: Promise<unknown> = Promise.resolve();
        const pending = new Set<Promise<unknown>>();
        const client: SqlServerTenantClient = Object.freeze({
          query<Row extends object = Record<string, unknown>>(
            text: string,
            parameters: Readonly<Record<string, SqlServerValue>> = {},
          ): Promise<SqlServerResult<Row>> {
            if (!accepting || closed)
              return Promise.reject(
                new SqlServerSafetyError(
                  'SQL Server client is outside its active callback',
                ),
              );
            if (
              typeof text !== 'string' ||
              !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(text)
            ) {
              queryFailed = true;
              queryFailure = new SqlServerSafetyError(
                'Only trusted SQL Server data batches are supported',
              );
              return Promise.reject(queryFailure);
            }
            const values = { ...parameters };
            const promise = queue.then(async () => {
              if (!accepting || closed || broken || queryFailed)
                throw new SqlServerSafetyError(
                  'SQL Server query scope is no longer usable',
                );
              try {
                const result = await execute(text, values);
                await assertScope();
                return result as SqlServerResult<Row>;
              } catch (error) {
                queryFailed = true;
                queryFailure = error;
                throw error;
              }
            });
            queue = promise.then(
              () => {},
              () => {},
            );
            pending.add(promise);
            void promise.then(
              () => pending.delete(promise),
              () => pending.delete(promise),
            );
            return promise;
          },
        });
        let result: T | undefined;
        try {
          const operation = (async () => {
            await execute('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION');
            baseline = sessionRow(await execute(SESSION_SQL));
            const roleResult = await execute(ROLE_SQL);
            if (
              baseline.tenant !== null ||
              baseline.transaction_count !== 0 ||
              baseline.transaction_state !== 0 ||
              permissions.some(
                (_value, index) =>
                  roleResult.rows[0]![`privilege_${index}`] !== 0,
              )
            )
              throw new SqlServerSafetyError(
                `SQL Server runtime identity, session or privileges are unsafe (${permissions
                  .map(
                    (_permission, index) =>
                      [
                        index,
                        roleResult.rows[0]![`privilege_${index}`],
                      ] as const,
                  )
                  .filter(([_index, value]) => value !== 0)
                  .map(([index, value]) => `permission ${index}: ${value}`)
                  .join(
                    ', ',
                  )}; transaction ${baseline.transaction_count}/${baseline.transaction_state}; tenant ${baseline.tenant === null ? 'empty' : 'present'})`,
              );
            for (const table of tables) {
              const definition = `${quoteSqlServerIdentifier(table.securitySchema)}.${quoteSqlServerIdentifier(table.predicateName)}(${quoteSqlServerIdentifier(table.tenantColumn)})`;
              const row = (
                await execute(TABLE_SQL, {
                  schema: table.schema,
                  table: table.table,
                  column: table.tenantColumn,
                  securitySchema: table.securitySchema,
                  predicate: table.predicateName,
                  policy: table.policyName,
                  definition,
                })
              ).rows[0];
              if (
                !row ||
                row.system_type_id !== 36 ||
                row.is_nullable !== false ||
                row.is_enabled !== true ||
                row.is_schema_bound !== true ||
                [
                  'table_alter',
                  'schema_alter',
                  'security_alter',
                  'predicate_alter',
                ].some((key) => row[key] !== 0) ||
                ['filters', 'insert_blocks', 'update_blocks'].some(
                  (key) => row[key] !== 1,
                )
              )
                throw new SqlServerSafetyError(
                  `SQL Server declared table lacks required native RLS or has unsafe privileges (${JSON.stringify(row)})`,
                );
            }
            await session.begin();
            if (closed || broken)
              throw new SqlServerSafetyError('SQL Server scope is closed');
            await execute(
              `SET XACT_ABORT ON; SET LOCK_TIMEOUT ${lockMs}`,
              undefined,
              true,
            );
            await execute(
              `DECLARE @tenantValue nvarchar(36)=@tenant; EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=@tenantValue,@read_only=0;`,
              { tenant: snapshot.tenantId },
            );
            await assertScope();
            accepting = true;
            let value: T;
            try {
              value = await work(client);
            } finally {
              accepting = false;
            }
            if (pending.size) {
              await Promise.allSettled([...pending]);
              throw new SqlServerSafetyError(
                'Callback returned with unawaited SQL Server queries',
              );
            }
            if (queryFailed) throw queryFailure;
            await assertScope();
            state.outcome = 'unknown';
            await session.commit();
            state.outcome = 'committed';
            return value;
          })();
          result = await bounded(
            Promise.race([operation, connectionFailure]),
            operationMs,
            () => new SqlServerTimeoutError('operation', state.outcome),
          );
        } catch (error) {
          failed = true;
          failure = error;
        }
        accepting = false;
        closed = true;
        let destroy =
          broken ||
          state.outcome === 'unknown' ||
          failure instanceof SqlServerTimeoutError ||
          failure instanceof SqlServerSafetyError;
        if (!destroy) {
          try {
            await bounded(
              session.batch(
                "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION; EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=NULL; SET LOCK_TIMEOUT -1; SET XACT_ABORT OFF;",
                cleanupMs,
              ),
              cleanupMs,
              () => new SqlServerTimeoutError('cleanup', state.outcome),
            );
            let clean = sessionRow(
              await bounded(
                session.query(SESSION_SQL, {}, cleanupMs),
                cleanupMs,
                () =>
                  new SqlServerTimeoutError(
                    'cleanup verification',
                    state.outcome,
                  ),
              ),
            );
            if (
              clean.tenant !== null ||
              clean.transaction_count !== 0 ||
              clean.transaction_state !== 0 ||
              clean.user_name !== baseline?.user_name ||
              clean.database_name !== baseline.database_name
            )
              throw new SqlServerSafetyError(
                'SQL Server cleanup left tenant or transaction state',
              );
            await bounded(
              session.reset(),
              cleanupMs,
              () => new SqlServerTimeoutError('reset', state.outcome),
            );
            clean = sessionRow(
              await bounded(
                session.query(SESSION_SQL, {}, cleanupMs),
                cleanupMs,
                () =>
                  new SqlServerTimeoutError(
                    'reset verification',
                    state.outcome,
                  ),
              ),
            );
            if (
              clean.tenant !== null ||
              clean.transaction_count !== 0 ||
              clean.transaction_state !== 0 ||
              clean.user_name !== baseline?.user_name ||
              clean.database_name !== baseline.database_name
            )
              throw new SqlServerSafetyError(
                'SQL Server reset left tenant or transaction state',
              );
          } catch (cleanup) {
            destroy = true;
            failure = new SqlServerCleanupError(
              failed ? [failure, cleanup] : [cleanup],
              state.outcome,
            );
            failed = true;
          }
        }
        detach();
        session.release(destroy);
        if (failed) {
          if (
            state.outcome === 'unknown' &&
            !(failure instanceof SqlServerTimeoutError) &&
            !(failure instanceof SqlServerCleanupError)
          )
            throw new SqlServerCommitError(failure);
          throw failure;
        }
        return result as T;
      });
    },
  });
}
