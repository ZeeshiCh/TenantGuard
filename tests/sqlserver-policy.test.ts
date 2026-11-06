import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sqlServerPolicyBatches,
  quoteSqlServerIdentifier,
  validateSqlServerTenantId,
} from '../packages/sqlserver/src/index.js';
test('SQL Server migration separates schema-bound predicate and native filter/block policy batches', () => {
  const batches = sqlServerPolicyBatches({ schema: 'dbo', table: 'orders' });
  assert.equal(batches.length, 3);
  assert.match(batches[1]!, /^CREATE FUNCTION/);
  for (const text of [
    'ADD FILTER PREDICATE',
    'AFTER INSERT',
    'AFTER UPDATE',
    'STATE = ON',
    'SCHEMABINDING = ON',
  ])
    assert.ok(batches[2]!.includes(text));
  assert.match(batches[1]!, /TRY_CONVERT/);
  assert.match(batches[1]!, /DATALENGTH/);
});
test('SQL Server identifiers and tenant UUIDs reject ambiguous encodings and injection', () => {
  for (const identifier of [
    'orders]; DROP TABLE users;--',
    'dbo.orders',
    'x'.repeat(129),
  ])
    assert.throws(() => quoteSqlServerIdentifier(identifier));
  assert.equal(quoteSqlServerIdentifier('tenantguard'), '[tenantguard]');
  for (const tenant of ['', 'Org_A', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'])
    assert.throws(() => validateSqlServerTenantId(tenant));
  validateSqlServerTenantId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
});
