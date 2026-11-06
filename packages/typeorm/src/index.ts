import { AsyncLocalStorage } from 'node:async_hooks';
import type { DataSource, EntityManager } from 'typeorm';
import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantContext,
  type TenantRoute,
} from '@tenantguard/core';
import { requireTenant } from '@tenantguard/node';
import {
  SET_TENANT_SQL,
  validatePostgresTenantId,
} from '@tenantguard/postgres';
const transactions = new AsyncLocalStorage<{ active: boolean }>();
async function transaction<T>(
  source: DataSource,
  context: Readonly<TenantContext>,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const snapshot = createTenantContext(context);
  validatePostgresTenantId(snapshot.tenantId);
  if (source.options.type !== 'postgres')
    throw new TypeError('This adapter requires PostgreSQL');
  if (transactions.getStore())
    throw new Error(
      'Nested or detached tenant transactions are unsupported; reuse the callback manager',
    );
  const scope = { active: true };
  return transactions.run(scope, async () => {
    try {
      return await source.transaction(async (manager) => {
        const [role] = await manager.query(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
        );
        if (!role || role.rolsuper || role.rolbypassrls)
          throw new Error(
            'TenantGuard requires a non-superuser role without BYPASSRLS',
          );
        await manager.query(SET_TENANT_SQL, [snapshot.tenantId]);
        return work(manager);
      });
    } finally {
      scope.active = false;
    }
  });
}
/** Legacy Node convenience helper. Use only the provided manager and await every query. */
export function withTenantTransaction<T>(
  source: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  // Preserve an asynchronous rejection contract for missing context.
  return Promise.resolve().then(() =>
    transaction(source, requireTenant(), work),
  );
}
/** Explicit-context bridge to the portable multi-source router.
 * resolveSource must map allowlisted server-side route references to configured pools.
 */
export function createTypeormPostgresAdapter(
  resolveSource: (
    route: Readonly<TenantRoute>,
  ) => DataSource | Promise<DataSource>,
): DatabaseAdapter<EntityManager> {
  return Object.freeze({
    name: 'typeorm-postgres',
    capabilities: Object.freeze({
      isolationModes: ['database-policy'] as const,
      transactions: true,
    }),
    async run<T>(
      context: Readonly<TenantContext>,
      route: Readonly<TenantRoute>,
      work: (manager: EntityManager) => Promise<T>,
    ): Promise<T> {
      if (
        route.mode !== 'database-policy' ||
        route.status !== 'active' ||
        route.tenantId !== context.tenantId ||
        route.adapter !== 'typeorm-postgres'
      )
        throw new Error('Invalid PostgreSQL tenant route');
      return transaction(await resolveSource(route), context, work);
    },
  });
}
