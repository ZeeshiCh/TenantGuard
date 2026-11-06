import pg from 'pg';
import { createPgAdapter } from '../packages/postgres/src/pg.js';
import type { ConformanceRecord } from '../packages/testing/src/conformance.js';
import 'reflect-metadata';
import { test } from 'node:test';
import { DataSource } from 'typeorm';
import { createTypeormPostgresAdapter } from '../packages/typeorm/src/index.js';
import { adapterConformanceCases } from '../packages/testing/src/conformance.js';
import { postgresFixture, sqlConformanceFixture } from './helpers/postgres.js';

test(
  'TypeORM PostgreSQL adapter conformance',
  { timeout: 120000 },
  async (t) => {
    const database = await postgresFixture();
    try {
      const cases = adapterConformanceCases({
        transactional: true,
        createFixture: async () => {
          const { user, ...config } = database.config;
          const source = new DataSource({
            type: 'postgres',
            ...config,
            username: user,
          });
          await source.initialize();
          try {
            return await sqlConformanceFixture({
              admin: database.admin,
              adapter: createTypeormPostgresAdapter(() => source),
              execute: async (client, text, values) => {
                const rows = await client.query(text, values);
                return Array.isArray(rows[0]) ? rows[0] : rows;
              },
              close: () => source.destroy(),
            });
          } catch (error) {
            await source.destroy();
            throw error;
          }
        },
      });
      for (const conformance of cases)
        await t.test(conformance.name, conformance.run);
    } finally {
      await database.close();
    }
  },
);

test('direct pg adapter conformance', { timeout: 120000 }, async (t) => {
  const database = await postgresFixture();
  try {
    const cases = adapterConformanceCases({
      transactional: true,
      createFixture: async () => {
        const pool = new pg.Pool({ ...database.config, max: 1 });
        try {
          return await sqlConformanceFixture({
            admin: database.admin,
            adapter: createPgAdapter({
              resolvePool: () => pool,
              tables: [{ schema: 'public', table: 'orders' }],
            }),
            execute: async (client, text, values) =>
              (await client.query<ConformanceRecord>(text, values)).rows,
            close: () => pool.end(),
          });
        } catch (error) {
          await pool.end();
          throw error;
        }
      },
    });
    for (const conformance of cases)
      await t.test(conformance.name, conformance.run);
  } finally {
    await database.close();
  }
});
