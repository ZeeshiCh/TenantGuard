import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { pgTable, text, alias } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import {
  validateDrizzleTable,
  drizzleCompiler,
} from '../packages/drizzle/src/guards.js';
const pg = pgTable('orders', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  value: text('value'),
});
const mysql = mysqlTable('orders', {
  id: varchar('id', { length: 64 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 256 }).notNull(),
  value: varchar('value', { length: 256 }),
});
const definition = {
  tenantColumn: 'tenantId',
  idColumn: 'id',
  columns: ['id', 'tenantId', 'value'],
};
test('Drizzle compiles bound binary tenant predicates for both SQL dialects', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const { MySqlDialect } = await import('drizzle-orm/mysql-core');
  for (const table of [pg, mysql]) {
    const spec = validateDrizzleTable({ table, ...definition }),
      compiler = drizzleCompiler(spec, 'Org_A'),
      dialect =
        spec.provider === 'postgresql' ? new PgDialect() : new MySqlDialect();
    const plan = dialect.sqlToQuery(compiler.find({ id: "' OR 1=1 --" }).where);
    assert.match(
      plan.sql,
      spec.provider === 'postgresql' ? /COLLATE "C"/ : /BINARY/,
    );
    assert.ok(!plan.sql.includes('Org_A'));
    assert.ok(plan.params.includes('Org_A'));
    assert.ok(plan.params.includes("' OR 1=1 --"));
    assert.deepEqual(compiler.insert({ id: 'new', value: 'v' }), {
      id: 'new',
      value: 'v',
      tenantId: 'Org_A',
    });
  }
});
test('Drizzle guards reject operators, SQL objects, raw options and mutable ownership', () => {
  const compiler = drizzleCompiler(
    validateDrizzleTable({ table: pg, ...definition }),
    'a',
  );
  for (const call of [
    () => compiler.find({ OR: 'unsafe' }),
    () => compiler.find({ id: sql`1=1` } as never),
    () => compiler.update({ id: 'x' }, { tenantId: 'a' }),
    () => compiler.update({ id: 'x' }, { id: 'y' }),
    () => compiler.delete({}),
    () => compiler.insert({ id: 'x', tenantId: 'other' }),
    () => compiler.find({}, { with: { related: true } } as never),
  ])
    assert.throws(call);
});
test('Drizzle table metadata rejects runtime SQL defaults and callbacks', () => {
  for (const value of [
    text('value').$defaultFn(() => 'x'),
    text('value').$onUpdateFn(() => 'x'),
    text('value').default(sql`'secret'`),
  ]) {
    const table = pgTable('unsafe', {
      id: text('id').primaryKey(),
      tenantId: text('tenant_id').notNull(),
      value,
    });
    assert.throws(
      () => validateDrizzleTable({ table, ...definition }),
      /hooks|defaults/,
    );
  }
  const table = pgTable('nullable', {
    id: text('id'),
    tenantId: text('tenant_id'),
    value: text('value'),
  });
  assert.throws(
    () => validateDrizzleTable({ table, ...definition }),
    /required strings/,
  );
});
test('Drizzle compiler snapshots mutable values before queueing', () => {
  const compiler = drizzleCompiler(
    validateDrizzleTable({ table: pg, ...definition }),
    'a',
  );
  const bytes = new Uint8Array([1]);
  const data = compiler.insert({ id: 'x', value: bytes });
  bytes[0] = 9;
  assert.deepEqual(data.value, new Uint8Array([1]));
  assert.throws(
    () =>
      compiler.find({
        get id(): never {
          throw Error('getter executed');
        },
      }),
    /Accessors/,
  );
});

test('Drizzle aliases cannot point metadata checks at a different physical table', () => {
  assert.throws(
    () => validateDrizzleTable({ table: alias(pg, 'other'), ...definition }),
    /concrete Drizzle tables/,
  );
});
