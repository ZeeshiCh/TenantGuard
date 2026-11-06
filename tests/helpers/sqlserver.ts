import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import {
  createSqlServerPool,
  sqlServerPolicyBatches,
  type SqlServerSession,
} from '../../packages/sqlserver/src/index.js';
import type { ConnectionConfiguration } from 'tedious';
export const sqlServerImage =
  'mcr.microsoft.com/mssql/server@sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718';
export const sqlTenantA = { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
  sqlTenantB = { tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
export const sqlTables = [{ schema: 'dbo', table: 'orders' }] as const;
export async function sqlServerFixture() {
  const password = `Tg_Test_${randomUUID()}!`;
  const container = await new GenericContainer(sqlServerImage)
    .withPlatform('linux/amd64')
    .withEnvironment({
      ACCEPT_EULA: 'Y',
      MSSQL_PID: 'Developer',
      MSSQL_SA_PASSWORD: password,
      MSSQL_MEMORY_LIMIT_MB: '2048',
    })
    .withResourcesQuota({ memory: 3 })
    .withExposedPorts(1433)
    .withWaitStrategy(
      Wait.forLogMessage('SQL Server is now ready for client connections'),
    )
    .withStartupTimeout(180000)
    .start();
  const base: ConnectionConfiguration = {
    server: container.getHost(),
    authentication: { type: 'default', options: { userName: 'sa', password } },
    options: {
      port: container.getMappedPort(1433),
      database: 'master',
      encrypt: true,
      trustServerCertificate: true,
    },
  };
  const masterPool = createSqlServerPool({
    connection: base,
    max: 1,
    connectTimeoutMs: 15000,
  });
  let master: SqlServerSession | undefined;
  let admin: SqlServerSession | undefined;
  let adminPool: ReturnType<typeof createSqlServerPool> | undefined;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        master = await masterPool.acquire();
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    await master.query('CREATE DATABASE [tenantguard]');
    await master.query(
      `CREATE LOGIN [tenantguard_app] WITH PASSWORD=N'${password}', CHECK_POLICY=OFF`,
    );
    master.release();
    master = undefined;
    const adminConfig = {
      ...base,
      options: { ...base.options, database: 'tenantguard' },
    };
    adminPool = createSqlServerPool({ connection: adminConfig, max: 1 });
    admin = await adminPool.acquire();
    await admin.query(
      'CREATE USER [tenantguard_app] FOR LOGIN [tenantguard_app]; CREATE TABLE dbo.orders(id nvarchar(64) NOT NULL PRIMARY KEY, tenant_id uniqueidentifier NOT NULL, value nvarchar(256) NOT NULL); GRANT SELECT,INSERT,UPDATE,DELETE ON dbo.orders TO [tenantguard_app];',
    );
    for (const batch of sqlServerPolicyBatches(sqlTables[0]))
      await admin.query(batch);
    await admin.query(
      'GRANT VIEW DEFINITION ON SCHEMA::tenantguard TO [tenantguard_app]',
    );
    const appConfig: ConnectionConfiguration = {
      ...adminConfig,
      authentication: {
        type: 'default',
        options: { userName: 'tenantguard_app', password },
      },
    };
    const administrative = admin,
      ownerPool = adminPool;
    return {
      admin: administrative,
      appConfig,
      adminConfig,
      async close() {
        administrative.release(true);
        await ownerPool.close();
        await masterPool.close();
        await container.stop();
      },
    };
  } catch (error) {
    admin?.release(true);
    master?.release(true);
    await adminPool?.close();
    await masterPool.close();
    await container.stop();
    throw error;
  }
}
