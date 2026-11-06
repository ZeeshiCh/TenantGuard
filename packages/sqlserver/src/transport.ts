import {
  Connection,
  Request,
  TYPES,
  type ConnectionConfiguration,
} from 'tedious';
import { Pool } from 'tarn';
export type SqlServerValue =
  string | number | boolean | bigint | Date | Uint8Array | null;
export interface SqlServerResult<Row extends object = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}
export interface SqlServerSession {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters?: Readonly<Record<string, SqlServerValue>>,
    timeoutMs?: number,
  ): Promise<SqlServerResult<Row>>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  reset(): Promise<void>;
  release(destroy?: boolean): void;
  onError(listener: (error: Error) => void): () => void;
}
export interface SqlServerSessionPool {
  acquire(): Promise<SqlServerSession>;
}
export interface SqlServerPoolOptions {
  readonly connection: ConnectionConfiguration;
  readonly max?: number;
  readonly acquireTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}
export function positiveMilliseconds(
  value: number | undefined,
  fallback: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2147483647)
    throw new TypeError(
      'Timeouts must be positive 32-bit integer milliseconds',
    );
  return result;
}
function parameter(request: Request, name: string, value: SqlServerValue) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name.length > 128)
    throw new TypeError('Invalid SQL Server parameter name');
  if (value === null || typeof value === 'string')
    request.addParameter(name, TYPES.NVarChar, value, {
      length:
        value === null
          ? 1
          : value.length > 4000
            ? Infinity
            : Math.max(1, value.length),
    });
  else if (typeof value === 'boolean')
    request.addParameter(name, TYPES.Bit, value);
  else if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    request.addParameter(
      name,
      Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
        ? TYPES.Int
        : TYPES.Float,
      value,
    );
  else if (
    typeof value === 'bigint' &&
    value >= -(2n ** 63n) &&
    value < 2n ** 63n
  )
    request.addParameter(name, TYPES.BigInt, value.toString());
  else if (value instanceof Date && Number.isFinite(value.getTime()))
    request.addParameter(name, TYPES.DateTime2, value);
  else if (value instanceof Uint8Array)
    request.addParameter(name, TYPES.VarBinary, Buffer.from(value), {
      length: Infinity,
    });
  else throw new TypeError('Unsupported SQL Server parameter value');
}
/** Dedicated physical-connection pool. No automatic transaction release or reconnect. */
export function createSqlServerPool(
  options: SqlServerPoolOptions,
): SqlServerSessionPool & { close(): Promise<void> } {
  const maximum = options.max ?? 10;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000)
    throw new TypeError('max must be between 1 and 1000');
  const connectMs = positiveMilliseconds(options.connectTimeoutMs, 5000);
  const config: ConnectionConfiguration = structuredClone(options.connection);
  config.options = {
    ...config.options,
    connectTimeout: connectMs,
    requestTimeout: config.options?.requestTimeout ?? 15000,
    useColumnNames: false,
    rowCollectionOnRequestCompletion: false,
  };
  type Resource = {
    connection: Connection;
    healthy: boolean;
    listeners: Set<(error: Error) => void>;
  };
  const pool = new Pool<Resource>({
    min: 0,
    max: maximum,
    acquireTimeoutMillis: positiveMilliseconds(options.acquireTimeoutMs, 5000),
    createTimeoutMillis: connectMs + 1000,
    destroyTimeoutMillis: connectMs,
    idleTimeoutMillis: positiveMilliseconds(options.idleTimeoutMs, 10000),
    propagateCreateError: true,
    create: () =>
      new Promise<Resource>((resolve, reject) => {
        const connection = new Connection(structuredClone(config));
        const resource: Resource = {
          connection,
          healthy: true,
          listeners: new Set(),
        };
        connection.on('error', (error) => {
          resource.healthy = false;
          for (const listener of resource.listeners) listener(error);
        });
        connection.on('end', () => {
          if (resource.healthy) {
            resource.healthy = false;
            for (const listener of resource.listeners)
              listener(new Error('SQL Server connection ended'));
          }
        });
        connection.connect((error) => {
          if (error) {
            resource.healthy = false;
            connection.close();
            reject(error);
          } else resolve(resource);
        });
      }),
    validate: (resource) => resource.healthy,
    destroy: (resource) => {
      resource.healthy = false;
      resource.connection.close();
    },
  });
  return Object.freeze({
    async acquire(): Promise<SqlServerSession> {
      const resource = await pool.acquire().promise;
      let released = false;
      const assertActive = () => {
        if (released || !resource.healthy)
          throw new Error('SQL Server session is closed');
      };
      return Object.freeze({
        query<Row extends object = Record<string, unknown>>(
          text: string,
          parameters: Readonly<Record<string, SqlServerValue>> = {},
          timeoutMs = 15000,
        ): Promise<SqlServerResult<Row>> {
          return new Promise((resolve, reject) => {
            assertActive();
            const rows: Row[] = [];
            const request = new Request(text, (error, rowCount) => {
              if (error) reject(error);
              else resolve({ rows, rowCount: rowCount ?? rows.length });
            });
            request.setTimeout(timeoutMs);
            for (const [name, value] of Object.entries(parameters))
              parameter(request, name, value);
            request.on('row', (columns) => {
              const row: Record<string, unknown> = {};
              for (const column of columns)
                Object.defineProperty(row, column.metadata.colName, {
                  value: column.value,
                  enumerable: true,
                  configurable: true,
                });
              rows.push(row as Row);
            });
            resource.connection.execSql(request);
          });
        },
        begin: () =>
          new Promise<void>((resolve, reject) => {
            assertActive();
            resource.connection.beginTransaction((error) =>
              error ? reject(error) : resolve(),
            );
          }),
        commit: () =>
          new Promise<void>((resolve, reject) => {
            assertActive();
            resource.connection.commitTransaction((error) =>
              error ? reject(error) : resolve(),
            );
          }),
        reset: () =>
          new Promise<void>((resolve, reject) => {
            assertActive();
            resource.connection.reset((error) =>
              error ? reject(error) : resolve(),
            );
          }),
        onError(listener: (error: Error) => void) {
          assertActive();
          resource.listeners.add(listener);
          return () => {
            resource.listeners.delete(listener);
          };
        },
        release(destroy = false) {
          if (released) throw new Error('SQL Server session already released');
          released = true;
          resource.listeners.clear();
          if (destroy) {
            resource.healthy = false;
            resource.connection.close();
          }
          pool.release(resource);
        },
      });
    },
    async close() {
      await pool.destroy();
    },
  });
}
