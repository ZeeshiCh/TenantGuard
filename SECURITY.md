# Security policy

TenantGuard is a security-sensitive library. Report suspected tenant-boundary bypasses, credential exposure, unsafe cleanup, or release-integrity issues privately rather than opening a public issue with exploit details.

Until a public security contact is configured, use the repository owner’s private GitHub security advisory channel. Include the affected package and version, runtime/database versions, a minimal reproduction using synthetic data, expected isolation behavior, observed behavior, and whether credentials or tenant data were exposed. Do not include production connection strings or real tenant records.

Supported security claims are limited to the compatibility matrix and package guides. The library does not authenticate users, infer authorization from headers, certify arbitrary SQL/ORM access, or prevent direct access made with database credentials outside its adapter. Native policy presence is not proof of correct policy semantics. Review migration SQL and use separate migration/runtime roles.

The maintainers will acknowledge reproducible reports, coordinate a fix or affected-mode disablement, add a regression test where practical, and publish a release note. Emergency work may temporarily disable a provider or command. Public disclosure timing depends on impact, available fix, downstream exposure and reporter coordination.
