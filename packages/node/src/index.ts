import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createTenantContext,
  MissingTenantError,
  TenantSwitchError,
  type ContextCarrier,
  type TenantContext,
} from '@tenantguard/core';
export function createNodeContextCarrier(): ContextCarrier {
  const storage = new AsyncLocalStorage<Readonly<TenantContext>>();
  return Object.freeze({
    get: () => storage.getStore(),
    run<T>(context: Readonly<TenantContext>, callback: () => T): T {
      const snapshot = createTenantContext(context);
      const parent = storage.getStore();
      if (
        parent &&
        (parent.tenantId !== snapshot.tenantId ||
          parent.principalId !== snapshot.principalId)
      )
        throw new TenantSwitchError();
      return storage.run(snapshot, callback);
    },
  });
}
/** Default carrier shared by Node framework and legacy ORM integrations. */
export const nodeContext = createNodeContextCarrier();
export function getTenant(): Readonly<TenantContext> | undefined {
  return nodeContext.get();
}
export function requireTenant(): Readonly<TenantContext> {
  const context = getTenant();
  if (!context) throw new MissingTenantError();
  return context;
}
export function runWithContext<T>(
  context: Readonly<TenantContext>,
  callback: () => T,
): T {
  return nodeContext.run(context, callback);
}
/** Trusted jobs/tests only. Request code should use createTenantGuard with membership authorization. */
export function runWithTenant<T>(tenantId: string, callback: () => T): T {
  const parent = getTenant();
  return runWithContext({ ...parent, tenantId }, callback);
}
