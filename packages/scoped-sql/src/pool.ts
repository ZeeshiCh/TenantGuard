import { Pool } from 'tarn';
import type { ScopedSqlValue } from './crud.js';
export interface ScopedSqlResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly affectedRows: number;
}
export interface ScopedSqlWire {
  execute(
    text: string,
    values?: readonly ScopedSqlValue[],
  ): Promise<ScopedSqlResult>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  reset(): Promise<void>;
  destroy(): void;
  onError(listener: (error: Error) => void): () => void;
}
export interface ScopedSqlSession extends Omit<ScopedSqlWire, 'destroy'> {
  readonly database: string;
  release(destroy?: boolean): void;
}
export interface ScopedSqlSessionPool {
  acquire(): Promise<ScopedSqlSession>;
}
export interface ScopedSqlPoolOptions {
  readonly database: string;
  connect(): Promise<ScopedSqlWire>;
  readonly max?: number;
  readonly acquireTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}
export function sqlDuration(
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
export function createScopedSqlPool(
  options: ScopedSqlPoolOptions,
): ScopedSqlSessionPool & { close(): Promise<void> } {
  const max = options.max ?? 10,
    connectMs = sqlDuration(options.connectTimeoutMs, 5000),
    database = options.database,
    connect = options.connect;
  if (!Number.isSafeInteger(max) || max < 1 || max > 1000)
    throw new TypeError('Invalid pool size');
  type Resource = {
    wire: ScopedSqlWire;
    healthy: boolean;
    listeners: Set<(error: Error) => void>;
    detach: () => void;
  };
  const pool = new Pool<Resource>({
    min: 0,
    max,
    propagateCreateError: true,
    acquireTimeoutMillis: sqlDuration(options.acquireTimeoutMs, 5000),
    createTimeoutMillis: connectMs,
    destroyTimeoutMillis: connectMs,
    idleTimeoutMillis: sqlDuration(options.idleTimeoutMs, 10000),
    create: async () => {
      const wire = await connect();
      const resource: Resource = {
        wire,
        healthy: true,
        listeners: new Set(),
        detach: () => {},
      };
      try {
        resource.detach = wire.onError((error) => {
          resource.healthy = false;
          for (const listener of resource.listeners) listener(error);
        });
        return resource;
      } catch (error) {
        wire.destroy();
        throw error;
      }
    },
    validate: (resource) => resource.healthy,
    destroy: (resource) => {
      resource.healthy = false;
      resource.detach();
      resource.wire.destroy();
    },
  });
  return Object.freeze({
    async acquire(): Promise<ScopedSqlSession> {
      const resource = await pool.acquire().promise;
      let released = false;
      const active = () => {
        if (released || !resource.healthy)
          throw new Error('Scoped SQL session is closed');
      };
      const call = <T>(work: () => Promise<T>): Promise<T> =>
        Promise.resolve().then(() => {
          active();
          return work();
        });
      return Object.freeze({
        database,
        execute: (text: string, values?: readonly ScopedSqlValue[]) =>
          call(() => resource.wire.execute(text, values)),
        begin: () => call(() => resource.wire.begin()),
        commit: () => call(() => resource.wire.commit()),
        rollback: () => call(() => resource.wire.rollback()),
        reset: () => call(() => resource.wire.reset()),
        onError(listener: (error: Error) => void) {
          active();
          resource.listeners.add(listener);
          return () => {
            resource.listeners.delete(listener);
          };
        },
        release(destroy = false) {
          if (released) throw new Error('Scoped SQL session already released');
          released = true;
          resource.listeners.clear();
          if (destroy) {
            resource.healthy = false;
            resource.wire.destroy();
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
