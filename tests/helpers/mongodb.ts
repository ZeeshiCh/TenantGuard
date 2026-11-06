import { randomBytes, randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import { MongoClient } from 'mongodb';
export const mongoCollections = {
  orders: {
    collection: 'orders',
    tenantField: 'tenantId',
    idField: 'id',
    fields: ['id', 'tenantId', 'value'],
  },
};
export const mongoTenantA = { tenantId: 'Org_A' },
  mongoTenantB = { tenantId: 'org_a' };
export async function mongodbFixture(options: { testCommands?: boolean } = {}) {
  const password = randomUUID(),
    appPassword = randomUUID();
  const container = await new GenericContainer(
    'mongo@sha256:b9924c330a8bbc5800fe9c69f04a84e221eca7b28fd049a0354147d9908fa142',
  )
    .withEnvironment({
      MONGO_INITDB_ROOT_USERNAME: 'root',
      MONGO_INITDB_ROOT_PASSWORD: password,
    })
    .withCopyContentToContainer([
      { content: randomBytes(512).toString('base64'), target: '/tmp/rs-key' },
    ])
    .withEntrypoint(['/bin/bash', '-c'])
    .withCommand([
      'cp /tmp/rs-key /data/rs-key && chown mongodb:mongodb /data/rs-key && chmod 400 /data/rs-key && exec /usr/local/bin/docker-entrypoint.sh mongod --replSet rs0 --bind_ip_all --keyFile /data/rs-key' +
        (options.testCommands ? ' --setParameter enableTestCommands=1' : ''),
    ])
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120000)
    .start();
  const uri = (user: string, pass: string) =>
    `mongodb://${user}:${pass}@${container.getHost()}:${container.getMappedPort(27017)}/?directConnection=true&replicaSet=rs0&authSource=admin`;
  let admin: MongoClient | undefined;
  try {
    for (let attempt = 0; ; attempt++) {
      const initialized = await container.exec([
        'mongosh',
        '--quiet',
        '--username',
        'root',
        '--password',
        password,
        '--authenticationDatabase',
        'admin',
        '--eval',
        'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})',
      ]);
      if (initialized.exitCode === 0) break;
      if (attempt >= 30)
        throw new Error(
          'Replica set initialization failed: ' + initialized.output,
        );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    admin = new MongoClient(uri('root', password), {
      serverSelectionTimeoutMS: 2000,
    });
    for (let n = 0; ; n++) {
      try {
        const hello = await admin.db('admin').command({ hello: 1 });
        if (hello.isWritablePrimary) break;
      } catch (error) {
        if (n > 30) throw error;
      }
      if (n > 30) throw new Error('Replica set did not elect a primary');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const db = admin.db('tenantguard');
    await db.createCollection('orders', {
      collation: { locale: 'en', strength: 1 },
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['id', 'tenantId', 'value'],
          properties: { tenantId: { bsonType: 'string' } },
        },
      },
    });
    await db
      .collection('orders')
      .createIndex(
        { tenantId: 1, id: 1 },
        { unique: true, collation: { locale: 'simple' } },
      );
    await admin.db('admin').command({
      createUser: 'tenantguard_app',
      pwd: appPassword,
      roles: [{ role: 'readWrite', db: 'tenantguard' }],
    });
    const owner = admin;
    return {
      admin: owner,
      uri: uri('tenantguard_app', appPassword),
      database: 'tenantguard',
      async seed() {
        await db.collection('orders').deleteMany({});
        await db.collection('orders').insertMany([
          { id: 'seed-a', tenantId: mongoTenantA.tenantId, value: 'a' },
          { id: 'seed-b', tenantId: mongoTenantB.tenantId, value: 'b' },
        ]);
      },
      async close() {
        await owner.close();
        await container.stop();
      },
    };
  } catch (error) {
    await admin?.close();
    await container.stop();
    throw error;
  }
}
