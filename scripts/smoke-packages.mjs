import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve('.');
const temporary = mkdtempSync(join(tmpdir(), 'tenantguard-consumer-'));
function installPacked(directory) {
  const packages = readdirSync(directory)
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => join(directory, file));
  execFileSync(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(directory, 'cache'),
      ...packages,
    ],
    { cwd: directory, stdio: 'pipe' },
  );
}
try {
  const packed = new Map();
  function pack(
    directory,
    workspace = false,
    destination = temporary,
    graph = packed,
  ) {
    const manifest = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    );
    if (graph.has(manifest.name)) {
      if (graph.get(manifest.name) !== manifest.version)
        throw new Error(
          `Consumer fixture needs conflicting versions of ${manifest.name}`,
        );
      return;
    }
    graph.set(manifest.name, manifest.version);
    if (workspace) {
      execFileSync('pnpm', ['pack', '--pack-destination', destination], {
        cwd: directory,
        stdio: 'pipe',
      });
    } else {
      execFileSync(
        'npm',
        [
          'pack',
          directory,
          '--ignore-scripts',
          '--pack-destination',
          destination,
          '--cache',
          join(destination, 'cache'),
        ],
        { cwd: destination, stdio: 'pipe' },
      );
    }
    const require = createRequire(join(directory, 'package.json'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@tenantguard/')) {
        pack(
          join(root, 'packages', dependency.slice('@tenantguard/'.length)),
          true,
          destination,
          graph,
        );
        continue;
      }
      let dependencyDirectory;
      try {
        dependencyDirectory = dirname(
          require.resolve(`${dependency}/package.json`),
        );
      } catch {
        dependencyDirectory = dirname(require.resolve(dependency));
        while (
          !existsSync(join(dependencyDirectory, 'package.json')) ||
          JSON.parse(
            readFileSync(join(dependencyDirectory, 'package.json'), 'utf8'),
          ).name !== dependency
        ) {
          const parent = dirname(dependencyDirectory);
          if (parent === dependencyDirectory)
            throw new Error(`Cannot locate manifest for ${dependency}`);
          dependencyDirectory = parent;
        }
      }
      pack(dependencyDirectory, false, destination, graph);
    }
  }
  for (const name of [
    'core',
    'node',
    'fetch',
    'postgres',
    'sqlserver',
    'mysql',
    'mariadb',
    'mongodb',
    'sqlite',
    'prisma',
    'drizzle',
  ])
    pack(join(root, 'packages', name), true);
  pack(
    dirname(
      createRequire(join(root, 'package.json')).resolve('pg/package.json'),
    ),
  );
  writeFileSync(
    join(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  installPacked(temporary);
  // Execute the installed companion generator through the real Prisma CLI.
  writeFileSync(
    join(temporary, 'metadata.prisma'),
    `
    generator tenantguard {
      provider = env("TENANTGUARD_PRISMA_GENERATOR")
      output = "./tenantguard-metadata"
    }
    datasource db {
 provider = "postgresql"
 }
    model Order {
      id String @id
      tenantId String @map("tenant_id")
      value String
      @@map("orders")
    }
  `,
  );
  const quoteGeneratorPath = (value) =>
    "'" + value.replaceAll("'", "'\\''") + "'";
  execFileSync(
    process.execPath,
    [
      join(
        dirname(
          createRequire(join(root, 'package.json')).resolve(
            'prisma/package.json',
          ),
        ),
        'build/index.js',
      ),
      'generate',
      '--schema',
      join(temporary, 'metadata.prisma'),
    ],
    {
      cwd: temporary,
      stdio: 'pipe',
      env: {
        ...process.env,
        TENANTGUARD_PRISMA_GENERATOR: [
          process.execPath,
          join(temporary, 'node_modules/@tenantguard/prisma/dist/generator.js'),
        ]
          .map(quoteGeneratorPath)
          .join(' '),
      },
    },
  );
  const generatedMetadata = JSON.parse(
    readFileSync(
      join(temporary, 'tenantguard-metadata/datamodel.json'),
      'utf8',
    ),
  );
  if (
    generatedMetadata.models[0]?.fields.find(
      (field) => field.name === 'tenantId',
    )?.dbName !== 'tenant_id'
  )
    throw new Error('Packed Prisma generator lost mapped scalar metadata');
  writeFileSync(
    join(temporary, 'consumer.mjs'),
    `
    import assert from 'node:assert/strict';
    import { createTenantGuard, createTenantRouter } from '@tenantguard/core';
    import { nodeContext, requireTenant } from '@tenantguard/node';
    import { withTenant } from '@tenantguard/fetch';
    import pg from 'pg';
    import { createPgAdapter } from '@tenantguard/postgres/pg';
    import { createSqlServerPool, createSqlServerAdapter } from '@tenantguard/sqlserver';
    import { createMysqlPool, createMysqlAdapter } from '@tenantguard/mysql';
    import { createMariadbPool, createMariadbAdapter } from '@tenantguard/mariadb';
    import { createMongoResource, createMongoAdapter } from '@tenantguard/mongodb';
    import { createSqliteResource, createSqliteAdapter } from '@tenantguard/sqlite';
    import { createPrismaResource, createPrismaAdapter } from '@tenantguard/prisma';
    import { createDrizzlePgResource, createDrizzleMysqlResource, createDrizzleAdapter } from '@tenantguard/drizzle';
    import { pgTable, text } from 'drizzle-orm/pg-core';
    const drizzleOrders=pgTable('orders',{id:text('id').primaryKey(),tenantId:text('tenant_id').notNull(),value:text('value')});
    const drizzleResource=createDrizzlePgResource({connection:{host:'localhost'}});
    const drizzleAdapter=createDrizzleAdapter({resolveResource:()=>drizzleResource,tables:{orders:{table:drizzleOrders,tenantColumn:'tenantId',idColumn:'id',columns:['id','tenantId','value']}}});
    const drizzleMysqlResource=createDrizzleMysqlResource({connection:{host:'localhost',database:'example'}});
    await drizzleMysqlResource.close();
    await drizzleResource.close();
    const prismaDatamodel={models:[{name:'Order',dbName:'orders',fields:['id','tenantId','value'].map(name=>({name,kind:'scalar',type:'String',isList:false,isRequired:true}))}]};
    const prismaResource=createPrismaResource({provider:'postgresql',datamodel:prismaDatamodel,createClient:()=>({$transaction:async work=>work({$queryRawUnsafe:async()=>[{safe:true}]}),$disconnect:async()=>{}})});
    const prismaAdapter=createPrismaAdapter({resolveResource:()=>prismaResource,models:{orders:{model:'Order',tenantField:'tenantId',idField:'id',fields:['id','tenantId','value']}}});
    const mongoResource = createMongoResource({ uri: 'mongodb://localhost:27017', database: 'example' });
    const mongoAdapter = createMongoAdapter({ resolveResource: () => mongoResource, collections: { orders: { collection: 'orders', tenantField: 'tenantId', idField: 'id', fields: ['id', 'tenantId', 'value'] } } });
    await mongoResource.close();
    const guard = createTenantGuard({ carrier: nodeContext, authorize: () => ({ tenantId: 'Org_A' }) });
    const handler = withTenant(guard, (_request, context) => {
      assert.equal(requireTenant().tenantId, context.tenantId);
      return new Response(context.tenantId);
    });
    assert.equal(await (await handler(new Request('http://test'))).text(), 'Org_A');
    const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 100 });
    const adapter = createPgAdapter({ resolvePool: () => pool, tables: [{ schema: 'public', table: 'orders' }] });
    const { DatabaseSync } = await import('node:sqlite');
    const { resolve } = await import('node:path');
    const filename = resolve('consumer.sqlite');
    const setup = new DatabaseSync(filename);
    setup.exec("CREATE TABLE orders(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,value TEXT);INSERT INTO orders VALUES('own','Org_A','ok'),('foreign','org_a','hidden')");
    setup.close();
    const sqliteResource = createSqliteResource({ filename });
    const sqliteAdapter = createSqliteAdapter({ resolveResource: () => sqliteResource, tables: { orders: { table: 'orders', tenantColumn: 'tenant_id', idColumn: 'id', columns: ['id','tenant_id','value'] } } });
    const sqliteRoute = { tenantId: 'Org_A', source: 'orders', adapter: 'sqlite', resource: 'file', revision: '1', status: 'active', mode: 'application-filter' };
    try {
      const rows = await sqliteAdapter.run({tenantId:'Org_A'}, sqliteRoute, client => client.table('orders').find());
      assert.equal(rows.length, 1); assert.equal(rows[0].id, 'own');
      assert.throws(() => createTenantRouter({ strict: true, sources: {orders: {adapter: sqliteAdapter, mode: 'application-filter'}}, registry: {resolve: async()=>undefined} }));
    } finally { await sqliteResource.close(); }
    assert.equal(adapter.name, 'pg');
    assert.equal(prismaAdapter.name,'prisma');
    assert.equal(drizzleAdapter.name,'drizzle');
    assert.throws(()=>createTenantRouter({strict:true,sources:{orders:{adapter:drizzleAdapter,mode:'application-filter'}},registry:{resolve:async()=>undefined}}));
    assert.throws(()=>createTenantRouter({strict:true,sources:{orders:{adapter:prismaAdapter,mode:'application-filter'}},registry:{resolve:async()=>undefined}}));
    await prismaAdapter.run({tenantId:'Org_A'},{tenantId:'Org_A',adapter:'prisma',source:'orders',resource:'test',revision:'1',status:'active',mode:'application-filter'},async()=>{});
    await prismaResource.close();
    assert.equal(mongoAdapter.name, 'mongodb');
    assert.throws(() => createTenantRouter({ strict: true, sources: { orders: { adapter: mongoAdapter, mode: 'application-filter' } }, registry: { resolve: async () => undefined } }));
    await pool.end();
    const sqlPool = createSqlServerPool({ connection: { server: 'localhost', options: { database: 'example', encrypt: true } } });
    const sqlAdapter = createSqlServerAdapter({ resolvePool: () => sqlPool, tables: [{ schema: 'dbo', table: 'orders' }] });
    assert.equal(sqlAdapter.name, 'sqlserver');
    await sqlPool.close();
    const tables = { orders: { table: 'orders', tenantColumn: 'tenant_id', idColumn: 'id', columns: ['id', 'tenant_id', 'value'] } };
    for (const [makePool, makeAdapter] of [[createMysqlPool, createMysqlAdapter], [createMariadbPool, createMariadbAdapter]]) {
      const scopedPool = makePool({ connection: { host: 'localhost', database: 'example' } });
      const scopedAdapter = makeAdapter({ resolvePool: () => scopedPool, tables });
      assert.deepEqual(scopedAdapter.capabilities.isolationModes, ['application-filter']);
      assert.throws(() => createTenantRouter({ strict: true, sources: { orders: { adapter: scopedAdapter, mode: 'application-filter' } }, registry: { resolve: async () => undefined } }));
      await scopedPool.close();
    }
  `,
  );
  execFileSync(process.execPath, ['consumer.mjs'], {
    cwd: temporary,
    stdio: 'inherit',
  });
  writeFileSync(
    join(temporary, 'drizzle-consumer.cjs'),
    `
    const assert = require('node:assert/strict');
    const {pgTable,text} = require('drizzle-orm/pg-core');
    const orders=pgTable('orders',{id:text('id').primaryKey(),tenantId:text('tenant_id').notNull(),value:text('value')});
    import('@tenantguard/drizzle').then(async ({createDrizzlePgResource,createDrizzleAdapter})=>{
      const resource=createDrizzlePgResource({connection:{host:'localhost'}});
      const adapter=createDrizzleAdapter({resolveResource:()=>resource,tables:{orders:{table:orders,tenantColumn:'tenantId',idColumn:'id',columns:['id','tenantId','value']}}});
      assert.equal(adapter.name,'drizzle');await resource.close();
    }).catch(error=>{console.error(error);process.exitCode=1;});
  `,
  );
  execFileSync(process.execPath, ['drizzle-consumer.cjs'], {
    cwd: temporary,
    stdio: 'inherit',
  });
  // Type declarations must resolve from installed package exports, without workspace aliases.
  writeFileSync(
    join(temporary, 'consumer.ts'),
    `
    import { createTenantGuard, createTenantRouter, type DatabaseAdapter } from '@tenantguard/core';
    import { withTenant } from '@tenantguard/fetch';
    import pg from 'pg';
    import { createPgAdapter, type PgTenantClient } from '@tenantguard/postgres/pg';
    import { createSqlServerPool, createSqlServerAdapter, type SqlServerTenantClient } from '@tenantguard/sqlserver';
    import { createMysqlPool, createMysqlAdapter, type ScopedSqlClient } from '@tenantguard/mysql';
    import { createMariadbPool, createMariadbAdapter } from '@tenantguard/mariadb';
    import { createMongoResource, createMongoAdapter } from '@tenantguard/mongodb';
    import { createSqliteResource, createSqliteAdapter } from '@tenantguard/sqlite';
    import { createPrismaResource, createPrismaAdapter } from '@tenantguard/prisma';
    const prismaDatamodel={models:[{name:'Order',dbName:'orders',fields:['id','tenantId','value'].map(name=>({name,kind:'scalar',type:'String',isList:false,isRequired:true}))}]};
    const prismaResource=createPrismaResource({provider:'postgresql',datamodel:prismaDatamodel,createClient:()=>({$transaction:async work=>work({$queryRawUnsafe:async()=>[{safe:true}]}),$disconnect:async()=>{}})});
    const prismaAdapter=createPrismaAdapter({resolveResource:()=>prismaResource,models:{orders:{model:'Order',tenantField:'tenantId',idField:'id',fields:['id','tenantId','value']}}});
    const mongoResource = createMongoResource({ uri: 'mongodb://localhost:27017', database: 'example' });
    const mongoAdapter = createMongoAdapter({ resolveResource: () => mongoResource, collections: { orders: { collection: 'orders', tenantField: 'tenantId', idField: 'id', fields: ['id', 'tenantId', 'value'] } } });
    await mongoResource.close();
    const guard = createTenantGuard<Request>({ authorize: () => ({ tenantId: 'Org_A' }) });
    withTenant(guard, (_request, context) => new Response(context.tenantId));
    const adapter: DatabaseAdapter<{ query(): string }> = {
      name: 'fixture', capabilities: { isolationModes: ['database-policy'], transactions: true },
      run: async (_context, _route, work) => work({ query: () => 'ok' })
    };
    const router = createTenantRouter({ sources: { orders: { adapter, mode: 'database-policy' } }, registry: { resolve: async () => undefined } });
    void router.run({ tenantId: 'Org_A' }, 'orders', async client => client.query());
    const pool = new pg.Pool({ max: 1 });
    const direct = createPgAdapter({ resolvePool: () => pool, tables: [{ schema: 'public', table: 'orders' }] });
    const typed: import('@tenantguard/core').DatabaseAdapter<PgTenantClient> = direct;
    void typed;
    const sqlPool = createSqlServerPool({ connection: { server: 'localhost', options: { database: 'example', encrypt: true } } });
    const sqlAdapter = createSqlServerAdapter({ resolvePool: () => sqlPool, tables: [{ schema: 'dbo', table: 'orders' }] });
    const typedSql: import('@tenantguard/core').DatabaseAdapter<SqlServerTenantClient> = sqlAdapter;
    void typedSql;
    const tables = { orders: { table: 'orders', tenantColumn: 'tenant_id', idColumn: 'id', columns: ['id', 'tenant_id', 'value'] } };
    const mysqlPool = createMysqlPool({ connection: { host: 'localhost', database: 'example' } });
    const mariaPool = createMariadbPool({ connection: { host: 'localhost', database: 'example' } });
    const mysqlAdapter: DatabaseAdapter<ScopedSqlClient> = createMysqlAdapter({ resolvePool: () => mysqlPool, tables });
    const mariaAdapter: DatabaseAdapter<ScopedSqlClient> = createMariadbAdapter({ resolvePool: () => mariaPool, tables });
    void mysqlAdapter; void mariaAdapter;
    const typedMongo: DatabaseAdapter<import('@tenantguard/mongodb').MongoScopedClient> = mongoAdapter;
    void typedMongo;
    const sqliteResource = createSqliteResource({filename: '/existing/server-owned/orders.sqlite'});
    const typedSqlite: DatabaseAdapter<import('@tenantguard/sqlite').SqliteScopedClient> = createSqliteAdapter({resolveResource: () => sqliteResource, tables});
    void typedSqlite;
    const typedPrisma: DatabaseAdapter<import('@tenantguard/prisma').PrismaScopedClient> = prismaAdapter;
    void typedPrisma;
  `,
  );
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.ts',
    ],
    { cwd: temporary, stdio: 'inherit' },
  );
  // Drizzle 0.45.4's declarations reference optional drivers and contain upstream
  // declaration errors. Keep the original consumer fully checked; only this
  // Drizzle-specific consumer skips dependency .d.ts checking, not strict usage.
  writeFileSync(
    join(temporary, 'drizzle-consumer.ts'),
    `
    import {pgTable,text} from 'drizzle-orm/pg-core';
    import {sql} from 'drizzle-orm';
    import {createDrizzlePgResource,createDrizzleMysqlResource,createDrizzleAdapter,type DrizzleScopedClient} from '@tenantguard/drizzle';
    import type {DatabaseAdapter} from '@tenantguard/core';
    const orders=pgTable('orders',{id:text('id').primaryKey(),tenantId:text('tenant_id').notNull(),value:text('value')});
    const resource=createDrizzlePgResource({connection:{host:'localhost'}});
    const adapter:DatabaseAdapter<DrizzleScopedClient>=createDrizzleAdapter({resolveResource:()=>resource,tables:{orders:{table:orders,tenantColumn:'tenantId',idColumn:'id',columns:['id','tenantId','value']}}});
    const rows=(client:DrizzleScopedClient)=>client.table<typeof orders.$inferSelect>('orders').find();
    function invalid(client:DrizzleScopedClient){
      // @ts-expect-error SQL objects cannot be facade equality values.
      void client.table('orders').find({id:sql\`1=1\`});
      // @ts-expect-error MySQL resources must declare their database.
      createDrizzleMysqlResource({connection:{host:'localhost'}});
    }
    void adapter;void rows;void invalid;
  `,
  );
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'drizzle-consumer.ts',
    ],
    { cwd: temporary, stdio: 'inherit' },
  );
  // Mongoose owns MongoDB driver 7; the existing direct adapter owns driver 6.
  // Verify each actual dependency closure independently, without flattening or
  // replacing either driver's BSON/session classes with another major version.
  const mongooseTemporary = join(temporary, 'mongoose-consumer');
  mkdirSync(mongooseTemporary);
  const mongoosePacked = new Map();
  pack(
    join(root, 'packages/mongoose'),
    true,
    mongooseTemporary,
    mongoosePacked,
  );
  pack(
    dirname(
      createRequire(join(root, 'package.json')).resolve(
        '@types/node/package.json',
      ),
    ),
    false,
    mongooseTemporary,
    mongoosePacked,
  );
  writeFileSync(
    join(mongooseTemporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  installPacked(mongooseTemporary);
  writeFileSync(
    join(mongooseTemporary, 'consumer.mjs'),
    `
    import assert from 'node:assert/strict';
    import {createTenantRouter} from '@tenantguard/core';
    import {createMongooseResource,createMongooseAdapter} from '@tenantguard/mongoose';
    const resource=createMongooseResource({uri:'mongodb://localhost:27017',database:'example',models:{orders:{collection:'orders',tenantField:'tenantId',idField:'id',fields:{id:{type:'string',required:true},tenantId:{type:'string',required:true},value:{type:'string',required:true}}}}});
    const adapter=createMongooseAdapter({resolveResource:()=>resource});
    assert.equal(adapter.name,'mongoose');
    assert.throws(()=>createTenantRouter({strict:true,sources:{orders:{adapter,mode:'application-filter'}},registry:{resolve:async()=>undefined}}));
    await resource.close();
    await assert.rejects(()=>adapter.run({tenantId:'Org_A'},{tenantId:'Org_A',adapter:'mongoose',source:'orders',resource:'main',revision:'1',status:'active',mode:'application-filter'},async()=>assert.fail('closed resource callback')));
  `,
  );
  execFileSync(process.execPath, ['consumer.mjs'], {
    cwd: mongooseTemporary,
    stdio: 'inherit',
  });
  writeFileSync(
    join(mongooseTemporary, 'consumer.ts'),
    `
    import {createMongooseResource,createMongooseAdapter,type MongooseScopedClient} from '@tenantguard/mongoose';
    import type {DatabaseAdapter} from '@tenantguard/core';
    const resource=createMongooseResource({uri:'mongodb://localhost:27017',database:'example',models:{orders:{collection:'orders',tenantField:'tenantId',idField:'id',fields:{id:{type:'string',required:true},tenantId:{type:'string',required:true},value:{type:'string',required:true}}}}});
    const adapter:DatabaseAdapter<MongooseScopedClient>=createMongooseAdapter({resolveResource:()=>resource});
    const read=(client:MongooseScopedClient)=>client.model<{id:string;tenantId:string;value:string}>('orders').find();
    function invalid(client:MongooseScopedClient){
      // @ts-expect-error Raw operators are not scalar values.
      void client.model('orders').find({id:{$ne:'foreign'}});
      // @ts-expect-error Native query options are not in the facade.
      void client.model('orders').find({}, {populate:'foreign'});
    }
    void adapter;void read;void invalid;
  `,
  );
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.ts',
    ],
    { cwd: mongooseTemporary, stdio: 'inherit' },
  );
  console.log(
    'Packed core/node/fetch/postgres/sqlserver/mysql/mariadb/mongodb/sqlite/prisma/drizzle: clean offline JavaScript and TypeScript consumers passed; isolated Mongoose driver closure passed',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
