# Release workflow audit

Audit date: 2026-11-14. This report is intentionally separate from the workflow definitions; it records changes required before enabling credentialed publication.

## Findings

1. The examples workflow validates Compose syntax and `pnpm typecheck`, but it does not run `pnpm test:examples`. The deployment plan and release checklist promise a real Node/Hono/NestJS example test. Add that command to the examples job or make it a separate Docker-enabled job.
2. The release workflow runs `pnpm check`, `pnpm test:integration`, Compose validation and recursive `pnpm -r pack`, but it does not run `pnpm release:preflight` or the focused `pnpm release:pack` archive inspection. Add both commands before any publish step.
3. The release workflow has `contents: read` only. npm trusted publishing requires an explicit `id-token: write` permission when an npm publish step is added. Keep `contents: read` for verification and grant `id-token: write` only to the minimal publish job, not the whole workflow.
4. The workflow currently performs verification only; it does not publish npm packages, upload provenance, publish GitHub Pages, upload container images or deploy the optional demo. This is safe, but the deployment plan must remain marked as credential-gated until those jobs are deliberately added.
5. The release workflow has no concurrency group or tag/ref input. A protected manual run can overlap another run or verify a branch other than the intended release commit. Add a concurrency group and a protected tag/ref input before publication.
6. The CI job has a 20-minute timeout while the documented SQL Server image uses x86 emulation and the full checks include package consumers. This may be too short on a cold GitHub runner. Measure the first run and increase the timeout or split expensive database jobs if the job approaches the limit.
7. The release workflow uses `pnpm -r pack` as a dry run but does not inspect archives for rewritten workspace dependencies, declarations, worker files, shebangs or secrets. `pnpm release:pack` covers manifest/dist checks; tarball content inspection should be added before publication.
8. There is no GitHub Pages deployment workflow. `apps/docs/index.html` is ready as a static entry point, but Pages source and deployment must be configured by a repository administrator.

## Safe current state

The current workflows do not publish or deploy anything. They use read-only repository permissions and require an explicit `confirm: release` input. The repository has local `release:preflight` and `release:pack` commands that can be run manually while credentialed workflow changes are reviewed.

## Recommended order

Run the examples integration job, add the two focused release commands, split verification from any future publish job, then configure a narrowly scoped npm trusted-publishing job with `id-token: write`. Configure GitHub Pages separately and keep demo deployment credentials outside the repository.
