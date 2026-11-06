import { MongoClient } from 'mongodb';
import type { ResolvedSource } from './config.js';
import type { Observer } from './inspection.js';
export async function inspectMongo(
  source: ResolvedSource,
  out: Observer,
): Promise<void> {
  const client = new MongoClient(source.url!, {
    tls: source.tls === 'verify',
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
    serverSelectionTimeoutMS: source.timeoutMs,
    connectTimeoutMS: source.timeoutMs,
    socketTimeoutMS: source.timeoutMs,
    maxPoolSize: 1,
    retryReads: false,
    retryWrites: false,
  });
  try {
    await client.connect();
    const database = client.db(source.database || undefined);
    const hello = await client
      .db('admin')
      .command({ hello: 1 }, { timeoutMS: source.timeoutMs });
    if (
      typeof hello.setName !== 'string' ||
      typeof hello.logicalSessionTimeoutMinutes !== 'number'
    )
      out.add(
        'MONGO.TRANSACTIONS',
        'error',
        'A replica set with logical sessions is required for the supported transaction lifecycle.',
      );
    const status = await client
      .db('admin')
      .command(
        { connectionStatus: 1, showPrivileges: true },
        { timeoutMS: source.timeoutMs },
      );
    const auth = status.authInfo;
    if (!auth || !Array.isArray(auth.authenticatedUserPrivileges))
      out.unknown(
        'MONGO.PRIVILEGES_UNAVAILABLE',
        'Authenticated privilege metadata is unavailable.',
      );
    else {
      const actions = new Set(
        auth.authenticatedUserPrivileges.flatMap(
          (entry: { actions?: string[] }) => entry.actions ?? [],
        ),
      );
      if (
        [
          'anyAction',
          'grantRole',
          'createUser',
          'dropUser',
          'setParameter',
          'replSetConfigure',
          'shutdown',
        ].some((value) => actions.has(value))
      )
        out.add(
          'MONGO.ROLE_PRIVILEGED',
          'error',
          'Connected role can administer users, roles or the server.',
        );
      if (
        ['dropCollection', 'collMod', 'createCollection'].some((value) =>
          actions.has(value),
        )
      )
        out.add(
          'MONGO.ROLE_DDL',
          'warning',
          'Connected role has collection-management capability; application filtering does not constrain raw access.',
        );
    }
    for (const target of source.targets) {
      const entries = await database
        .listCollections(
          { name: target.table },
          { nameOnly: false, maxTimeMS: source.timeoutMs },
        )
        .toArray();
      const collection = entries[0];
      if (!collection) {
        out.unknown(
          'MONGO.TARGET_UNAVAILABLE',
          'Configured collection is absent or invisible.',
          target,
        );
        continue;
      }
      if (
        collection.type !== 'collection' ||
        collection.options?.timeseries ||
        collection.options?.viewOn
      )
        out.add(
          'MONGO.ORDINARY_COLLECTION',
          'error',
          'Only ordinary collections are supported scoped CRUD targets.',
          target,
        );
      const schema = collection.options?.validator?.$jsonSchema;
      const tenant = schema?.properties?.[target.tenantColumn];
      if (
        !schema ||
        !Array.isArray(schema.required) ||
        !schema.required.includes(target.tenantColumn) ||
        tenant?.bsonType !== 'string'
      )
        out.add(
          'MONGO.VALIDATOR',
          'warning',
          'A required scalar string tenant validator was not established; scoped guards remain essential.',
          target,
        );
      if (
        collection.options?.collation &&
        collection.options.collation.locale !== 'simple'
      )
        out.add(
          'MONGO.COLLATION',
          'warning',
          'Collection default collation is not simple; operations must retain explicit binary collation.',
          target,
        );
      const indexes = await database
        .collection(target.table)
        .listIndexes({ maxTimeMS: source.timeoutMs })
        .toArray();
      if (
        !indexes.some(
          (index) =>
            Object.keys(index.key)[0] === target.tenantColumn &&
            (!index.collation || index.collation.locale === 'simple'),
        )
      )
        out.add(
          'MONGO.TENANT_INDEX',
          'warning',
          'No tenant-leading binary index was observed.',
          target,
        );
      out.add(
        'MONGO.CATALOG_OBSERVED',
        'info',
        'Replica-set, privilege, collection, validator and index metadata were inspected.',
        target,
      );
    }
  } finally {
    await client.close();
  }
}
