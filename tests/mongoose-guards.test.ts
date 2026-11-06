import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMongooseModel,
  mongooseFields,
} from '../packages/mongoose/src/guards.js';
const definition = {
  collection: 'orders',
  tenantField: 'tenantId',
  idField: 'id',
  fields: {
    id: { type: 'string', required: true },
    tenantId: { type: 'string', required: true },
    value: { type: 'string', required: true },
  },
} as const;
test('Mongoose model declarations snapshot required scalar identity', () => {
  const model = validateMongooseModel(definition);
  assert.deepEqual(model.spec.fields, ['id', 'tenantId', 'value']);
  assert.ok(Object.isFrozen(model.fields));
  assert.deepEqual(mongooseFields({ id: 'a', value: 'v' }, model), {
    id: 'a',
    value: 'v',
  });
});
test('Mongoose declarations reject transforms, populate, hooks and unsupported schema features', () => {
  for (const extra of [
    { set: () => 'other' },
    { get: () => 'other' },
    { ref: 'Other' },
    { default: 'x' },
    { type: 'mixed' },
    { type: 'objectId' },
    { validate: () => true },
    { alias: 'other' },
  ])
    assert.throws(() =>
      validateMongooseModel({
        ...definition,
        fields: {
          ...definition.fields,
          value: { type: 'string', ...extra } as never,
        },
      }),
    );
  assert.throws(() =>
    validateMongooseModel({
      ...definition,
      fields: {
        ...definition.fields,
        tenantId: { type: 'number', required: true },
      },
    }),
  );
  assert.throws(() =>
    validateMongooseModel({
      ...definition,
      fields: { ...definition.fields, _id: { type: 'string' } },
    }),
  );
  assert.throws(() =>
    validateMongooseModel({ ...definition, pre: () => {} } as never),
  );
});
test('Mongoose scalar filters reject casts, nested operators and accessors', () => {
  const model = validateMongooseModel(definition);
  for (const data of [
    { id: 7 },
    { id: { $ne: 'x' } },
    { id: ['a'] },
    {
      get id(): never {
        throw Error('getter executed');
      },
    },
    { $where: 'evil' },
  ])
    assert.throws(() => mongooseFields(data as never, model));
});
