# Compose showcase

This stack provides disposable local database endpoints for the Node, NestJS and Hono examples. It demonstrates the multi-database deployment shape: one backend process can route to named resources, while each adapter retains its own enforcement mode.

The PostgreSQL service is the native-policy example. MySQL, MariaDB, MongoDB and SQLite are application-filter examples and must use the scoped adapter facade. SQL Server uses native RLS and is opt-in because of image size and host requirements.

Initialize and inspect the stack with:

```sh
docker compose -f examples/compose/docker-compose.yml up -d postgres mysql mariadb mongo
pnpm exec tenantguard init --engine postgres --output examples/compose/postgres.diagnostics.json
```

Run migrations with owner credentials, create restricted runtime users, and set up synthetic `orders` fixtures before starting an example. The Compose file deliberately leaves schema/bootstrap SQL out of the service startup so operators can review migrations and grants. Never reuse these passwords or exposed ports in production.
