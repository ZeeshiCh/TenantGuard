import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import {
  createDrizzlePgResource,
  createDrizzleMysqlResource,
} from '../../packages/drizzle/src/index.js';
import { postgresFixture } from './postgres.js';
import { mysqlFamilyFixture, type MysqlFamilyEngine } from './mysql-family.js';
export const drizzlePgOrders = pgTable('orders', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  value: text('value').notNull(),
});
export const drizzleMysqlOrders = mysqlTable('orders', {
  id: varchar('id', { length: 64 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 256 }).notNull(),
  value: varchar('value', { length: 256 }).notNull(),
});
export const drizzleDefinition = {
  tenantColumn: 'tenantId',
  idColumn: 'id',
  columns: ['id', 'tenantId', 'value'],
};
export const drizzleTenantA = { tenantId: 'Org_A' },
  drizzleTenantB = { tenantId: 'org_a' };
export async function drizzleFixture(engine: 'postgresql' | MysqlFamilyEngine) {
  if (engine === 'postgresql') {
    const db = await postgresFixture();
    try {
      await db.admin.query(
        'DROP TABLE public.orders;CREATE TABLE public.orders(id text PRIMARY KEY,tenant_id text NOT NULL,value text NOT NULL);GRANT SELECT,INSERT,UPDATE,DELETE ON public.orders TO app',
      );
      const resource = createDrizzlePgResource({ connection: db.config });
      return {
        resource,
        engine,
        tables: { orders: { table: drizzlePgOrders, ...drizzleDefinition } },
        async seed() {
          await db.admin.query('TRUNCATE public.orders');
          await db.admin.query(
            'INSERT INTO public.orders VALUES($1,$2,$3),($4,$5,$6)',
            [
              'seed-a',
              drizzleTenantA.tenantId,
              'a',
              'seed-b',
              drizzleTenantB.tenantId,
              'b',
            ],
          );
        },
        async rawCount(id: string) {
          return Number(
            (
              await db.admin.query(
                'SELECT count(*) AS n FROM orders WHERE id=$1',
                [id],
              )
            ).rows[0].n,
          );
        },
        async execute(sql: string) {
          await db.admin.query(sql);
        },
        async connections() {
          return Number(
            (
              await db.admin.query(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE usename='app'",
              )
            ).rows[0].n,
          );
        },
        async nativeRead() {
          const client = new pg.Client(db.config);
          try {
            await client.connect();
            return await pgDrizzle(client).select().from(drizzlePgOrders);
          } finally {
            await client.end();
          }
        },
        async close() {
          await resource.close();
          await db.close();
        },
      };
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  const db = await mysqlFamilyFixture(engine),
    resource = createDrizzleMysqlResource({ connection: db.appConfig });
  return {
    resource,
    engine,
    tables: { orders: { table: drizzleMysqlOrders, ...drizzleDefinition } },
    seed: db.seed,
    async rawCount(id: string) {
      const [rows] = await db.admin.execute<
        import('mysql2/promise').RowDataPacket[]
      >('SELECT count(*) AS n FROM orders WHERE id=?', [id]);
      return Number(rows[0]!.n);
    },
    async execute(sql: string) {
      await db.admin.query(sql);
    },
    async connections() {
      const [rows] = await db.admin.query<
        import('mysql2/promise').RowDataPacket[]
      >(
        "SELECT count(*) AS n FROM information_schema.PROCESSLIST WHERE USER='tenantguard_app'",
      );
      return Number(rows[0]!.n);
    },
    async nativeRead() {
      const connection = await mysql.createConnection(db.appConfig);
      try {
        return await mysqlDrizzle(connection).select().from(drizzleMysqlOrders);
      } finally {
        await connection.end();
      }
    },
    async close() {
      await resource.close();
      await db.close();
    },
  };
}
