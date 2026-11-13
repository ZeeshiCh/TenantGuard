# Release checklist

Before the first public npm release:

Run `pnpm release:preflight` first. It verifies the MIT license, package names/versions, Node engine, published `dist` files and deterministic workspace ranges. Then run `pnpm release:pack`; it creates temporary archives for only the TenantGuard workspaces and inspects their packed manifests for rewritten dependency ranges and `dist` contents. A successful preflight means the repository is ready for versioning and credentialed release; it does not publish anything.

- [ ] Configure the GitHub repository owner, npm scope and trusted publisher for the release workflow.
- [ ] Set package versions and changelogs together; remove `workspace:*` from generated published manifests through the release packaging process.
- [ ] Run `pnpm check`, `pnpm test:integration`, `pnpm test:examples` and `docker compose -f examples/compose/docker-compose.yml config`.
- [ ] Run the compatibility matrix on Node 22 and the selected release runtime.
- [ ] Review generated PostgreSQL/SQL Server policy SQL with a migration owner and verify restricted runtime roles.
- [ ] Run the CLI doctor/audit and fixture isolation checks against disposable staging databases.
- [ ] Complete an independent security review and record any provider/mode exclusions.
- [ ] Confirm CodeQL and dependency-review workflows are green for the release commit.
- [ ] Build and inspect package archives; verify declarations, worker files, shebangs and no credentials in tarballs.
- [ ] Publish with provenance from the protected workflow only; verify installation in clean JavaScript and TypeScript consumers.
- [ ] Publish static docs and the synthetic demo only after smoke/isolation checks pass.
- [ ] Record release commit, package versions, compatibility results and rollback notes.

The current repository is release-candidate code, not an already published release. npm, GitHub Pages, registry and demo credentials are intentionally not committed.
