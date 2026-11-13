# @tenantguard/node

Node `AsyncLocalStorage` carrier for TenantGuard. Install it when framework handlers need ambient context helpers such as `requireTenant()`.

```ts
const guard = createTenantGuard({
  carrier: nodeContext,
  authorize: verifyMembership,
});
await guard.run(request, () => service.execute(requireTenant()));
```

Authentication must run before the authorizer. Detached jobs must receive an explicit verified context and must not trust request headers.
