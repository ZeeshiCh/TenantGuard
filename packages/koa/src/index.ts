import type { Context, Middleware } from 'koa';
import { TenantAuthorizationError, type TenantGuard } from '@tenantguard/core';
import { nodeContext } from '@tenantguard/node';
/** Register after authentication and before protected middleware. */
export function tenantMiddleware(guard: TenantGuard<Context>): Middleware {
  return async (context, next) => {
    let authorized = false;
    try {
      await guard.run(context, (tenant) => {
        authorized = true;
        return nodeContext.run(tenant, next);
      });
    } catch (error) {
      if (!authorized && error instanceof TenantAuthorizationError) {
        context.status = 403;
        context.body = 'Tenant access denied';
        return;
      }
      throw error;
    }
  };
}
