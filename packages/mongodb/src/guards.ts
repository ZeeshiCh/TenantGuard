/** Deliberately restricted JSON document API; BSON hooks and query expressions are not accepted. */
export class MongoSafetyError extends Error {}
export type MongoValue =
  | null
  | boolean
  | number
  | string
  | readonly MongoValue[]
  | { readonly [key: string]: MongoValue };
export interface MongoCollection {
  readonly collection: string;
  readonly tenantField: string;
  readonly idField: string;
  readonly fields: readonly string[];
}
export function identifier(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,119}$/.test(value) ||
    ['__proto__', 'prototype', 'constructor'].includes(value)
  )
    throw new MongoSafetyError('Invalid identifier');
  return value;
}
export function unicode(value: string): string {
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    throw new MongoSafetyError('Invalid Unicode');
  return value;
}
export function snapshot(input: unknown): MongoValue {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): MongoValue {
    if (++nodes > 10000 || depth > 20)
      throw new MongoSafetyError('Document too complex');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return unicode(value);
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER
    )
      return value;
    if (typeof value !== 'object' || !value || seen.has(value))
      throw new MongoSafetyError('Expected JSON data');
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((v) => visit(v, depth + 1));
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        throw new MongoSafetyError('Expected plain data');
      const result: Record<string, MongoValue> = {};
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(value),
      )) {
        identifier(key);
        if (!('value' in descriptor) || !descriptor.enumerable)
          throw new MongoSafetyError('Accessors are forbidden');
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  return visit(input, 0);
}
export function document(value: unknown): Record<string, MongoValue> {
  const result = snapshot(value);
  if (!result || Array.isArray(result) || typeof result !== 'object')
    throw new MongoSafetyError('Expected document');
  return result as Record<string, MongoValue>;
}
export function manifest(value: MongoCollection): MongoCollection {
  const fields = Object.freeze(value.fields.map(identifier));
  if (
    !fields.includes(identifier(value.tenantField)) ||
    !fields.includes(identifier(value.idField)) ||
    value.tenantField === value.idField ||
    value.tenantField === '_id' ||
    new Set(fields).size !== fields.length
  )
    throw new MongoSafetyError('Invalid collection fields');
  return Object.freeze({
    collection: identifier(value.collection),
    tenantField: value.tenantField,
    idField: value.idField,
    fields,
  });
}
export function fields(
  value: unknown,
  allowed: readonly string[],
): Record<string, MongoValue> {
  const data = document(value);
  if (Object.keys(data).some((k) => !allowed.includes(k)))
    throw new MongoSafetyError('Unknown field');
  return data;
}
export function equality(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields(value, allowed)).map(([k, v]) => [k, { $eq: v }]),
  );
}
export function owner(
  spec: MongoCollection,
  tenant: string,
  where: unknown = {},
): Record<string, unknown> {
  return {
    $and: [
      { [spec.tenantField]: { $eq: tenant } },
      {
        $expr: {
          $and: [
            { $eq: [{ $type: `$${spec.tenantField}` }, 'string'] },
            { $eq: [`$${spec.tenantField}`, { $literal: tenant }] },
          ],
        },
      },
      equality(where, spec.fields),
    ],
  };
}
export function projection(spec: MongoCollection): Record<string, number> {
  return { _id: 0, ...Object.fromEntries(spec.fields.map((k) => [k, 1])) };
}
export function bounded(value: unknown, fallback = 100, max = 1000): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > max)
    throw new MongoSafetyError('Invalid limit');
  return n;
}
export function sort(
  value: unknown,
  allowed: readonly string[],
): Record<string, 1 | -1> {
  const data = fields(value, allowed);
  if (
    !Object.keys(data).length ||
    Object.values(data).some((v) => v !== 1 && v !== -1)
  )
    throw new MongoSafetyError('Invalid sort');
  return data as Record<string, 1 | -1>;
}
/** Every permitted stage operates only on the already scoped input stream. */
export function pipeline(
  spec: MongoCollection,
  tenant: string,
  stages: readonly unknown[],
): Record<string, unknown>[] {
  if (!Array.isArray(stages) || stages.length > 20)
    throw new MongoSafetyError('Invalid pipeline');
  let available = [...spec.fields];
  const result: Record<string, unknown>[] = [
    { $match: owner(spec, tenant) },
    { $project: projection(spec) },
  ];
  for (const stage of stages) {
    if (
      !stage ||
      Object.getPrototypeOf(stage) !== Object.prototype ||
      Reflect.ownKeys(stage).length !== 1
    )
      throw new MongoSafetyError('Invalid stage');
    const [key] = Object.keys(stage);
    const descriptor = Object.getOwnPropertyDescriptor(stage, key!);
    if (!descriptor || !('value' in descriptor))
      throw new MongoSafetyError('Invalid stage');
    const value: unknown = descriptor.value;
    switch (key) {
      case '$match':
        result.push({ $match: equality(value, available) });
        break;
      case '$sort':
        result.push({ $sort: sort(value, available) });
        break;
      case '$limit':
        result.push({ $limit: bounded(value) });
        break;
      case '$skip':
        result.push({ $skip: bounded(value, 1, 100000) });
        break;
      case '$project': {
        const data = fields(value, available);
        if (
          !Object.keys(data).length ||
          Object.values(data).some((v) => v !== 1 && v !== true)
        )
          throw new MongoSafetyError(
            'Only inclusion projections are supported',
          );
        available = Object.keys(data);
        result.push({ $project: { _id: 0, ...data } });
        break;
      }
      case '$count': {
        if (typeof value !== 'string')
          throw new MongoSafetyError('Invalid count field');
        available = [identifier(value)];
        result.push({ $count: value });
        break;
      }
      case '$group': {
        if (!value || Object.getPrototypeOf(value) !== Object.prototype)
          throw new MongoSafetyError('Invalid group');
        const group: Record<string, unknown> = {};
        const reference = (v: unknown) => {
          if (
            typeof v === 'string' &&
            v.startsWith('$') &&
            available.includes(v.slice(1))
          )
            return v;
          if (v === null || (typeof v === 'number' && Number.isFinite(v)))
            return v;
          throw new MongoSafetyError('Invalid group expression');
        };
        for (const [field, d] of Object.entries(
          Object.getOwnPropertyDescriptors(value),
        )) {
          identifier(field);
          if (!('value' in d)) throw new MongoSafetyError('Invalid group');
          if (field === '_id') group[field] = reference(d.value);
          else {
            const acc = d.value;
            if (
              !acc ||
              Object.getPrototypeOf(acc) !== Object.prototype ||
              Object.keys(acc).length !== 1
            )
              throw new MongoSafetyError('Invalid accumulator');
            const op = Object.keys(acc)[0]!;
            const desc = Object.getOwnPropertyDescriptor(acc, op)!;
            if (
              !['$sum', '$avg', '$min', '$max'].includes(op) ||
              !('value' in desc)
            )
              throw new MongoSafetyError('Forbidden accumulator');
            group[field] = { [op]: reference(desc.value) };
          }
        }
        if (!Object.hasOwn(group, '_id'))
          throw new MongoSafetyError('Group requires _id');
        available = Object.keys(group);
        result.push({ $group: group });
        break;
      }
      default:
        throw new MongoSafetyError(`Forbidden aggregation stage ${key}`);
    }
  }
  result.push({ $limit: 1000 });
  return result;
}
