import type { Context, MiddlewareHandler } from 'hono';
import {
  TenantAuthorizationError,
  type TenantContext,
  type TenantGuard,
} from '@tenantguard/core';
export type TenantEnv = { Variables: { tenant: Readonly<TenantContext> } };
/** Register after authentication middleware. Use c.get('tenant') on portable runtimes. */
export function tenantMiddleware<Env extends TenantEnv = TenantEnv>(
  guard: TenantGuard<Context<Env>>,
): MiddlewareHandler<Env> {
  return async (context, next) => {
    let authorized = false;
    try {
      await guard.run(context, async (tenant) => {
        authorized = true;
        context.set('tenant', tenant);
        await next();
      });
    } catch (error) {
      if (!authorized && error instanceof TenantAuthorizationError)
        return context.text('Tenant access denied', 403);
      throw error;
    }
  };
}
