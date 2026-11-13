import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { postgresFixture, tenantA, tenantB } from './helpers/postgres.js';

async function waitFor(url: string, token: string, expected: number) {
  // tsx startup on a clean GitHub runner can take several seconds while the
  // workspace packages are resolved and compiled. Keep polling long enough to
  // distinguish a slow, healthy example from a genuinely unavailable server.
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === expected) return response;
    } catch {
      /* process is still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Example did not become ready: ${url}`);
}

test(
  'Node, Hono and NestJS examples authorize tenants and return only their rows',
  { timeout: 180000 },
  async () => {
    const db = await postgresFixture();
    const token = 'example-integration-token';
    const url = db.config;
    await db.admin.query(
      'INSERT INTO public.orders VALUES ($1,$2,$3),($4,$5,$6)',
      ['seed-a', tenantA.tenantId, 'A', 'seed-b', tenantB.tenantId, 'B'],
    );
    const databaseUrl = `postgresql://${url.user}:${url.password}@${url.host}:${url.port}/${url.database}`;
    const examples = [
      ['examples/node-multi-db/src/main.ts', 3011],
      ['examples/hono-multi-db/src/main.ts', 3012],
      ['examples/nestjs-typeorm-saas/src/main.ts', 3013],
    ] as const;
    for (const [entry, port] of examples) {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', resolve(entry)],
        {
          cwd: resolve('.'),
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            DEMO_API_TOKEN: token,
            DEMO_TENANT_ID: tenantA.tenantId,
            PORT: String(port),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      try {
        const response = await waitFor(
          `http://127.0.0.1:${port}/orders`,
          token,
          200,
        );
        const rows = (await response.json()) as Array<{
          tenant_id?: string;
          tenantId?: string;
        }>;
        assert.equal(rows.length, 1, `${entry} leaked or omitted rows`);
        assert.equal(rows[0]!.tenant_id ?? rows[0]!.tenantId, tenantA.tenantId);
        assert.equal(
          (await fetch(`http://127.0.0.1:${port}/orders`)).status,
          403,
        );
      } finally {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
      }
    }
    await db.close();
  },
);
