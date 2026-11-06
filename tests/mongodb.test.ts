import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  manifest,
  owner,
  pipeline,
  snapshot,
  MongoSafetyError,
} from '../packages/mongodb/src/guards.js';
const spec = manifest({
  collection: 'orders',
  tenantField: 'tenantId',
  idField: 'id',
  fields: ['id', 'tenantId', 'value'],
});
test('Mongo ownership requires scalar string equality and literal tenant values', () => {
  const filter = JSON.stringify(owner(spec, '$tenant'));
  assert.match(filter, /\$literal/);
  assert.match(filter, /\$type/);
});
test('Mongo pipelines allow bounded single-stream analytics only', () => {
  assert.equal(
    pipeline(spec, 'a', [
      { $group: { _id: '$value', total: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]).length,
    5,
  );
  for (const stage of [
    '$lookup',
    '$unionWith',
    '$graphLookup',
    '$out',
    '$merge',
    '$facet',
    '$documents',
    '$replaceRoot',
    '$function',
    '$search',
    '$changeStream',
  ])
    assert.throws(
      () => pipeline(spec, 'a', [{ [stage]: {} }]),
      MongoSafetyError,
    );
  for (const stage of [
    { $match: { $where: 'evil' } },
    { $group: { _id: '$$ROOT' } },
    { $group: { _id: null, all: { $push: '$value' } } },
    { $project: { value: '$tenantId' } },
  ])
    assert.throws(() => pipeline(spec, 'a', [stage]), MongoSafetyError);
});
test('Mongo data snapshots reject code hooks, operators, cycles and malformed unicode', () => {
  for (const value of [
    { $ne: 1 },
    { 'a.b': 1 },
    { toBSON: () => ({}) },
    new Date(),
    {
      get a() {
        throw Error('getter invoked');
      },
    },
    '\ud800',
  ])
    assert.throws(() => snapshot(value), MongoSafetyError);
  const cycle: unknown[] = [];
  cycle.push(cycle);
  assert.throws(() => snapshot(cycle), MongoSafetyError);
  const original = { nested: { a: 1 } };
  const copy = snapshot(original);
  original.nested.a = 2;
  assert.deepEqual(copy, { nested: { a: 1 } });
});
