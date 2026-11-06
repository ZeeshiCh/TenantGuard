# NestJS + TypeORM orders example

Start a local PostgreSQL database. With an administrator connection, create a migration owner and a restricted login. For local development only:

```sql
CREATE ROLE tenantguard_app LOGIN PASSWORD 'local-development-only' NOSUPERUSER NOBYPASSRLS;
CREATE TABLE public.orders (id integer PRIMARY KEY, tenant_id uuid NOT NULL, description text NOT NULL);
CREATE INDEX ON public.orders (tenant_id);
GRANT USAGE ON SCHEMA public TO tenantguard_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO tenantguard_app;
INSERT INTO public.orders VALUES
 (1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Company A order'),
 (2, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Company B order');
```

From the repository root, build packages and generate the policy migration:

```sh
pnpm build
node --input-type=module -e "import {tenantPolicySql} from './packages/postgres/dist/index.js'; console.log(tenantPolicySql('orders'))" > /tmp/tenantguard-policy.sql
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/tenantguard-policy.sql
```

Run with the restricted login:

```sh
export DATABASE_URL=postgresql://tenantguard_app:local-development-only@localhost:5432/postgres
export DEMO_API_TOKEN=replace-with-a-random-local-token
export DEMO_TENANT_ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
pnpm --filter tenantguard-example start
```

```sh
curl -H "Authorization: Bearer $DEMO_API_TOKEN" http://localhost:3000/orders
```

Only Company A's order should be returned; missing or incorrect credentials receive 401. Restart with Company B's tenant UUID to demonstrate the other identity. The demo token maps to a server-configured tenant; no tenant header is accepted. Replace this demo authentication with your identity provider and a membership lookup before deployment.
