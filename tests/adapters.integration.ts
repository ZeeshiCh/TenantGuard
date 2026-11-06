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
