import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScopedSqlCompiler } from '../packages/scoped-sql/src/crud.js';
const table = {
  table: 'orders',
  tenantColumn: 'tenant_id',
  idColumn: 'id',
  columns: ['id', 'tenant_id', 'value'],
};
test('SQLite compiler binds tenant identity and requires binary scalar text ownership', () => {
  const c = createScopedSqlCompiler('main', table, 'Org_A', {
    dialect: 'sqlite',
  });
  for (const plan of [
    c.find(),
    c.update({ id: 'x' }, { value: 'v' }),
    c.delete({ id: 'x' }),
  ]) {
    assert.match(plan.text, /typeof\("tenant_id"\) = 'text'/);
    assert.match(plan.text, /"tenant_id" COLLATE BINARY = \?/);
    assert.ok(!plan.text.includes('Org_A'));
    assert.ok(plan.values.includes('Org_A'));
  }
  assert.match(
    c.insert({ id: 'a', value: 'v' }).text,
    /INSERT INTO "main"\."orders"/,
  );
  assert.throws(
    () => c.update({ id: 'x' }, { tenant_id: 'other' }),
    /immutable/,
  );
  assert.throws(() => c.delete({}), /non-tenant/);
  assert.throws(() => c.find({ $where: 'unsafe' }), /Unregistered/);
});
test('SQLite compiler snapshots mutable bound values without accepting SQL fragments', () => {
  const c = createScopedSqlCompiler('main', table, 'a', { dialect: 'sqlite' }),
    data = new Uint8Array([1]);
  const plan = c.insert({ id: 'a', value: data });
  data[0] = 2;
  assert.deepEqual(plan.values[1], new Uint8Array([1]));
  assert.throws(
    () => c.find({ id: { toSqlString: () => "' OR 1=1" } as never }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      c.find(
        {},
        { orderBy: { column: 'id', direction: 'asc;COMMIT' as never } },
      ),
    /Invalid order/,
  );
});
