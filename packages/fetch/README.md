# @tenantguard/fetch

Portable Fetch handler wrapper. `withTenant` authorizes a request and invokes the handler with a frozen verified context. It works in Node and Fetch-compatible runtimes; database driver support remains runtime-specific.

```ts
const handler = withTenant(guard, (request, context) => service.list(context));
```
