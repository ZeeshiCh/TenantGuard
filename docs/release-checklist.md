# Release checklist

Before the first public npm release:

- [ ] Configure the GitHub repository owner, npm scope and trusted publisher for the release workflow.
- [ ] Set package versions and changelogs together; remove `workspace:*` from generated published manifests through the release packaging process.
- [ ] Run `pnpm check`, `pnpm test:integration`, `pnpm test:examples` and `docker compose -f examples/compose/docker-compose.yml config`.
- [ ] Run the compatibility matrix on Node 22 and the selected release runtime.
- [ ] Review generated PostgreSQL/SQL Server policy SQL with a migration owner and verify restricted runtime roles.
- [ ] Run the CLI doctor/audit and fixture isolation checks against disposable staging databases.
- [ ] Complete an independent security review and record any provider/mode exclusions.
- [ ] Build and inspect package archives; verify declarations, worker files, shebangs and no credentials in tarballs.
- [ ] Publish with provenance from the protected workflow only; verify installation in clean JavaScript and TypeScript consumers.
- [ ] Publish static docs and the synthetic demo only after smoke/isolation checks pass.
- [ ] Record release commit, package versions, compatibility results and rollback notes.

The current repository is release-candidate code, not an already published release. npm, GitHub Pages, registry and demo credentials are intentionally not committed.
