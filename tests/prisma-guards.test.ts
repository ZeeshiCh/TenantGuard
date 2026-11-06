import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateModel,
  prismaCompiler,
  type PrismaDatamodel,
} from '../packages/prisma/src/guards.js';
export const prismaMetadata: PrismaDatamodel = {
  models: [
    {
      name: 'Order',
      dbName: 'orders',
      fields: [
        ...['id', 'tenantId', 'value'].map((name) => ({
          name,
          dbName: name === 'tenantId' ? 'tenant_id' : name,
          kind: 'scalar',
          type: 'String',
          isList: false,
          isRequired: true,
        })),
        {
          name: 'related',
          kind: 'object',
          type: 'Order',
          isList: true,
          isRequired: true,
        },
      ],
    },
  ],
};
export const prismaModel = {
  model: 'Order',
  tenantField: 'tenantId',
  idField: 'id',
  fields: ['id', 'tenantId', 'value'],
};
test('Prisma compiler scopes equality and projects declared scalars only', () => {
  const model = validateModel(prismaModel, prismaMetadata),
    c = prismaCompiler(model, 'Org_A');
  assert.equal(model.tenantColumn, 'tenant_id');
  assert.deepEqual(c.find({ id: 'x' }).where, {
    AND: [{ tenantId: { equals: 'Org_A' } }, { id: { equals: 'x' } }],
  });
  assert.deepEqual(c.create({ id: 'a', value: 'v' }).data, {
    id: 'a',
    value: 'v',
    tenantId: 'Org_A',
  });
  assert.deepEqual(Object.keys(c.find().select), ['id', 'tenantId', 'value']);
});
test('Prisma guard rejects relation entry points, nested writes, raw operators and immutable ownership', () => {
  const c = prismaCompiler(validateModel(prismaModel, prismaMetadata), 'a');
  for (const f of [
    () =>
      validateModel(
        { ...prismaModel, fields: [...prismaModel.fields, 'related'] },
        prismaMetadata,
      ),
    () => c.find({ OR: 'unsafe' }),
    () => c.create({ id: 'x', value: { create: {} } as never }),
    () => c.update({ id: 'x' }, { tenantId: 'a' }),
    () => c.update({ id: 'x' }, { id: 'new' }),
    () => c.delete({}),
    () => c.create({ id: 'x', tenantId: 'b' }),
    () => c.find({}, { include: { related: true } } as never),
    () =>
      c.find({
        get id(): never {
          throw Error('getter executed');
        },
      }),
  ])
    assert.throws(f);
});
test('Prisma inputs snapshot mutable values and refuse unsafe model metadata', () => {
  const c = prismaCompiler(validateModel(prismaModel, prismaMetadata), 'a');
  const bytes = new Uint8Array([1]);
  const args = c.update({ id: 'x' }, { value: bytes });
  bytes[0] = 9;
  assert.deepEqual(args.data.value, new Uint8Array([1]));
  assert.throws(() =>
    validateModel({ ...prismaModel, tenantField: 'id' }, prismaMetadata),
  );
  assert.throws(() =>
    validateModel({ ...prismaModel, model: 'constructor' }, prismaMetadata),
  );
});
