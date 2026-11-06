import type { Request, RequestHandler } from 'express';
import { TenantAuthorizationError, type TenantGuard } from '@tenantguard/core';
import { nodeContext } from '@tenantguard/node';
/** Register after authentication and before protected routes. */
export function tenantMiddleware(guard: TenantGuard<Request>): RequestHandler {
  return (request, response, next) => {
    void guard.authorize(request).then(
      (tenant) => {
        try {
          nodeContext.run(tenant, () => next());
        } catch (error) {
          next(error);
        }
      },
      (error: unknown) => {
        if (error instanceof TenantAuthorizationError) {
          response.status(403).send('Tenant access denied');
        } else next(error);
      },
    );
  };
}
