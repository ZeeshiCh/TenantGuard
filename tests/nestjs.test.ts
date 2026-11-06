import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defer, firstValueFrom } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import { TenantGuardInterceptor } from '../packages/nestjs/src/index.js';
import { requireTenant, getTenant } from '../packages/node/src/index.js';
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const context = {
  switchToHttp: () => ({ getRequest: () => ({}) }),
} as ExecutionContext;
test('NestJS subscribes to lazy asynchronous handlers inside tenant context', async () => {
  const interceptor = new TenantGuardInterceptor({
    resolveTenant: async () => id,
  });
  const stream = await interceptor.intercept(context, {
    handle: () =>
      defer(async () => {
        await Promise.resolve();
        return requireTenant().tenantId;
      }),
  });
  assert.equal(await firstValueFrom(stream), id);
  assert.equal(getTenant(), undefined);
});
test('NestJS rejects unresolved tenant before invoking handler', async () => {
  const interceptor = new TenantGuardInterceptor({
    resolveTenant: () => undefined,
  });
  await assert.rejects(
    () =>
      interceptor.intercept(context, {
        handle: () => {
          throw new Error('must not run');
        },
      }),
    /Verified tenant required/,
  );
});
test('NestJS authorizer carries opaque tenant and principal through async handlers', async () => {
  const interceptor = new TenantGuardInterceptor({
    authorize: async () => ({ tenantId: 'Org_A', principalId: 'user' }),
  });
  const stream = await interceptor.intercept(context, {
    handle: () =>
      defer(async () => {
        await Promise.resolve();
        return requireTenant();
      }),
  });
  assert.deepEqual(await firstValueFrom(stream), {
    tenantId: 'Org_A',
    principalId: 'user',
  });
  assert.equal(getTenant(), undefined);
});
test('NestJS does not turn provider TypeErrors into authentication denials', async () => {
  const interceptor = new TenantGuardInterceptor({
    authorize: () => {
      throw new TypeError('provider bug');
    },
  });
  await assert.rejects(
    () =>
      interceptor.intercept(context, {
        handle: () => {
          throw new Error('must not run');
        },
      }),
    /provider bug/,
  );
});
