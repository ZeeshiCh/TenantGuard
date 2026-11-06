# @tenantguard/fastify

Node-only Fastify tenant authorization and asynchronous request context. Verified with Fastify 5.12.8 on Node 22 and the local Node 25 runtime. Other framework majors are not certified.

```ts
import Fastify, { type FastifyRequest } from 'fastify';
import { createTenantGuard } from '@tenantguard/core';
import { requireTenant } from '@tenantguard/node';
import { tenantHook } from '@tenantguard/fastify';

const app = Fastify();
await app.register(async (protectedApp) => {
  // Install authentication in this scope before the tenant hook.
  const guard = createTenantGuard<FastifyRequest>({
    authorize: async (request) => {
      const membership = await authenticateAndAuthorizeMembership(request);
      return membership
        ? { tenantId: membership.tenantId, principalId: membership.userId }
        : undefined;
    },
  });
  protectedApp.addHook('preHandler', tenantHook(guard));
  protectedApp.get('/orders', async () =>
    router.run(requireTenant(), 'orders', (client) =>
      client.table('orders').find(),
    ),
  );
});
```

`authenticateAndAuthorizeMembership` is application code: authenticate credentials, verify membership and active tenant status, then return a trusted identity. `router` is your configured portable TenantGuard router; the example uses a scoped SQL client. The framework adapter does not select a database, open transactions or enforce database policy. All existing database adapters can consume the explicit context returned by `requireTenant()`.

Returning undefined (or throwing `TenantAuthorizationError` during authorization) ends the request with 403 and `Tenant access denied`. Invalid contexts, provider failures and downstream errors propagate to the framework error handler unchanged. A downstream `TenantAuthorizationError` is also an application error, not an authorization denial. Configure your application's production error responses.

The guard's configured carrier is honored. The adapter additionally enters the shared `nodeContext`, so `requireTenant()` and existing Node integrations work without configuring a carrier. Snapshots are frozen; switching tenant or principal inside an active Node scope is rejected. No headers are automatically trusted, no request properties are mutated, and authorization runs once per middleware/hook invocation. Install it once on each protected route scope, after authentication. Public routes should sit outside that scope.

The callback-style hook resumes Fastify with done() inside the verified context. Register it as preHandler, not as an async wrapper or an onResponse hook. Fastify encapsulation controls which routes it protects.

Context propagation is not cancellation: disconnecting a client does not cancel membership lookups, database work or resources created inside the scope. Await all work, close transactions through database adapters, and reauthorize background jobs. Detached async resources may retain their original context after a response; the adapter does not revoke them automatically. Workers, WebSockets, long-lived streams and cross-process propagation are not certified by these tests.

Real TCP HTTP tests cover overlapping tenant/principal requests, case-sensitive identities, denied and forged-header requests, provider outages, invalid contexts, handler errors, public-route isolation, custom carriers and client disconnects. Run `node --import tsx --test tests/fastify.integration.ts` after installing workspace dependencies. Packages remain unpublished; these adapters run inside your backend process wherever that Node application is deployed.
