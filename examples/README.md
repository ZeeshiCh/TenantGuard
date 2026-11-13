# Runnable examples

The examples are intentionally small applications. Authentication is a server-side token-to-membership placeholder; replace it with the application's identity provider and membership query before deployment. No tenant header is trusted.

## Node

```sh
DATABASE_URL=postgresql://tenantguard_app:secret@localhost:5432/tenantguard \
DEMO_API_TOKEN=local-token DEMO_TENANT_ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa \
pnpm --dir examples/node-multi-db start
curl -H 'Authorization: Bearer local-token' http://localhost:3001/orders
```

The same explicit route shape can select MySQL, MariaDB, MongoDB, SQLite, SQL Server or an ORM adapter. The example uses PostgreSQL native RLS because it demonstrates the strongest enforcement mode.

## Hono

```sh
DATABASE_URL=postgresql://tenantguard_app:secret@localhost:5432/tenantguard \
DEMO_API_TOKEN=local-token DEMO_TENANT_ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa \
pnpm --dir examples/hono-multi-db start
curl -H 'Authorization: Bearer local-token' http://localhost:3002/orders
```

The Hono middleware authorizes the request and stores the verified context; the database adapter still receives the context explicitly.

## NestJS

See [nestjs-typeorm-saas](nestjs-typeorm-saas/README.md). It uses `TenantGuardInterceptor` and the TypeORM PostgreSQL adapter.

## Compose showcase

`compose/docker-compose.yml` starts PostgreSQL, MySQL, MariaDB and MongoDB with disposable local credentials. SQLite runs as a file in the example container or host; SQL Server is available under the `sqlserver` profile because its image requires substantially more memory and x86 emulation on many developer machines.

```sh
docker compose -f examples/compose/docker-compose.yml up -d postgres mysql mariadb mongo
docker compose -f examples/compose/docker-compose.yml --profile sqlserver up -d sqlserver
```

The Compose file is for local development and CI fixtures only. It does not publish ports or credentials suitable for production.
