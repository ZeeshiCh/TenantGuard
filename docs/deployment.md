# Deployment and release plan

TenantGuard is deployed inside the user's backend process. It does not need a TenantGuard server, broker or hosted database. The backend owns authentication, tenant membership, resource credentials and process lifecycle.

For local development, use [the Compose showcase](../examples/compose/README.md). For production, run the application on the platform already used by the service (Kubernetes, ECS, Render, Fly.io, VM or a managed Node host) and connect each adapter to its existing database provider. Keep migration credentials separate from runtime credentials. PostgreSQL and SQL Server can enforce native policies; MySQL, MariaDB, MongoDB, SQLite, Prisma, Drizzle and Mongoose require the documented scoped application path.

The intended release pipeline is:

1. Pull request checks run formatting, strict TypeScript checks, unit tests, packed-consumer tests, Compose validation and the supported real-database integration suite.
2. A protected manual release workflow repeats those checks and creates package archives. npm publishing remains a separately approved step with trusted publishing and provenance configured for the repository.
3. GitHub Pages publishes `apps/docs`. The documentation is static and contains no secrets or live database state.
4. Optional demo deployment runs a synthetic-data Hono/PostgreSQL application with a restricted runtime role. It may be hosted on Render or another container platform; demo credentials and domain are deployment-specific and are not committed here.

CodeQL scans JavaScript/TypeScript changes on pushes, pull requests and a weekly schedule. Dependency review blocks high-severity dependency changes in pull requests. These workflows provide automated screening; they do not replace the independent security review required before a stable release.

Before publishing, configure the repository owner, npm scope access, the `npm-production` environment, npm trusted publishing/provenance, the `NPM_TOKEN` secret if your npm policy requires it, Pages source, container registry permissions and a maintenance/security contact. The protected `publish.yml` workflow requires the literal `publish-0.1.0` confirmation and an explicit verified tag or commit ref, then repeats all checks before `pnpm -r publish`. Until those values exist, the repository is release-ready in code and verification terms but no package or service is automatically published.

The Compose passwords, ports and SQL Server developer image are local-only. Rotate all credentials, disable public database exposure, use private networking and provision TLS certificates before any production deployment.
