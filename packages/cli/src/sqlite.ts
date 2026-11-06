import { DatabaseSync } from 'node:sqlite';
import { stat } from 'node:fs/promises';
import type { ResolvedSource } from './config.js';
import type { Observer } from './inspection.js';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
export async function inspectSqlite(
  source: ResolvedSource,
  out: Observer,
): Promise<void> {
  if (!(await stat(source.filename!)).isFile())
    throw new Error('Not an ordinary file');
  const db = new DatabaseSync(source.filename!, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    for (const target of source.targets) {
      const table = db
        .prepare('SELECT type,sql FROM sqlite_schema WHERE name=?')
        .get(target.table);
      if (!table) {
        out.unknown(
          'SQLITE.TARGET_UNAVAILABLE',
          'Configured table is absent from the main schema.',
          target,
        );
        continue;
      }
      const kind = db
        .prepare('PRAGMA main.table_list')
        .all()
        .find(
          (row) => row.schema === 'main' && row.name === target.table,
        )?.type;
      if (
        kind !== 'table' ||
        table.type !== 'table' ||
        typeof table.sql !== 'string' ||
        /^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql)
      ) {
        out.add(
          'SQLITE.ORDINARY_TABLE',
          'error',
          'Views and virtual tables are not supported scoped CRUD targets.',
          target,
        );
        continue;
      }
      const columns = db
        .prepare(`PRAGMA main.table_xinfo(${quote(target.table)})`)
        .all();
      const tenant = columns.find((row) => row.name === target.tenantColumn);
      if (
        !tenant ||
        tenant.notnull !== 1 ||
        String(tenant.type).toUpperCase() !== 'TEXT' ||
        tenant.hidden !== 0
      )
        out.add(
          'SQLITE.TENANT_COLUMN',
          'error',
          'Tenant ownership requires an ordinary NOT NULL TEXT column.',
          target,
        );
      const indexes = db
        .prepare(`PRAGMA main.index_list(${quote(target.table)})`)
        .all();
      let tenantIndex = false;
      for (const index of indexes) {
        if (typeof index.name !== 'string') continue;
        const fields = db
          .prepare(`PRAGMA main.index_xinfo(${quote(index.name)})`)
          .all();
        if (
          fields.some(
            (row) =>
              row.seqno === 0 &&
              row.name === target.tenantColumn &&
              row.coll === 'BINARY',
          )
        )
          tenantIndex = true;
      }
      if (!tenantIndex)
        out.add(
          'SQLITE.TENANT_INDEX',
          'warning',
          'No tenant-leading binary index was observed; confirm tenant-aware constraints.',
          target,
        );
      out.add(
        'SQLITE.CATALOG_OBSERVED',
        'info',
        'Existing main-schema file was inspected through a read-only connection.',
        target,
      );
    }
    out.add(
      'SQLITE.PRIVILEGES_UNVERIFIED',
      'info',
      'SQLite has no server role/RLS boundary; filesystem permissions and scoped application access remain required.',
    );
  } finally {
    db.close();
  }
}
