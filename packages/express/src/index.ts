import type { Request, RequestHandler } from 'express';
import { TenantAuthorizationError, type TenantGuard } from '@tenantguard/core';
import { nodeContext } from '@tenantguard/node';
/** Register after authentication and before protected routes. */
export function tenantMiddleware(guard: TenantGuard<Request>): RequestHandler {
  return (request, response, next) => {
    let authorized = false;
    void guard
      .run(request, (tenant) => {
        authorized = true;
        nodeContext.run(tenant, () => next());
      })
      .catch((error: unknown) => {
        if (!authorized && error instanceof TenantAuthorizationError) {
          response.status(403).send('Tenant access denied');
        } else next(error);
      });
  };
}
