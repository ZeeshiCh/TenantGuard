import {
  createMongooseResource,
  type MongooseModel,
} from '../../packages/mongoose/src/index.js';
import { mongodbFixture } from './mongodb.js';
export const mongooseModels = {
  orders: {
    collection: 'orders',
    tenantField: 'tenantId',
    idField: 'id',
    fields: {
      id: { type: 'string', required: true },
      tenantId: { type: 'string', required: true },
      value: { type: 'string', required: true },
    },
  },
} satisfies Record<string, MongooseModel>;
export async function mongooseFixture() {
  const db = await mongodbFixture({ testCommands: true });
  const newResource = (
    models: Readonly<Record<string, MongooseModel>> = mongooseModels,
  ) =>
    createMongooseResource({
      uri: db.uri,
      database: db.database,
      models,
      connectionOptions: { appName: 'tenantguard-mongoose-test' },
    });
  const resource = newResource();
  return {
    ...db,
    resource,
    newResource,
    async close() {
      await resource.close();
      await db.close();
    },
  };
}
