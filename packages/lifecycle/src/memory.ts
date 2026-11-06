import {
  duration,
  keySnapshot,
  keyString,
  stateSnapshot,
  nextVersion,
  LifecycleBusyError,
  LifecycleClosedError,
  LifecycleTimeoutError,
  LifecycleConflictError,
  type LifecycleAdmissionStore,
  type LifecycleKey,
  type LifecycleSession,
  type LifecycleState,
} from './state.js';
/** Single-process reference store. Use a durable backend for restart/multi-process safety. */
export function createMemoryLifecycleStore(
  options: {
    maxRecords?: number;
    maxLocks?: number;
    shutdownTimeoutMs?: number;
  } = {},
): LifecycleAdmissionStore<Readonly<Record<string, never>>> {
  const maxRecords = duration(options.maxRecords, 1024),
    maxLocks = duration(options.maxLocks, 128),
    timeout = duration(options.shutdownTimeoutMs, 30000);
  const states = new Map<string, Readonly<LifecycleState>>();
  const controls = new Set<string>();
  const traffic = new Map<
    string,
    {
      readers: number;
      exclusive: boolean;
      waiting?: { resolve: () => void; reject: (error: unknown) => void };
    }
  >();
  let closed = false,
    active = 0;
  let closing: Promise<void> | undefined, finish: (() => void) | undefined;
  const check = () => {
    if (closed && active === 0) finish?.();
  };
  const read = (key: LifecycleKey) => states.get(keyString(key));
  function session(key: LifecycleKey, live: () => boolean): LifecycleSession {
    return Object.freeze({
      async read() {
        if (!live()) throw new LifecycleClosedError();
        return read(key);
      },
      async compareAndSet(
        expected: number | undefined,
        next: Readonly<LifecycleState>,
      ) {
        if (!live()) throw new LifecycleClosedError();
        const value = stateSnapshot(next, key);
        if (value.version !== nextVersion(expected))
          throw new TypeError('Nonconsecutive lifecycle version');
        const id = keyString(key),
          current = states.get(id);
        if (current?.version !== expected) return false;
        if (!current && states.size >= maxRecords)
          throw new LifecycleBusyError();
        states.set(id, value);
        return true;
      },
    });
  }
  async function trafficScope<T>(
    input: LifecycleKey,
    exclusive: boolean,
    work: (session: LifecycleSession) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new LifecycleClosedError();
    const key = keySnapshot(input),
      id = keyString(key);
    let lock = traffic.get(id);
    if (!lock) {
      if (traffic.size >= maxLocks) throw new LifecycleBusyError();
      lock = { readers: 0, exclusive: false };
      traffic.set(id, lock);
    }
    if (
      exclusive
        ? lock.exclusive || lock.waiting
        : lock.exclusive || lock.waiting
    )
      throw new LifecycleBusyError();
    active++;
    let live = true;
    try {
      if (exclusive) {
        if (lock.readers)
          await new Promise<void>((resolve, reject) => {
            lock!.waiting = { resolve, reject };
          });
        if (closed) throw new LifecycleClosedError();
        lock.exclusive = true;
      } else lock.readers++;
      return await work(session(key, () => live));
    } finally {
      live = false;
      if (exclusive) {
        lock.exclusive = false;
        lock.waiting = undefined;
      } else lock.readers--;
      if (lock.readers === 0 && lock.waiting) lock.waiting.resolve();
      if (!lock.readers && !lock.exclusive && !lock.waiting) traffic.delete(id);
      active--;
      check();
    }
  }
  return Object.freeze({
    async read(input: LifecycleKey) {
      if (closed) throw new LifecycleClosedError();
      return read(keySnapshot(input));
    },
    async withControlLock<T>(
      input: LifecycleKey,
      work: (session: LifecycleSession) => Promise<T>,
    ): Promise<T> {
      if (closed) throw new LifecycleClosedError();
      const key = keySnapshot(input),
        id = keyString(key);
      if (controls.has(id) || controls.size >= maxLocks)
        throw new LifecycleBusyError();
      controls.add(id);
      active++;
      let live = true;
      try {
        return await work(session(key, () => live));
      } finally {
        live = false;
        controls.delete(id);
        active--;
        check();
      }
    },
    withExclusiveLock: <T>(
      input: LifecycleKey,
      work: (
        transaction: import('./state.js').LifecycleTransaction<
          Readonly<Record<string, never>>
        >,
      ) => Promise<T>,
      beforeCommit?: () => void,
    ) =>
      trafficScope(input, true, async (session) => {
        const key = keySnapshot(input),
          original = await session.read();
        let staged = original,
          changed = false,
          live = true;
        const transaction = Object.freeze({
          async runPhase<T>(
            work: (native: Readonly<Record<string, never>>) => Promise<T>,
          ) {
            if (!live) throw new LifecycleClosedError();
            return work(Object.freeze({}));
          },
          async read() {
            if (!live) throw new LifecycleClosedError();
            return staged;
          },
          async compareAndSet(
            expected: number | undefined,
            next: Readonly<LifecycleState>,
          ) {
            if (!live) throw new LifecycleClosedError();
            const value = stateSnapshot(next, key);
            if (value.version !== nextVersion(expected))
              throw new TypeError('Nonconsecutive version');
            if (staged?.version !== expected) return false;
            staged = value;
            changed = true;
            return true;
          },
        });
        try {
          const result = await work(transaction);
          live = false;
          beforeCommit?.();
          if (changed) {
            if (read(key)?.version !== original?.version)
              throw new LifecycleConflictError();
            if (!original && states.size >= maxRecords)
              throw new LifecycleBusyError();
            states.set(keyString(key), staged!);
          }
          return result;
        } finally {
          live = false;
        }
      }),
    withAdmission: <T>(
      key: LifecycleKey,
      work: (reader: Pick<LifecycleSession, 'read'>) => Promise<T>,
    ) =>
      trafficScope(key, false, (reader) =>
        work(Object.freeze({ read: reader.read })),
      ),
    close() {
      if (closing) return closing;
      closed = true;
      closing = new Promise<void>((resolve, reject) => {
        finish = resolve;
        const timer = setTimeout(
          () => reject(new LifecycleTimeoutError('shutdown')),
          timeout,
        );
        const done = finish;
        finish = () => {
          clearTimeout(timer);
          done();
        };
      });
      void closing.catch(() => {});
      for (const lock of traffic.values())
        lock.waiting?.reject(new LifecycleClosedError());
      check();
      return closing;
    },
  });
}
