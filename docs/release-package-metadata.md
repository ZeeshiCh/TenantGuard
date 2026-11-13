# Package publication metadata audit

Audited the 25 `@tenantguard/*` manifests at the 0.1.0 release candidate. All packages already have `type: module`, `license: MIT`, `files: ["dist"]`, explicit exports, the Node `>=22.16.0` engine and non-private package metadata. No manifest was changed by this audit.

Before the first npm publish, add the final repository URL and issue tracker to every manifest once the canonical GitHub repository is confirmed:

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ZeeshiCh/TenantGuard.git"
  },
  "bugs": { "url": "https://github.com/ZeeshiCh/TenantGuard/issues" },
  "homepage": "https://zeeshich.github.io/TenantGuard/"
}
```

The homepage must be updated if GitHub Pages uses a different owner, repository name or custom domain. Keep these fields identical across packages so npm users can navigate from any adapter to the same source and support channel.

Five packages currently lack a package-local README: `@tenantguard/core`, `@tenantguard/fetch`, `@tenantguard/hono`, `@tenantguard/nestjs` and `@tenantguard/node`, plus `@tenantguard/typeorm`. Add focused package READMEs before publish, or explicitly document why the root README is the supported guide. Each should state its import path, runtime/version boundary, authorization order, isolation limitations and a minimal example.

Peer dependency review:

- `@tenantguard/postgres` and `@tenantguard/lifecycle` peer `pg`; `@tenantguard/typeorm` peers TypeORM; `@tenantguard/express`, `@tenantguard/fastify` and `@tenantguard/koa` peer their host framework; `@tenantguard/nestjs` peers Nest common and RxJS; `@tenantguard/hono` peers Hono.
- Keep these peers optional only when the package can be imported and used without the integration. Otherwise mark the peer required and retain a matching direct development dependency in the workspace fixture.
- Direct database-driver packages should continue declaring the driver they import as a direct dependency or peer according to their public factory contract; do not rely on the workspace root for published resolution.

Exports are present for all 25 packages. Before publishing, inspect every packed archive with `pnpm release:pack`, then install at least one JavaScript and one strict TypeScript consumer per integration family. Confirm generated declarations reference public package paths only and that worker files used by SQLite and CLI are included in `dist`.

This audit is intentionally separate from credentialed npm setup. It does not publish, alter package metadata, or claim that the GitHub Pages URL already exists.
