// Private worker protocol. Neither the connection nor this transport is exposed by the facade.
import { parentPort, workerData } from 'node:worker_threads';
import { openSync, closeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
let db;
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function settings() {
  check(
    db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1,
    'Foreign keys must be enabled',
  );
  check(
    db.prepare('PRAGMA trusted_schema').get().trusted_schema === 0,
    'Trusted schema must be disabled',
  );
  check(
    db.prepare('PRAGMA read_uncommitted').get().read_uncommitted === 0,
    'Dirty reads are forbidden',
  );
  check(
    ['delete', 'truncate', 'persist', 'wal'].includes(
      db.prepare('PRAGMA journal_mode').get().journal_mode,
    ),
    'Unsafe SQLite journal mode',
  );
  check(
    db
      .prepare('PRAGMA database_list')
      .all()
      .every((row) => ['main', 'temp'].includes(row.name)),
    'Attached databases are forbidden',
  );
}
function initialize(tables) {
  check(!db, 'SQLite connection already opened');
  // r+ prevents accidentally provisioning a missing database. Paths/DDL remain trusted infrastructure.
  const fd = openSync(workerData.filename, 'r+');
  closeSync(fd);
  db = new DatabaseSync(workerData.filename, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: workerData.busyTimeoutMs,
  });
  check(
    typeof db.isTransaction === 'boolean',
    'SQLite requires Node.js >=22.16',
  );
  db.exec(
    'PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA read_uncommitted=OFF; PRAGMA synchronous=FULL; PRAGMA recursive_triggers=ON',
  );
  settings();
  check(!db.isTransaction, 'Unexpected initial transaction');
  db.exec('BEGIN IMMEDIATE');
  for (const spec of tables) {
    const info = db
      .prepare(
        "SELECT type FROM pragma_table_list WHERE schema='main' AND name=?",
      )
      .all(spec.table);
    check(
      info.length === 1 && info[0].type === 'table',
      'Only existing ordinary SQLite tables are supported',
    );
    const columns = db
      .prepare(
        'SELECT name,type,"notnull",hidden FROM pragma_table_xinfo(?,\'main\')',
      )
      .all(spec.table);
    const tenant = columns.find((column) => column.name === spec.tenantColumn);
    check(
      tenant &&
        tenant.type.toUpperCase() === 'TEXT' &&
        tenant.notnull === 1 &&
        tenant.hidden === 0,
      'Tenant column must be ordinary TEXT NOT NULL',
    );
    check(
      spec.columns.every((name) =>
        columns.some((column) => column.name === name && column.hidden === 0),
      ),
      'Unregistered or generated SQLite columns',
    );
  }
  return {
    version: db.prepare('SELECT sqlite_version() AS version').get().version,
  };
}
parentPort.on('message', ({ id, command, data }) => {
  try {
    let value;
    switch (command) {
      case 'begin':
        value = initialize(data);
        break;
      case 'execute': {
        check(db?.isTransaction, 'SQLite transaction ended unexpectedly');
        const statement = db.prepare(data.text);
        statement.setAllowBareNamedParameters(false);
        statement.setReadBigInts(true);
        const values = data.values.map((value) =>
          typeof value === 'boolean'
            ? value
              ? 1n
              : 0n
            : value instanceof Date
              ? value.toISOString()
              : value,
        );
        value = data.read
          ? { rows: statement.all(...values), changes: 0 }
          : { rows: [], changes: Number(statement.run(...values).changes) };
        break;
      }
      case 'commit':
        check(db?.isTransaction, 'SQLite transaction ended unexpectedly');
        settings();
        db.exec('COMMIT');
        check(!db.isTransaction, 'Commit left an active transaction');
        value = true;
        break;
      case 'cleanup':
        if (db) {
          if (db.isTransaction) db.exec('ROLLBACK');
          check(!db.isTransaction, 'Rollback left an active transaction');
          settings();
          db.close();
          db = undefined;
        }
        value = true;
        break;
      default:
        throw new Error('Unknown SQLite worker command');
    }
    parentPort.postMessage({ id, value });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        message: error.message,
        code: error.code,
        errcode: error.errcode,
        transaction: db?.isTransaction ?? false,
      },
    });
  }
});
