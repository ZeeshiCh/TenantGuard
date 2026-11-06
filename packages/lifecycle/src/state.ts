import { validateTenantId, type TenantRoute } from '@tenantguard/core';
export interface LifecycleKey {
  readonly tenantId: string;
  readonly source: string;
}
export interface LifecycleOperation {
  readonly id: string;
  readonly kind: 'provision' | 'migrate' | 'resume';
  readonly target: Readonly<TenantRoute>;
  readonly schemaVersion: string;
}
export interface LifecycleState {
  readonly version: number;
  readonly route: Readonly<TenantRoute>;
  readonly schemaVersion?: string;
  readonly operation?: Readonly<LifecycleOperation>;
  readonly failure?: 'operation';
}
export class LifecycleConflictError extends Error {
  constructor() {
    super('Tenant lifecycle version or operation conflicts');
    this.name = 'LifecycleConflictError';
  }
}
export class LifecycleUnavailableError extends Error {
  constructor() {
    super('Tenant lifecycle does not admit this active route');
    this.name = 'LifecycleUnavailableError';
  }
}
export class LifecycleBusyError extends Error {
  constructor() {
    super('Tenant lifecycle lock or capacity is busy');
    this.name = 'LifecycleBusyError';
  }
}
export class LifecycleClosedError extends Error {
  constructor() {
    super('Tenant lifecycle service is closed');
    this.name = 'LifecycleClosedError';
  }
}
export class LifecycleTimeoutError extends Error {
  constructor(readonly phase: 'operation' | 'shutdown') {
    super(`Tenant lifecycle ${phase} deadline exceeded`);
    this.name = 'LifecycleTimeoutError';
  }
}
export class LifecycleRecoveryError extends Error {
  constructor() {
    super('Inactive lifecycle operation requires explicit reconciliation');
    this.name = 'LifecycleRecoveryError';
  }
}
export class LifecyclePublicationError extends Error {
  readonly committed = true;
  constructor(
    readonly state: Readonly<LifecycleState>,
    cause: unknown,
  ) {
    super('Lifecycle state committed but publication failed', { cause });
    this.name = 'LifecyclePublicationError';
  }
}
export function text(value: unknown, max = 2048): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TypeError('Invalid lifecycle reference');
}
export function keySnapshot(value: LifecycleKey): Readonly<LifecycleKey> {
  const key = { tenantId: value.tenantId, source: value.source };
  validateTenantId(key.tenantId);
  text(key.source, 256);
  return Object.freeze(key);
}
export const keyString = (key: LifecycleKey) =>
  JSON.stringify([key.tenantId, key.source]);
export function routeSnapshot(
  value: Readonly<TenantRoute>,
): Readonly<TenantRoute> {
  const route = {
    tenantId: value.tenantId,
    source: value.source,
    adapter: value.adapter,
    resource: value.resource,
    revision: value.revision,
    status: value.status,
    mode: value.mode,
    secretRef: value.secretRef,
  };
  keySnapshot(route);
  text(route.adapter);
  text(route.resource);
  text(route.revision);
  if (route.secretRef !== undefined) text(route.secretRef);
  if (
    ![
      'active',
      'pending',
      'provisioning',
      'migrating',
      'suspended',
      'failed',
    ].includes(route.status) ||
    !['database-policy', 'database-per-tenant', 'application-filter'].includes(
      route.mode,
    )
  )
    throw new TypeError('Invalid lifecycle route');
  return Object.freeze(route);
}
export const routeIdentity = (route: Readonly<TenantRoute>) =>
  JSON.stringify([
    route.tenantId,
    route.source,
    route.adapter,
    route.resource,
    route.revision,
    route.mode,
    route.secretRef ?? null,
  ]);
export function stateSnapshot(
  value: Readonly<LifecycleState>,
  key?: LifecycleKey,
): Readonly<LifecycleState> {
  if (!Number.isSafeInteger(value.version) || value.version < 1)
    throw new TypeError('Invalid lifecycle version');
  const route = routeSnapshot(value.route);
  if (key && keyString(route) !== keyString(key))
    throw new LifecycleConflictError();
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== undefined) text(schemaVersion, 256);
  if (
    (route.status === 'active' ||
      route.status === 'suspended' ||
      route.status === 'migrating') &&
    schemaVersion === undefined
  )
    throw new TypeError('Missing applied schema version');
  const sourceOperation = value.operation;
  let operation: Readonly<LifecycleOperation> | undefined;
  if (sourceOperation) {
    const id = sourceOperation.id,
      kind = sourceOperation.kind,
      target = routeSnapshot(sourceOperation.target),
      schemaVersion = sourceOperation.schemaVersion;
    text(id, 256);
    text(schemaVersion, 256);
    if (
      !['provision', 'migrate', 'resume'].includes(kind) ||
      target.status !== 'active' ||
      keyString(target) !== keyString(route) ||
      target.adapter !== route.adapter ||
      target.mode !== route.mode
    )
      throw new TypeError('Invalid lifecycle operation');
    operation = Object.freeze({ id, kind, target, schemaVersion });
  }
  if (['provisioning', 'migrating'].includes(route.status) && !operation)
    throw new TypeError('Missing lifecycle operation');
  const failure = value.failure;
  if (failure !== undefined && failure !== 'operation')
    throw new TypeError('Invalid lifecycle failure');
  return Object.freeze({
    version: value.version,
    route,
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(operation ? { operation } : {}),
    ...(failure ? { failure } : {}),
  });
}
export function nextVersion(value: number | undefined): number {
  const next = (value ?? 0) + 1;
  if (!Number.isSafeInteger(next)) throw new LifecycleConflictError();
  return next;
}
export function assertActive(
  state: Readonly<LifecycleState> | undefined,
  requested: Readonly<TenantRoute>,
): void {
  if (
    !state ||
    state.route.status !== 'active' ||
    requested.status !== 'active' ||
    routeIdentity(state.route) !== routeIdentity(requested)
  )
    throw new LifecycleUnavailableError();
}
export function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647)
    throw new RangeError('Invalid lifecycle limit');
  return result;
}
export interface LifecycleReader {
  read(): Promise<Readonly<LifecycleState> | undefined>;
}
export interface LifecycleSession extends LifecycleReader {
  compareAndSet(
    expected: number | undefined,
    next: Readonly<LifecycleState>,
  ): Promise<boolean>;
}
export interface LifecycleTransaction<Native> extends LifecycleSession {
  runPhase<T>(work: (native: Native) => Promise<T>): Promise<T>;
}
export interface LifecycleStore<Native> {
  read(key: LifecycleKey): Promise<Readonly<LifecycleState> | undefined>;
  withControlLock<T>(
    key: LifecycleKey,
    work: (session: LifecycleSession) => Promise<T>,
  ): Promise<T>;
  /** Must exclude admissions and retain ownership through actual work/commit/cleanup. */
  withExclusiveLock<T>(
    key: LifecycleKey,
    work: (transaction: LifecycleTransaction<Native>) => Promise<T>,
    beforeCommit?: () => void,
  ): Promise<T>;
  close(): Promise<void>;
}
export interface LifecycleAdmissionStore<
  Native,
> extends LifecycleStore<Native> {
  withAdmission<T>(
    key: LifecycleKey,
    work: (reader: LifecycleReader) => Promise<T>,
  ): Promise<T>;
}
