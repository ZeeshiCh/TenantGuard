import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export const sqliteTables = {
  orders: {
    table: 'orders',
    tenantColumn: 'tenant_id',
    idColumn: 'id',
    columns: ['id', 'tenant_id', 'value'],
  },
};
export const sqliteTenantA = { tenantId: 'Org_A' },
  sqliteTenantB = { tenantId: 'org_a' };
export async function sqliteFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tenantguard-sqlite-')),
    filename = join(directory, 'test.db');
  const admin = new DatabaseSync(filename);
  admin.exec(
    'PRAGMA foreign_keys=ON; CREATE TABLE orders(id TEXT NOT NULL,tenant_id TEXT COLLATE NOCASE NOT NULL,value TEXT); CREATE UNIQUE INDEX orders_owner_id ON orders(tenant_id COLLATE BINARY,id)',
  );
  return {
    filename,
    admin,
    async seed() {
      admin.exec('DELETE FROM orders');
      const insert = admin.prepare('INSERT INTO orders VALUES(?,?,?)');
      insert.run('seed-a', sqliteTenantA.tenantId, 'a');
      insert.run('seed-b', sqliteTenantB.tenantId, 'b');
    },
    async close() {
      admin.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
