import { MissingTenantError } from '../packages/core/src/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runWithTenant,
  requireTenant,
  getTenant,
} from '../packages/node/src/index.js';
import { tenantPolicySql } from '../packages/postgres/src/index.js';
const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
test('missing and malformed context fail closed', () => {
  assert.throws(requireTenant, MissingTenantError);
  assert.throws(() => runWithTenant('', () => {}), TypeError);
});
test('concurrent asynchronous scopes remain isolated', async () => {
  await Promise.all(
    [a, b].map((id) =>
      runWithTenant(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(requireTenant().tenantId, id);
        assert.ok(Object.isFrozen(requireTenant()));
      }),
    ),
  );
  assert.equal(getTenant(), undefined);
});
test('nested switches rejected and exceptions restore context', () => {
  assert.throws(
    () => runWithTenant(a, () => runWithTenant(b, () => {})),
    /switch/,
  );
  assert.equal(getTenant(), undefined);
});
test('SQL identifiers cannot inject statements and boundary is restrictive', () => {
  assert.throws(() => tenantPolicySql('orders; DROP TABLE users'), TypeError);
  assert.throws(() => tenantPolicySql('x'.repeat(64)), TypeError);
  assert.match(tenantPolicySql('orders'), /AS RESTRICTIVE/);
  assert.match(tenantPolicySql('orders'), /FORCE ROW LEVEL SECURITY/);
});
