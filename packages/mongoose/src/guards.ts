import {
  MongoSafetyError,
  identifier,
  manifest,
  fields,
  type MongoCollection,
} from '@tenantguard/scoped-mongo';
export { MongoSafetyError as MongooseSafetyError } from '@tenantguard/scoped-mongo';
export type MongooseValue = string | number | boolean | null;
export type MongooseFilter = Readonly<Record<string, MongooseValue>>;
export interface MongooseField {
  readonly type: 'string' | 'number' | 'boolean';
  readonly required?: boolean;
}
export interface MongooseModel {
  readonly collection: string;
  readonly tenantField: string;
  readonly idField: string;
  readonly fields: Readonly<Record<string, MongooseField>>;
}
export interface MongooseFindOptions {
  readonly limit?: number;
  readonly sort?: Readonly<Record<string, 1 | -1>>;
}
export interface ValidatedMongooseModel {
  readonly spec: MongoCollection;
  readonly fields: Readonly<Record<string, MongooseField>>;
}
function plain(value: unknown): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new MongoSafetyError('Expected plain Mongoose declaration');
}
export function validateMongooseModel(
  input: MongooseModel,
): ValidatedMongooseModel {
  plain(input);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(input),
  ))
    if (!('value' in descriptor))
      throw new MongoSafetyError('Accessors are forbidden');
  if (
    Object.keys(input).some(
      (key) =>
        !['collection', 'tenantField', 'idField', 'fields'].includes(key),
    )
  )
    throw new MongoSafetyError('Unsupported model option');
  plain(input.fields);
  const declared: Record<string, MongooseField> = {};
  for (const key of Reflect.ownKeys(input.fields)) {
    if (typeof key !== 'string') throw new MongoSafetyError('Invalid field');
    identifier(key);
    if (['_id', '__v'].includes(key))
      throw new MongoSafetyError('Reserved Mongoose field');
    const descriptor = Object.getOwnPropertyDescriptor(input.fields, key)!;
    if (!('value' in descriptor))
      throw new MongoSafetyError('Accessors are forbidden');
    const options: unknown = descriptor.value;
    plain(options);
    for (const value of Object.values(
      Object.getOwnPropertyDescriptors(options),
    ))
      if (!('value' in value))
        throw new MongoSafetyError('Accessors are forbidden');
    if (
      Reflect.ownKeys(options).some(
        (option) => !['type', 'required'].includes(String(option)),
      ) ||
      !['string', 'number', 'boolean'].includes(options.type as string) ||
      (options.required !== undefined && typeof options.required !== 'boolean')
    )
      throw new MongoSafetyError(
        'Only scalar type/required declarations are supported; hooks, refs and transforms are forbidden',
      );
    for (const value of Object.values(
      Object.getOwnPropertyDescriptors(options),
    ))
      if (!('value' in value))
        throw new MongoSafetyError('Accessors are forbidden');
    declared[key] = Object.freeze({
      type: options.type as MongooseField['type'],
      required: options.required === true,
    });
  }
  const spec = manifest({ ...input, fields: Object.keys(declared) });
  for (const key of [spec.tenantField, spec.idField])
    if (declared[key]?.type !== 'string' || !declared[key]?.required)
      throw new MongoSafetyError(
        'Tenant and ID must be required string fields',
      );
  return Object.freeze({ spec, fields: Object.freeze(declared) });
}
/** Reject implicit Mongoose coercion before creating any query. */
export function mongooseFields(
  input: MongooseFilter,
  model: ValidatedMongooseModel,
): Record<string, MongooseValue> {
  const data = fields(input, model.spec.fields);
  for (const [key, value] of Object.entries(data)) {
    const definition = model.fields[key]!;
    if (value !== null && typeof value !== definition.type)
      throw new MongoSafetyError(
        'Mongoose scalar types must match declarations',
      );
    if (value !== null && typeof value === 'object')
      throw new MongoSafetyError('Nested data is unsupported');
  }
  return data as Record<string, MongooseValue>;
}
