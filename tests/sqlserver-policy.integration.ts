import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sqlServerFixture,
  sqlTenantA,
  sqlTenantB,
} from './helpers/sqlserver.js';
import { createSqlServerPool } from '../packages/sqlserver/src/index.js';
test(
  'SQL Server native policies enforce reads and write boundaries',
  { timeout: 240000 },
  async () => {
    const database = await sqlServerFixture();
    const pool = createSqlServerPool({
      connection: database.appConfig,
      max: 1,
    });
    const client = await pool.acquire();
    try {
      for (const [id, context] of [
        ['a', sqlTenantA],
        ['b', sqlTenantB],
      ] as const) {
        await database.admin.query(
          "EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=@tenant",
          { tenant: context.tenantId },
        );
        await database.admin.query(
          'INSERT dbo.orders VALUES(@id,@tenant,@value)',
          { id, tenant: context.tenantId, value: id },
        );
      }
      await database.admin.query(
        "EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=NULL",
      );
      assert.deepEqual(
        (await client.query('SELECT * FROM dbo.orders')).rows,
        [],
      );
      await client.query(
        "EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=@tenant",
        { tenant: sqlTenantA.tenantId },
      );
      assert.equal(
        (await client.query('SELECT * FROM dbo.orders')).rows.length,
        1,
      );
      await assert.rejects(
        () =>
          client.query("INSERT dbo.orders VALUES(N'foreign',@tenant,N'bad')", {
            tenant: sqlTenantB.tenantId,
          }),
        /block predicate/i,
      );
      await assert.rejects(
        () =>
          client.query(
            "UPDATE dbo.orders SET tenant_id=@tenant WHERE id=N'a'",
            { tenant: sqlTenantB.tenantId },
          ),
        /block predicate/i,
      );
      await client.query(
        "EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=NULL",
      );
      assert.deepEqual(
        (await client.query('SELECT * FROM dbo.orders')).rows,
        [],
      );
    } finally {
      client.release(true);
      await pool.close();
      await database.close();
    }
  },
);
