import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import mysql from 'mysql2/promise';
export const familyImages = {
  mysql:
    'mysql@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902',
  mariadb:
    'mariadb@sha256:c4124d1afa875e47f2892edf26b482fa54f796e2f342d3717a04ca091a22a9bd',
};
export type MysqlFamilyEngine = keyof typeof familyImages;
export const familyTenantA = { tenantId: 'Org_A' },
  familyTenantB = { tenantId: 'org_a' };
export const familyTables = {
  orders: {
    table: 'orders',
    tenantColumn: 'tenant_id',
    idColumn: 'id',
    columns: ['id', 'tenant_id', 'value'],
  },
};
export async function mysqlFamilyFixture(engine: MysqlFamilyEngine) {
  const password = `Tg_${randomUUID()}!`,
    appPassword = `App_${randomUUID()}!`;
  const container = await new GenericContainer(familyImages[engine])
    .withEnvironment(
      engine === 'mysql'
        ? {
            MYSQL_ROOT_PASSWORD: password,
            MYSQL_ROOT_HOST: '%',
            MYSQL_DATABASE: 'tenantguard',
          }
        : {
            MARIADB_ROOT_PASSWORD: password,
            MARIADB_ROOT_HOST: '%',
            MARIADB_DATABASE: 'tenantguard',
          },
    )
    .withExposedPorts(3306)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120000)
    .start();
  const base = {
    host: container.getHost(),
    port: container.getMappedPort(3306),
    database: 'tenantguard',
    charset: 'utf8mb4',
  };
  let admin: mysql.Connection | undefined;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        admin = await mysql.createConnection({
          ...base,
          user: 'root',
          password,
          connectTimeout: 3000,
        });
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await admin.query(
      'CREATE TABLE orders(id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,tenant_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,value VARCHAR(256) CHARACTER SET utf8mb4 NOT NULL) ENGINE=InnoDB',
    );
    await admin.query(
      `CREATE USER 'tenantguard_app'@'%' IDENTIFIED BY '${appPassword}'`,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE,DELETE ON tenantguard.orders TO 'tenantguard_app'@'%'",
    );
    const owner = admin;
    return {
      admin: owner,
      appConfig: { ...base, user: 'tenantguard_app', password: appPassword },
      async seed() {
        await owner.query('TRUNCATE TABLE orders');
        await owner.execute('INSERT INTO orders VALUES (?,?,?),(?,?,?)', [
          'seed-a',
          familyTenantA.tenantId,
          'a',
          'seed-b',
          familyTenantB.tenantId,
          'b',
        ]);
      },
      async close() {
        try {
          await owner.end();
        } finally {
          await container.stop();
        }
      },
    };
  } catch (error) {
    await admin?.end();
    await container.stop();
    throw error;
  }
}
