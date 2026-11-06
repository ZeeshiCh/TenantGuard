import {
  TenantAuthorizationError,
  type TenantContext,
  type TenantGuard,
} from '@tenantguard/core';
/** Request framework integration without requiring Node or an ambient context carrier.
 * Handler errors propagate to the host framework; only authorization denial maps to 403.
 */
export function withTenant<RequestType extends Request>(
  guard: TenantGuard<RequestType>,
  handler: (
    request: RequestType,
    context: Readonly<TenantContext>,
  ) => Response | Promise<Response>,
): (request: RequestType) => Promise<Response> {
  return async (request) => {
    let authorized = false;
    try {
      return await guard.run(request, (context) => {
        authorized = true;
        return handler(request, context);
      });
    } catch (error) {
      if (!authorized && error instanceof TenantAuthorizationError)
        return new Response('Tenant access denied', { status: 403 });
      throw error;
    }
  };
}
