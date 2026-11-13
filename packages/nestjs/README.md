# @tenantguard/nestjs

NestJS module, interceptor and decorator integration. Authentication guards run first, then `TenantGuardInterceptor` authorizes the request and exposes `@CurrentTenant()`.

```ts
TenantGuardModule.forRoot({ authorize: verifyMembership });
```

Use a scoped database transaction or explicit router in the controller. The module does not make global repositories tenant-safe and does not replace membership authorization.
