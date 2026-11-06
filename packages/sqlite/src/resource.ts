import { Worker } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
export type SqliteCommitOutcome = 'not-committed' | 'committed' | 'unknown';
export class SqliteSafetyError extends Error {}
export class SqliteTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly commitOutcome: SqliteCommitOutcome = 'not-committed',
  ) {
    super(`SQLite ${phase} deadline exceeded`);
  }
}
export class SqliteLifecycleError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly commitOutcome: SqliteCommitOutcome,
  ) {
    super(errors, 'SQLite transaction or cleanup failed');
  }
}
export function duration(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > 300000)
    throw new TypeError('Invalid SQLite timeout');
  return n;
}
export function bounded<T>(
  promise: Promise<T>,
  ms: number,
  error: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(error()), ms);
    promise.then(resolve, reject);
  }).finally(() => clearTimeout(timer));
}
/** A server-controlled existing database file. Never populated from request input. */
export interface SqliteResource {
  readonly closed: boolean;
  close(): Promise<void>;
}
interface Ticket {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface State {
  path: string;
  busyMs: number;
  maxQueue: number;
  closed: boolean;
  busy: boolean;
  queue: Ticket[];
  wire?: SqliteWire;
  closing?: Promise<void>;
}
const resources = new WeakMap<SqliteResource, State>();
export function createSqliteResource(options: {
  filename: string;
  busyTimeoutMs?: number;
  maxQueue?: number;
}): SqliteResource {
  const filename = options.filename;
  if (
    typeof filename !== 'string' ||
    !isAbsolute(filename) ||
    filename.includes('\0') ||
    !statSync(filename).isFile()
  )
    throw new SqliteSafetyError(
      'SQLite requires an existing absolute database file',
    );
  const maxQueue = options.maxQueue ?? 100;
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 10000)
    throw new TypeError('Invalid SQLite queue bound');
  const state: State = {
    path: filename,
    busyMs: duration(options.busyTimeoutMs, 100),
    maxQueue,
    closed: false,
    busy: false,
    queue: [],
  };
  const resource: SqliteResource = Object.freeze({
    get closed() {
      return state.closed;
    },
    close() {
      state.closed = true;
      for (const ticket of state.queue.splice(0)) {
        clearTimeout(ticket.timer);
        ticket.reject(new SqliteSafetyError('SQLite resource closed'));
      }
      return (state.closing ??= state.wire?.terminate() ?? Promise.resolve());
    },
  });
  resources.set(resource, state);
  return resource;
}
function stateFor(resource: SqliteResource): State {
  const state = resources.get(resource);
  if (!state || state.closed)
    throw new SqliteSafetyError(
      'SQLite resource closed or not owned by TenantGuard',
    );
  return state;
}
export async function acquireSqlite(
  resource: SqliteResource,
  ms: number,
  isActive: () => boolean = () => true,
): Promise<{ wire: SqliteWire; release: () => void }> {
  const state = stateFor(resource);
  let release: () => void;
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.wire = undefined;
      const next = state.queue.shift();
      if (next && !state.closed) {
        clearTimeout(next.timer);
        next.resolve(makeRelease());
      } else {
        state.busy = false;
      }
    };
  };
  if (!state.busy) {
    state.busy = true;
    release = makeRelease();
  } else {
    if (state.queue.length >= state.maxQueue)
      throw new SqliteSafetyError('SQLite acquisition queue full');
    release = await new Promise<() => void>((resolve, reject) => {
      const ticket: Ticket = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = state.queue.indexOf(ticket);
          if (index >= 0) state.queue.splice(index, 1);
          reject(new SqliteTimeoutError('acquisition'));
        }, ms),
      };
      state.queue.push(ticket);
    });
  }
  try {
    stateFor(resource);
    if (!isActive())
      throw new SqliteSafetyError('SQLite scope expired during acquisition');
    const wire = new SqliteWire(
      new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { filename: state.path, busyTimeoutMs: state.busyMs },
        execArgv: [],
      }),
    );
    state.wire = wire;
    return { wire, release };
  } catch (error) {
    release();
    throw error;
  }
}
interface Reply {
  id: number;
  value?: unknown;
  error?: {
    message: string;
    code?: string;
    errcode?: number;
    transaction?: boolean;
  };
}
/** Internal transport: not exported from the package entry point. */
export class SqliteWire {
  private sequence = 0;
  private ended = false;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private stopping?: Promise<void>;
  constructor(private readonly worker: Worker) {
    worker.on('message', (reply: Reply) => {
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      this.pending.delete(reply.id);
      if (reply.error)
        entry.reject(
          Object.assign(new Error(reply.error.message), reply.error),
        );
      else entry.resolve(reply.value);
    });
    worker.on('error', (error) => this.fail(error));
    worker.on('exit', (code) =>
      this.fail(new Error(`SQLite worker exited (${code})`)),
    );
  }
  private fail(error: Error) {
    this.ended = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
  request<T = unknown>(command: string, data?: unknown): Promise<T> {
    if (this.ended)
      return Promise.reject(new SqliteSafetyError('SQLite worker closed'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.worker.postMessage({ id, command, data });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  terminate(): Promise<void> {
    this.fail(new SqliteSafetyError('SQLite worker retired'));
    return (this.stopping ??= this.worker.terminate().then(() => {}));
  }
}
