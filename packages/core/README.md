# @tenantguard/core

Portable tenant context, authorization and named-source routing contracts. Authentication and membership verification remain application-owned.

```ts
const guard = createTenantGuard({ authorize: verifyMembership });
await guard.run(request, (context) => service.list(context));
```

The core package has no database or Node dependency and supports Node, Hono, Fetch and other JavaScript/TypeScript backends. It validates bounded, case-sensitive tenant IDs and rejects tenant switching and inactive routes.
