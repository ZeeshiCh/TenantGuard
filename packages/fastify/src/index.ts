import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { TenantAuthorizationError, type TenantGuard } from '@tenantguard/core';
import { nodeContext } from '@tenantguard/node';
/** Install as a preHandler hook in the protected encapsulation scope, after authentication. */
export function tenantHook(
  guard: TenantGuard<FastifyRequest>,
): preHandlerHookHandler {
  return (request, reply, done) => {
    let authorized = false;
    void guard
      .run(request, (tenant) => {
        authorized = true;
        nodeContext.run(tenant, () => done());
      })
      .catch((error: unknown) => {
        if (!authorized && error instanceof TenantAuthorizationError) {
          void reply.code(403).send('Tenant access denied');
        } else done(error as Error);
      });
  };
}
