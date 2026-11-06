import type { Context, Middleware } from 'koa';
import { TenantAuthorizationError, type TenantGuard } from '@tenantguard/core';
import { nodeContext } from '@tenantguard/node';
/** Register after authentication and before protected middleware. */
export function tenantMiddleware(guard: TenantGuard<Context>): Middleware {
  return async (context, next) => {
    let tenant;
    try {
      tenant = await guard.authorize(context);
    } catch (error) {
      if (error instanceof TenantAuthorizationError) {
        context.status = 403;
        context.body = 'Tenant access denied';
        return;
      }
      throw error;
    }
    await nodeContext.run(tenant, next);
  };
}
