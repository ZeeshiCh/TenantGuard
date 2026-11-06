import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono, type Context } from 'hono';
import {
  createTenantGuard,
  TenantAuthorizationError,
} from '../packages/core/src/index.js';
import { createNodeContextCarrier } from '../packages/node/src/index.js';
import { withTenant } from '../packages/fetch/src/index.js';
import {
  tenantMiddleware,
  type TenantEnv,
} from '../packages/hono/src/index.js';
// This fixture represents a trusted authentication/membership boundary, not header authorization.
const membership = new Map([
  ['Bearer alice', 'Org_A'],
  ['Bearer bob', 'org_a'],
]);
const authorize = (request: Request) => {
  const tenantId = membership.get(request.headers.get('authorization') ?? '');
  return tenantId ? { tenantId } : undefined;
};
test('Fetch wrapper authorizes explicit context and denies raw tenant headers', async () => {
  const handle = withTenant(
    createTenantGuard({ authorize }),
    async (_request, context) => Response.json(context),
  );
  assert.equal(
    (
      await handle(
        new Request('http://test', { headers: { 'x-tenant-id': 'Org_A' } }),
      )
    ).status,
    403,
  );
  const response = await handle(
    new Request('http://test', { headers: { authorization: 'Bearer alice' } }),
  );
  assert.deepEqual(await response.json(), { tenantId: 'Org_A' });
});
test('Fetch does not swallow handler authorization errors or provider outages', async () => {
  const request = new Request('http://test', {
    headers: { authorization: 'Bearer alice' },
  });
  const handle = withTenant(createTenantGuard({ authorize }), () => {
    throw new TenantAuthorizationError();
  });
  await assert.rejects(() => handle(request), TenantAuthorizationError);
  const outage = withTenant(
    createTenantGuard<Request>({
      authorize: () => {
        throw new Error('offline');
      },
    }),
    () => new Response(),
  );
  await assert.rejects(() => outage(request), /offline/);
});
for (const ambient of [false, true]) {
  test(`Hono interleaved requests remain isolated with ${ambient ? 'Node carrier' : 'explicit context'}`, async () => {
    const carrier = createNodeContextCarrier();
    const guard = createTenantGuard<Context<TenantEnv>>({
      authorize: (c) => authorize(c.req.raw),
      ...(ambient ? { carrier } : {}),
    });
    const app = new Hono<TenantEnv>();
    app.use('*', tenantMiddleware(guard));
    app.get('/', async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (ambient)
        assert.equal(carrier.get()?.tenantId, c.get('tenant').tenantId);
      return c.json(c.get('tenant'));
    });
    await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        const alice = index % 2 === 0;
        const response = await app.request('/', {
          headers: { authorization: alice ? 'Bearer alice' : 'Bearer bob' },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          tenantId: alice ? 'Org_A' : 'org_a',
        });
      }),
    );
    assert.equal(carrier.get(), undefined);
    assert.equal(
      (await app.request('/', { headers: { 'x-tenant-id': 'Org_A' } })).status,
      403,
    );
  });
}
test('Hono adapter composes with application-specific typed authentication variables', async () => {
  type ApplicationEnv = {
    Variables: TenantEnv['Variables'] & { user: { id: string } };
  };
  const app = new Hono<ApplicationEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'alice' });
    await next();
  });
  const guard = createTenantGuard<Context<ApplicationEnv>>({
    authorize: (c) => ({ tenantId: 'Org_A', principalId: c.get('user').id }),
  });
  app.use('*', tenantMiddleware(guard));
  app.get('/', (c) => c.json(c.get('tenant')));
  const response = await app.request('/');
  assert.deepEqual(await response.json(), {
    tenantId: 'Org_A',
    principalId: 'alice',
  });
});
