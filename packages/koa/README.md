# @tenantguard/koa

Node-only Koa tenant authorization and asynchronous request context. Verified with Koa 3.3.0 on Node 22 and the local Node 25 runtime. Other framework majors are not certified.

```ts
import Koa, { type Context } from 'koa';
import { createTenantGuard } from '@tenantguard/core';
import { requireTenant } from '@tenantguard/node';
import { tenantMiddleware } from '@tenantguard/koa';

const app = new Koa();
// Install your error handler and authentication middleware first.
const guard = createTenantGuard<Context>({
  authorize: async (context) => {
    const membership = await authenticateAndAuthorizeMembership(context);
    return membership
      ? { tenantId: membership.tenantId, principalId: membership.userId }
      : undefined;
  },
});
app.use(tenantMiddleware(guard));
app.use(async (context) => {
  context.body = await router.run(requireTenant(), 'orders', (client) =>
    client.table('orders').find(),
  );
});
```

`authenticateAndAuthorizeMembership` is application code: authenticate credentials, verify membership and active tenant status, then return a trusted identity. `router` is your configured portable TenantGuard router; the example uses a scoped SQL client. The framework adapter does not select a database, open transactions or enforce database policy. All existing database adapters can consume the explicit context returned by `requireTenant()`.

Returning undefined (or throwing `TenantAuthorizationError` during authorization) ends the request with 403 and `Tenant access denied`. Invalid contexts, provider failures and downstream errors propagate to the framework error handler unchanged. A downstream `TenantAuthorizationError` is also an application error, not an authorization denial. Configure your application's production error responses.

The guard's configured carrier is honored. The adapter additionally enters the shared `nodeContext`, so `requireTenant()` and existing Node integrations work without configuring a carrier. Snapshots are frozen; switching tenant or principal inside an active Node scope is rejected. No headers are automatically trusted, no request properties are mutated, and authorization runs once per middleware/hook invocation. Install it once on each protected route scope, after authentication. Public routes should sit outside that scope.

The scope encloses await next(). Upstream middleware registered before this adapter resumes outside that scope, including upstream error handlers. Read/capture the context inside protected middleware when needed.

Context propagation is not cancellation: disconnecting a client does not cancel membership lookups, database work or resources created inside the scope. Await all work, close transactions through database adapters, and reauthorize background jobs. Detached async resources may retain their original context after a response; the adapter does not revoke them automatically. Workers, WebSockets, long-lived streams and cross-process propagation are not certified by these tests.

Real TCP HTTP tests cover overlapping tenant/principal requests, case-sensitive identities, denied and forged-header requests, provider outages, invalid contexts, handler errors, public-route isolation, custom carriers and client disconnects. Run `node --import tsx --test tests/koa.integration.ts` after installing workspace dependencies. Packages remain unpublished; these adapters run inside your backend process wherever that Node application is deployed.
