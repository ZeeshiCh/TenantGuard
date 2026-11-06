import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import {
  createTenantGuard,
  TenantAuthorizationError,
} from '../packages/core/src/index.js';
import {
  createNodeContextCarrier,
  getTenant,
  requireTenant,
} from '../packages/node/src/index.js';

const carrier = createNodeContextCarrier();
export const outage = new Error('membership provider unavailable');
/** Authentication fixture: tokens map to memberships; tenant headers are deliberately ignored. */
export function guard<Input>(token: (input: Input) => string | undefined) {
  return createTenantGuard<Input>({
    carrier,
    authorize: async (input) => {
      assert.equal(getTenant(), undefined);
      await delay(2);
      assert.equal(getTenant(), undefined);
      const value = token(input);
      if (value === 'outage') throw outage;
      if (value === 'invalid') return { tenantId: ' ' };
      if (value === 'alice') return { tenantId: 'Org_A', principalId: 'alice' };
      if (value === 'bob') return { tenantId: 'org_a', principalId: 'bob' };
      return undefined;
    },
  });
}
export function recordError(
  errors: unknown[],
  error: unknown,
  insideTenantScope = true,
) {
  if (insideTenantScope && error instanceof TenantAuthorizationError) {
    assert.equal(requireTenant().principalId, 'alice');
  } else {
    assert.equal(getTenant(), undefined);
  }
  errors.push(error);
}
export async function handle(path: string) {
  const before = requireTenant();
  assert.deepEqual(carrier.get(), before);
  assert(Object.isFrozen(before));
  await delay(before.tenantId === 'Org_A' ? 8 : 3);
  assert.deepEqual(requireTenant(), before);
  assert.deepEqual(carrier.get(), before);
  if (path === '/abort') await delay(50);
  if (path === '/throw') throw new TenantAuthorizationError();
  return before;
}
export async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
export async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
export function conformance(
  name: string,
  start: () => Promise<{
    url: string;
    stop: () => Promise<void>;
    errors: unknown[];
  }>,
) {
  test(
    `${name}: real HTTP authorization, concurrency, failures and isolation`,
    { timeout: 20_000 },
    async () => {
      const { url, stop, errors } = await start();
      try {
        const request = (path: string, token?: string) =>
          fetch(url + path, {
            headers: {
              'x-tenant-id': 'forged',
              ...(token ? { authorization: token } : {}),
            },
          });
        for (let round = 0; round < 3; round++) {
          await Promise.all(
            Array.from({ length: 24 }, async (_, i) => {
              const token =
                i % 3 === 0 ? undefined : i % 3 === 1 ? 'alice' : 'bob';
              const response = await request('/tenant', token);
              assert.equal(response.status, token ? 200 : 403);
              if (token)
                assert.deepEqual(await response.json(), {
                  tenantId: token === 'alice' ? 'Org_A' : 'org_a',
                  principalId: token,
                });
              else assert.equal(await response.text(), 'Tenant access denied');
            }),
          );
          for (const [path, token] of [
            ['/tenant', 'outage'],
            ['/tenant', 'invalid'],
            ['/throw', 'alice'],
          ]) {
            const response = await request(path!, token);
            assert.equal(response.status, 500);
            await response.text();
          }
          const publicResponse = await request('/public');
          assert.deepEqual(await publicResponse.json(), { tenant: null });
          assert.equal(getTenant(), undefined);
        }
        const controller = new AbortController();
        const disconnected = fetch(url + '/abort', {
          headers: { authorization: 'alice' },
          signal: controller.signal,
        });
        await delay(5);
        controller.abort();
        await assert.rejects(disconnected, { name: 'AbortError' });
        await delay(75);
        const afterAbort = await request('/tenant', 'bob');
        assert.deepEqual(await afterAbort.json(), {
          tenantId: 'org_a',
          principalId: 'bob',
        });
        assert.equal(errors.filter((error) => error === outage).length, 3);
        assert.equal(
          errors.filter((error) => error instanceof TenantAuthorizationError)
            .length,
          3,
        );
      } finally {
        await stop();
      }
      assert.equal(getTenant(), undefined);
    },
  );
}
