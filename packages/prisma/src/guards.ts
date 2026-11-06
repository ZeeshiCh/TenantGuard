import {
  snapshotSqlValue,
  type ScopedSqlValue,
} from '@tenantguard/scoped-sql/compiler';
export type PrismaValue = ScopedSqlValue;
export type PrismaFilter = Readonly<Record<string, PrismaValue>>;
export interface PrismaFieldMetadata {
  readonly name: string;
  readonly dbName?: string | null;
  readonly kind: string;
  readonly type: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
}
export interface PrismaModelMetadata {
  readonly name: string;
  readonly dbName?: string | null;
  readonly schema?: string | null;
  readonly fields: readonly PrismaFieldMetadata[];
}
export interface PrismaDatamodel {
  readonly models: readonly PrismaModelMetadata[];
}
export interface PrismaModel {
  readonly model: string;
  readonly tenantField: string;
  readonly idField: string;
  readonly fields: readonly string[];
}
export interface PrismaFindOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: {
    readonly field: string;
    readonly direction: 'asc' | 'desc';
  };
}
export class PrismaSafetyError extends Error {}
export function identifier(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    throw new PrismaSafetyError('Invalid Prisma identifier');
  return value;
}
export interface ValidatedModel extends PrismaModel {
  readonly delegate: string;
  readonly table: string;
  readonly schema: string;
  readonly tenantColumn: string;
}
export function validateModel(
  input: PrismaModel,
  datamodel: PrismaDatamodel,
): ValidatedModel {
  identifier(input.model);
  identifier(input.tenantField);
  identifier(input.idField);
  const fields = Object.freeze(input.fields.map(identifier));
  const model = datamodel.models.find((m) => m.name === input.model);
  if (
    !model ||
    !fields.length ||
    new Set(fields).size !== fields.length ||
    !fields.includes(input.tenantField) ||
    !fields.includes(input.idField) ||
    input.tenantField === input.idField
  )
    throw new PrismaSafetyError(
      'Declare a valid scalar model with distinct tenant and ID fields',
    );
  for (const name of fields) {
    const field = model.fields.find((f) => f.name === name);
    if (
      !field ||
      field.kind !== 'scalar' ||
      field.isList ||
      ![
        'String',
        'Int',
        'BigInt',
        'Float',
        'Boolean',
        'DateTime',
        'Bytes',
      ].includes(field.type)
    )
      throw new PrismaSafetyError(
        'Only declared scalar fields are supported; relations, lists, JSON and Decimal are forbidden',
      );
  }
  for (const name of [input.tenantField, input.idField]) {
    const field = model.fields.find((f) => f.name === name)!;
    if (field.type !== 'String' || !field.isRequired)
      throw new PrismaSafetyError(
        'Tenant and ID must be required String fields',
      );
  }
  const tenant = model.fields.find((f) => f.name === input.tenantField)!;
  return Object.freeze({
    model: input.model,
    tenantField: input.tenantField,
    idField: input.idField,
    fields,
    delegate: identifier(input.model[0]!.toLowerCase() + input.model.slice(1)),
    table: identifier(model.dbName ?? model.name),
    schema: identifier(model.schema ?? 'public'),
    tenantColumn: identifier(tenant.dbName ?? tenant.name),
  });
}
export function scalarFields(
  input: PrismaFilter,
  model: PrismaModel,
): Record<string, PrismaValue> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    throw new PrismaSafetyError('Expected scalar field data');
  const data: Record<string, PrismaValue> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !model.fields.includes(key))
      throw new PrismaSafetyError('Unknown or relation field');
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable)
      throw new PrismaSafetyError('Accessors are forbidden');
    data[key] = snapshotSqlValue(descriptor.value);
  }
  return data;
}
export function prismaCompiler(model: ValidatedModel, tenantId: string) {
  const select = Object.freeze(
    Object.fromEntries(model.fields.map((field) => [field, true])),
  );
  const where = (input: PrismaFilter = {}, write = false) => {
    const data = scalarFields(input, model);
    if (write && !Object.keys(data).some((key) => key !== model.tenantField))
      throw new PrismaSafetyError('Writes require a non-tenant filter');
    return {
      AND: [
        { [model.tenantField]: { equals: tenantId } },
        ...Object.entries(data).map(([key, value]) => ({
          [key]: { equals: value },
        })),
      ],
    };
  };
  return Object.freeze({
    find(input: PrismaFilter = {}, options: PrismaFindOptions = {}) {
      if (
        !options ||
        typeof options !== 'object' ||
        Object.keys(options).some(
          (k) => !['limit', 'offset', 'orderBy'].includes(k),
        )
      )
        throw new PrismaSafetyError('Unsupported find option');
      const take = options.limit ?? 100,
        skip = options.offset ?? 0,
        order = options.orderBy ?? { field: model.idField, direction: 'asc' };
      if (
        !Number.isSafeInteger(take) ||
        take < 1 ||
        take > 1000 ||
        !Number.isSafeInteger(skip) ||
        skip < 0 ||
        skip > 2147483647 ||
        !model.fields.includes(order.field) ||
        !['asc', 'desc'].includes(order.direction) ||
        Object.keys(order).some((k) => !['field', 'direction'].includes(k))
      )
        throw new PrismaSafetyError('Invalid pagination/order');
      return {
        where: where(input),
        select: { ...select },
        take,
        skip,
        orderBy: { [order.field]: order.direction },
      };
    },
    create(input: PrismaFilter) {
      const data = scalarFields(input, model);
      if (
        Object.hasOwn(data, model.tenantField) &&
        data[model.tenantField] !== tenantId
      )
        throw new PrismaSafetyError('Foreign tenant insert');
      if (!Object.hasOwn(data, model.idField))
        throw new PrismaSafetyError('ID required');
      data[model.tenantField] = tenantId;
      return { data, select: { ...select } };
    },
    update(input: PrismaFilter, changes: PrismaFilter) {
      const data = scalarFields(changes, model);
      if (
        !Object.keys(data).length ||
        Object.hasOwn(data, model.tenantField) ||
        Object.hasOwn(data, model.idField)
      )
        throw new PrismaSafetyError('Tenant and ID fields are immutable');
      return { where: where(input, true), data };
    },
    delete(input: PrismaFilter) {
      return { where: where(input, true) };
    },
  });
}
