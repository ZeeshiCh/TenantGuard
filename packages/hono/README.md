# @tenantguard/hono

Hono middleware that stores a verified tenant context in `c.get('tenant')` and maps denied membership to HTTP 403.

```ts
const app = new Hono<TenantEnv>();
app.use('*', tenantMiddleware(guard));
```

Register authentication before this middleware. It does not trust tenant headers and does not provide database query isolation by itself; pass the context to a scoped adapter or router.
