import { validateTenantId } from '@tenantguard/core';
export type ScopedSqlValue =
  string | number | boolean | bigint | Date | Uint8Array | null;
export type ScopedSqlFilter = Readonly<Record<string, ScopedSqlValue>>;
export interface ScopedSqlTable {
  readonly table: string;
  readonly tenantColumn: string;
  readonly idColumn: string;
  readonly columns: readonly string[];
}
export interface ScopedSqlFindOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: {
    readonly column: string;
    readonly direction: 'asc' | 'desc';
  };
}
export interface ScopedSqlStatement {
  readonly text: string;
  readonly values: readonly ScopedSqlValue[];
}
export function quoteScopedSqlIdentifier(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value) ||
    value.length > 64
  )
    throw new TypeError('Invalid scoped SQL identifier');
  return '`' + value + '`';
}
export function validateUtf8Text(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new TypeError(
          'Unpaired UTF-16 surrogate cannot be encoded as UTF-8',
        );
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new TypeError(
        'Unpaired UTF-16 surrogate cannot be encoded as UTF-8',
      );
  }
}
export function snapshotSqlValue(value: ScopedSqlValue): ScopedSqlValue {
  if (typeof value === 'string') {
    validateUtf8Text(value);
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return value;
  if (typeof value === 'bigint' && value >= -(2n ** 63n) && value < 2n ** 63n)
    return value;
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return new Date(value.getTime());
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new TypeError('Unsupported scoped SQL value');
}
export function validateScopedSqlTable(
  input: ScopedSqlTable,
): Readonly<ScopedSqlTable> {
  for (const name of [
    input.table,
    input.tenantColumn,
    input.idColumn,
    ...input.columns,
  ])
    quoteScopedSqlIdentifier(name);
  if (
    !input.columns.length ||
    new Set(input.columns).size !== input.columns.length ||
    !input.columns.includes(input.tenantColumn) ||
    !input.columns.includes(input.idColumn) ||
    input.idColumn === input.tenantColumn
  )
    throw new TypeError(
      'Declare distinct ID/tenant columns and unique allowed columns',
    );
  return Object.freeze({
    table: input.table,
    tenantColumn: input.tenantColumn,
    idColumn: input.idColumn,
    columns: Object.freeze([...input.columns]),
  });
}
/** Generates only known CRUD grammar. Never accepts SQL fragments, expressions or operators. */
export function createScopedSqlCompiler(
  database: string,
  input: ScopedSqlTable,
  tenantId: string,
  options: { readonly dialect?: 'mysql' | 'sqlite' } = {},
) {
  const dialect = options.dialect ?? 'mysql';
  if (!['mysql', 'sqlite'].includes(dialect))
    throw new TypeError('Unsupported SQL dialect');
  const quote = (name: string) => {
    quoteScopedSqlIdentifier(name);
    return dialect === 'sqlite'
      ? '"' + name + '"'
      : quoteScopedSqlIdentifier(name);
  };
  quote(database);
  validateTenantId(tenantId);
  validateUtf8Text(tenantId);
  const table = validateScopedSqlTable(input),
    target = `${quote(database)}.${quote(table.table)}`;
  const allowed = new Set(table.columns),
    tenant = quote(table.tenantColumn);
  const entries = (value: ScopedSqlFilter) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('Expected a column/value object');
    return Object.entries(value).map(([column, value]) => {
      if (!allowed.has(column))
        throw new TypeError(`Unregistered column: ${column}`);
      return [column, snapshotSqlValue(value)] as const;
    });
  };
  const predicate = (where: ScopedSqlFilter, writing = false) => {
    const pairs = entries(where);
    if (writing && !pairs.some(([column]) => column !== table.tenantColumn))
      throw new TypeError('Writes require a non-tenant equality filter');
    // Ordinary equality can use an index; BINARY equality additionally defeats case/PAD SPACE collation aliasing.
    const clauses =
        dialect === 'sqlite'
          ? [`typeof(${tenant}) = 'text'`, `${tenant} COLLATE BINARY = ?`]
          : [`${tenant} = ?`, `BINARY ${tenant} = BINARY ?`],
      values: ScopedSqlValue[] =
        dialect === 'sqlite' ? [tenantId] : [tenantId, tenantId];
    for (const [column, value] of pairs) {
      const name = quote(column);
      if (value === null) clauses.push(`${name} IS NULL`);
      else {
        clauses.push(
          column === table.tenantColumn
            ? dialect === 'sqlite'
              ? `${name} COLLATE BINARY = ?`
              : `BINARY ${name} = BINARY ?`
            : `${name} = ?`,
        );
        values.push(value);
      }
    }
    return { text: clauses.join(' AND '), values };
  };
  const statement = (
    text: string,
    values: ScopedSqlValue[],
  ): ScopedSqlStatement =>
    Object.freeze({ text, values: Object.freeze(values) });
  return Object.freeze({
    table,
    find(
      where: ScopedSqlFilter = {},
      options: ScopedSqlFindOptions = {},
    ): ScopedSqlStatement {
      const limit = options.limit ?? 100,
        offset = options.offset ?? 0;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 2147483647
      )
        throw new TypeError('Invalid pagination bounds');
      const order = options.orderBy ?? {
        column: table.idColumn,
        direction: 'asc',
      };
      if (
        !allowed.has(order.column) ||
        !['asc', 'desc'].includes(order.direction)
      )
        throw new TypeError('Invalid order column/direction');
      const filter = predicate(where);
      return statement(
        `SELECT ${table.columns.map(quote).join(', ')} FROM ${target} WHERE ${filter.text} ORDER BY ${quote(order.column)} ${order.direction.toUpperCase()} LIMIT ${limit} OFFSET ${offset}`,
        filter.values,
      );
    },
    insert(row: ScopedSqlFilter): ScopedSqlStatement {
      const pairs = entries(row);
      const supplied = pairs.find(([column]) => column === table.tenantColumn);
      if (supplied && supplied[1] !== tenantId)
        throw new TypeError('Cannot insert another tenant identity');
      const data = pairs.filter(([column]) => column !== table.tenantColumn);
      data.push([table.tenantColumn, tenantId]);
      return statement(
        `INSERT INTO ${target} (${data.map(([column]) => quoteScopedSqlIdentifier(column)).join(', ')}) VALUES (${data.map(() => '?').join(', ')})`,
        data.map(([, value]) => value),
      );
    },
    update(
      where: ScopedSqlFilter,
      changes: ScopedSqlFilter,
    ): ScopedSqlStatement {
      const data = entries(changes);
      if (
        !data.length ||
        data.some(
          ([column]) =>
            column === table.tenantColumn || column === table.idColumn,
        )
      )
        throw new TypeError(
          'ID and tenant columns are immutable; supply writable changes',
        );
      const filter = predicate(where, true);
      return statement(
        `UPDATE ${target} SET ${data.map(([column]) => `${quote(column)} = ?`).join(', ')} WHERE ${filter.text}`,
        [...data.map(([, value]) => value), ...filter.values],
      );
    },
    delete(where: ScopedSqlFilter): ScopedSqlStatement {
      const filter = predicate(where, true);
      return statement(
        `DELETE FROM ${target} WHERE ${filter.text}`,
        filter.values,
      );
    },
  });
}
