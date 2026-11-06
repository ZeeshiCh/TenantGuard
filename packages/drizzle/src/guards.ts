import {
  Column,
  SQL,
  and,
  eq,
  is,
  isNull,
  sql,
  getTableColumns,
  type SQLWrapper,
} from 'drizzle-orm';
import { PgTable, getTableConfig as pgConfig } from 'drizzle-orm/pg-core';
import {
  MySqlTable,
  getTableConfig as mysqlConfig,
} from 'drizzle-orm/mysql-core';
import {
  snapshotSqlValue,
  type ScopedSqlValue,
  validateUtf8Text,
} from '@tenantguard/scoped-sql/compiler';
export class DrizzleSafetyError extends Error {}
export type DrizzleValue = ScopedSqlValue;
export type DrizzleFilter = Readonly<Record<string, DrizzleValue>>;
export interface DrizzleTable {
  readonly table: object;
  readonly tenantColumn: string;
  readonly idColumn: string;
  readonly columns: readonly string[];
}
export interface DrizzleFindOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: {
    readonly column: string;
    readonly direction: 'asc' | 'desc';
  };
}
export interface ValidatedDrizzleTable extends Omit<DrizzleTable, 'table'> {
  readonly table: PgTable | MySqlTable;
  readonly provider: 'postgresql' | 'mysql';
  readonly name: string;
  readonly schema: string;
  readonly fields: Readonly<Record<string, Column>>;
  readonly tenantName: string;
}
export function identifier(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value) ||
    ['__proto__', 'prototype', 'constructor'].includes(value)
  )
    throw new DrizzleSafetyError('Invalid Drizzle identifier');
  return value;
}
export function validateDrizzleTable(
  input: DrizzleTable,
): ValidatedDrizzleTable {
  let provider: 'postgresql' | 'mysql', name: string, schema: string;
  if (is(input.table, PgTable)) {
    provider = 'postgresql';
    const config = pgConfig(input.table);
    name = config.name;
    schema = config.schema ?? 'public';
  } else if (is(input.table, MySqlTable)) {
    provider = 'mysql';
    const config = mysqlConfig(input.table);
    if (config.schema !== undefined)
      throw new DrizzleSafetyError(
        'Cross-database Drizzle table schemas are unsupported',
      );
    name = config.name;
    schema = '';
  } else
    throw new DrizzleSafetyError(
      'Only PostgreSQL and MySQL Drizzle tables are supported',
    );
  identifier(name);
  if (schema) identifier(schema);
  const all = getTableColumns(input.table) as Record<string, Column>,
    keys = Object.freeze(input.columns.map(identifier));
  if (
    !keys.length ||
    new Set(keys).size !== keys.length ||
    !keys.includes(input.tenantColumn) ||
    !keys.includes(input.idColumn) ||
    input.tenantColumn === input.idColumn
  )
    throw new DrizzleSafetyError(
      'Declare distinct tenant/ID and unique columns',
    );
  // Drizzle can execute runtime defaults/hooks even for columns omitted by the application.
  for (const column of Object.values(all))
    if (
      !is(column, Column) ||
      column.defaultFn ||
      column.onUpdateFn ||
      column.generated ||
      column.generatedIdentity ||
      is(column.default, SQL) ||
      column.columnType.includes('Custom')
    )
      throw new DrizzleSafetyError(
        'Runtime hooks, custom/generated columns and SQL defaults are unsupported',
      );
  const fields: Record<string, Column> = {};
  for (const key of keys) {
    const column = all[key];
    if (
      !column ||
      !['string', 'number', 'bigint', 'boolean', 'date', 'buffer'].includes(
        column.dataType,
      ) ||
      /Json|Array|Enum|Numeric|Decimal/.test(column.columnType)
    )
      throw new DrizzleSafetyError(
        'Only declared standard scalar columns are supported',
      );
    identifier(column.name);
    fields[key] = column;
  }
  for (const key of [input.tenantColumn, input.idColumn])
    if (fields[key]!.dataType !== 'string' || !fields[key]!.notNull)
      throw new DrizzleSafetyError(
        'Tenant and ID columns must be required strings',
      );
  return Object.freeze({
    table: input.table as PgTable | MySqlTable,
    tenantColumn: input.tenantColumn,
    idColumn: input.idColumn,
    columns: keys,
    provider,
    name,
    schema,
    fields: Object.freeze(fields),
    tenantName: fields[input.tenantColumn]!.name,
  });
}
export function scalarFields(
  input: DrizzleFilter,
  spec: ValidatedDrizzleTable,
): Record<string, DrizzleValue> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    throw new DrizzleSafetyError('Expected scalar data');
  const data: Record<string, DrizzleValue> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !spec.columns.includes(key))
      throw new DrizzleSafetyError('Unknown column or query expression');
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable)
      throw new DrizzleSafetyError('Accessors are forbidden');
    data[key] = snapshotSqlValue(descriptor.value);
  }
  return data;
}
export function drizzleCompiler(spec: ValidatedDrizzleTable, tenantId: string) {
  validateUtf8Text(tenantId);
  const owner = spec.fields[spec.tenantColumn]!;
  const predicate = (input: DrizzleFilter = {}, writing = false): SQL => {
    const data = scalarFields(input, spec);
    if (writing && !Object.keys(data).some((k) => k !== spec.tenantColumn))
      throw new DrizzleSafetyError('Writes require a non-tenant filter');
    const exact =
      spec.provider === 'postgresql'
        ? sql`${owner} COLLATE "C" = ${tenantId}`
        : sql`BINARY ${owner} = BINARY ${tenantId}`;
    const clauses = [
      eq(owner, tenantId),
      exact,
      ...Object.entries(data).map(([key, value]) =>
        value === null
          ? isNull(spec.fields[key]!)
          : eq(spec.fields[key]!, value),
      ),
    ];
    return and(...clauses)!;
  };
  return Object.freeze({
    find(input: DrizzleFilter = {}, options: DrizzleFindOptions = {}) {
      if (
        !options ||
        typeof options !== 'object' ||
        Object.keys(options).some(
          (k) => !['limit', 'offset', 'orderBy'].includes(k),
        )
      )
        throw new DrizzleSafetyError('Unsupported find options');
      const limit = options.limit ?? 100,
        offset = options.offset ?? 0,
        order = options.orderBy ?? { column: spec.idColumn, direction: 'asc' };
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 2147483647 ||
        !spec.columns.includes(order.column) ||
        !['asc', 'desc'].includes(order.direction) ||
        Object.keys(order).some((k) => !['column', 'direction'].includes(k))
      )
        throw new DrizzleSafetyError('Invalid pagination/order');
      return {
        where: predicate(input),
        limit,
        offset,
        order: spec.fields[order.column]! as SQLWrapper,
        direction: order.direction,
      };
    },
    insert(input: DrizzleFilter) {
      const data = scalarFields(input, spec);
      if (
        Object.hasOwn(data, spec.tenantColumn) &&
        data[spec.tenantColumn] !== tenantId
      )
        throw new DrizzleSafetyError('Foreign tenant insert');
      if (!Object.hasOwn(data, spec.idColumn))
        throw new DrizzleSafetyError('ID required');
      data[spec.tenantColumn] = tenantId;
      return data;
    },
    update(input: DrizzleFilter, changes: DrizzleFilter) {
      const data = scalarFields(changes, spec);
      if (
        !Object.keys(data).length ||
        Object.hasOwn(data, spec.tenantColumn) ||
        Object.hasOwn(data, spec.idColumn)
      )
        throw new DrizzleSafetyError('Tenant and ID columns are immutable');
      return { where: predicate(input, true), data };
    },
    delete(input: DrizzleFilter) {
      return predicate(input, true);
    },
  });
}
