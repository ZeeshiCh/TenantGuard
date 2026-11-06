import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient as PgClient } from '../prisma/generated/postgresql/client.js';
import { PrismaClient as MysqlClient } from '../prisma/generated/mysql/client.js';
import {
  createPrismaResource,
  type PrismaDatamodel,
} from '../../packages/prisma/src/index.js';
import { postgresFixture } from './postgres.js';
import { mysqlFamilyFixture, type MysqlFamilyEngine } from './mysql-family.js';
export const prismaModels = {
  orders: {
    model: 'Order',
    tenantField: 'tenantId',
    idField: 'id',
    fields: ['id', 'tenantId', 'value'],
  },
};
export const prismaTenantA = { tenantId: 'Org_A' },
  prismaTenantB = { tenantId: 'org_a' };
const metadata = (provider: string): PrismaDatamodel =>
  JSON.parse(
    readFileSync(
      resolve(`tests/prisma/generated/${provider}/tenantguard/datamodel.json`),
      'utf8',
    ),
  ) as PrismaDatamodel;
export async function prismaFixture(engine: 'postgresql' | MysqlFamilyEngine) {
  if (engine === 'postgresql') {
    const db = await postgresFixture();
    try {
      await db.admin.query(
        'DROP TABLE public.orders;CREATE TABLE public.orders(id text PRIMARY KEY,tenant_id text NOT NULL,value text NOT NULL);GRANT SELECT,INSERT,UPDATE,DELETE ON public.orders TO app;',
      );
      const createClient = () =>
        new PgClient({
          adapter: new PrismaPg({
            ...db.config,
            max: 1,
            statement_timeout: 2000,
            lock_timeout: 1000,
            idle_in_transaction_session_timeout: 5000,
          }),
        });
      const resource = createPrismaResource({
        provider: 'postgresql',
        datamodel: metadata('postgresql'),
        createClient,
      });
      return {
        resource,
        createClient,
        engine,
        async seed() {
          await db.admin.query('TRUNCATE public.orders');
          await db.admin.query(
            'INSERT INTO public.orders VALUES($1,$2,$3),($4,$5,$6)',
            [
              'seed-a',
              prismaTenantA.tenantId,
              'a',
              'seed-b',
              prismaTenantB.tenantId,
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
        async connections() {
          return Number(
            (
              await db.admin.query(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE usename='app'",
              )
            ).rows[0].n,
          );
        },
        async execute(sql: string) {
          await db.admin.query(sql);
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
  const db = await mysqlFamilyFixture(engine);
  try {
    const collation =
      engine === 'mysql' ? 'utf8mb4_0900_bin' : 'utf8mb4_nopad_bin';
    await db.admin.query(
      `ALTER TABLE orders MODIFY tenant_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE ${collation} NOT NULL`,
    );
    const createClient = () =>
      new MysqlClient({
        adapter: new PrismaMariaDb({
          ...db.appConfig,
          connectionLimit: 1,
          allowPublicKeyRetrieval: true,
          connectTimeout: 2000,
          acquireTimeout: 2000,
          socketTimeout: 2000,
        }),
      });
    const resource = createPrismaResource({
      provider: 'mysql',
      datamodel: metadata('mysql'),
      createClient,
    });
    return {
      resource,
      createClient,
      engine,
      seed: db.seed,
      async rawCount(id: string) {
        const [rows] = await db.admin.execute<
          import('mysql2/promise').RowDataPacket[]
        >('SELECT count(*) AS n FROM orders WHERE id=?', [id]);
        return Number(rows[0]!.n);
      },
      async connections() {
        const [rows] = await db.admin.query<
          import('mysql2/promise').RowDataPacket[]
        >(
          "SELECT count(*) AS n FROM information_schema.PROCESSLIST WHERE USER='tenantguard_app'",
        );
        return Number(rows[0]!.n);
      },
      async execute(sql: string) {
        await db.admin.query(sql);
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
