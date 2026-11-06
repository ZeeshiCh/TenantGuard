import { observer, type Observer } from './inspection.js';
import type { ResolvedSource } from './config.js';
import type { IsolationProbe } from './probe-config.js';
import type { Inspection } from './processes.js';
import type { TenantRoute } from '@tenantguard/core';
type Row = Record<string, unknown>;
type Read = (tenant: string, id: string) => Promise<readonly Row[]>;
async function matrix(read: Read, probe: IsolationProbe, out: Observer) {
  const t = probe.target;
  let good = true;
  for (const [tenant, own, foreign] of [
    [probe.tenantA, probe.rowA, probe.rowB],
    [probe.tenantB, probe.rowB, probe.rowA],
    [probe.tenantA, probe.rowA, probe.rowB],
  ]) {
    const rows = await read(tenant!, own!);
    if (rows.length === 0) {
      good = false;
      out.unknown(
        'ISOLATION.FIXTURE_UNAVAILABLE',
        'An own-tenant fixture was absent or invisible; no isolation success can be inferred.',
        t,
      );
    } else if (
      rows.length !== 1 ||
      rows[0]![t.idColumn] !== own ||
      rows[0]![t.tenantColumn] !== tenant
    ) {
      good = false;
      out.add(
        'ISOLATION.OWNERSHIP_MISMATCH',
        'error',
        'Own fixture identity or ownership did not match the supplied fixture.',
        t,
      );
    }
    if ((await read(tenant!, foreign!)).length) {
      good = false;
      out.add(
        'ISOLATION.CROSS_TENANT_VISIBLE',
        'error',
        'A foreign fixture was visible from another tenant scope.',
        t,
      );
    }
  }
  if (good)
    out.add(
      'ISOLATION.READ_BOUNDARY_OBSERVED',
      'info',
      'Both own fixtures were visible and foreign fixtures hidden across A/B/A scope changes. This is a bounded read observation.',
      t,
    );
}
export async function inspectProbe(
  source: ResolvedSource,
  probe: IsolationProbe,
): Promise<Inspection> {
  const out = observer(source);
  try {
    if (source.engine === 'postgres') await postgres(source, probe, out);
    else if (source.engine === 'sqlserver') await sqlserver(source, probe, out);
    else await scoped(source, probe, out);
  } catch {
    out.unknown(
      'ISOLATION.INCOMPLETE',
      'Read probe or connection/transaction cleanup did not complete; no row contents or driver details are reported.',
      probe.target,
    );
  }
  return out.result();
}
async function postgres(s: ResolvedSource, p: IsolationProbe, out: Observer) {
  const { default: pg } = await import('pg');
  const { quoteIdentifier: q } = await import('@tenantguard/postgres');
  const c = new pg.Client({
    host: s.host,
    port: s.port ?? 5432,
    user: s.user,
    password: s.password,
    database: s.database,
    ssl: s.tls === 'verify' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: s.timeoutMs,
    statement_timeout: s.timeoutMs,
    application_name: 'tenantguard-isolation',
  });
  try {
    await c.connect();
    await c.query('BEGIN READ ONLY');
    const t = p.target;
    const sql = `SELECT ${q(t.idColumn)},${q(t.tenantColumn)}::text AS ${q(t.tenantColumn)} FROM ${q(t.schema ?? 'public')}.${q(t.table)} WHERE ${q(t.idColumn)}=$1 LIMIT 2`;
    await c.query("SELECT set_config('app.tenant_id','',true)");
    for (const id of [p.rowA, p.rowB])
      if ((await c.query(sql, [id])).rowCount)
        out.add(
          'ISOLATION.MISSING_CONTEXT_VISIBLE',
          'error',
          'A fixture was visible without tenant context.',
          t,
        );
    await matrix(
      async (tenant, id) => {
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
        return (await c.query(sql, [id])).rows;
      },
      p,
      out,
    );
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }
}
async function sqlserver(s: ResolvedSource, p: IsolationProbe, out: Observer) {
  const { createSqlServerPool, quoteSqlServerIdentifier: q } =
    await import('@tenantguard/sqlserver');
  const pool = createSqlServerPool({
    connection: {
      server: s.host!,
      authentication: {
        type: 'default',
        options: { userName: s.user, password: s.password },
      },
      options: {
        port: s.port ?? 1433,
        database: s.database,
        encrypt: s.tls !== 'disabled',
        trustServerCertificate: s.tls === 'insecure',
        appName: 'tenantguard-isolation',
      },
    },
    max: 1,
    acquireTimeoutMs: s.timeoutMs,
    connectTimeoutMs: s.timeoutMs,
  });
  let session: Awaited<ReturnType<typeof pool.acquire>> | undefined;
  try {
    session = await pool.acquire();
    await session.begin();
    const t = p.target;
    const sql = `SELECT TOP(2) ${q(t.idColumn)},LOWER(CONVERT(nvarchar(36),${q(t.tenantColumn)})) AS ${q(t.tenantColumn)} FROM ${q(t.schema ?? 'dbo')}.${q(t.table)} WHERE ${q(t.idColumn)}=@id`;
    await session.query(
      "EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=NULL",
      {},
      s.timeoutMs,
    );
    for (const id of [p.rowA, p.rowB])
      if ((await session.query(sql, { id }, s.timeoutMs)).rows.length)
        out.add(
          'ISOLATION.MISSING_CONTEXT_VISIBLE',
          'error',
          'A fixture was visible without tenant context.',
          t,
        );
    await matrix(
      async (tenant, id) => {
        await session!.query(
          "EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=@tenant",
          { tenant },
          s.timeoutMs,
        );
        return (await session!.query(sql, { id }, s.timeoutMs)).rows;
      },
      p,
      out,
    );
    await session.batch(
      "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION; EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=NULL",
      s.timeoutMs,
    );
  } finally {
    try {
      session?.release(true);
    } finally {
      await pool.close();
    }
  }
}
async function scoped(s: ResolvedSource, p: IsolationProbe, out: Observer) {
  const t = p.target,
    table = {
      table: t.table,
      tenantColumn: t.tenantColumn,
      idColumn: t.idColumn,
      columns: [t.idColumn, t.tenantColumn],
    };
  const route = (tenantId: string, adapter: string): TenantRoute => ({
    tenantId,
    source: s.name,
    adapter,
    resource: 'diagnostic',
    revision: '1',
    status: 'active',
    mode: 'application-filter',
  });
  let read: Read, close: () => Promise<void>;
  if (s.engine === 'mongodb') {
    const { createMongoResource, createMongoAdapter } =
      await import('@tenantguard/mongodb');
    const resource = createMongoResource({
      uri: s.url!,
      database: s.database!,
      clientOptions: {
        tls: s.tls === 'verify',
        tlsAllowInvalidCertificates: false,
        tlsAllowInvalidHostnames: false,
        serverSelectionTimeoutMS: s.timeoutMs,
        connectTimeoutMS: s.timeoutMs,
        socketTimeoutMS: s.timeoutMs,
        retryReads: false,
        retryWrites: false,
      },
    });
    const adapter = createMongoAdapter({
      resolveResource: () => resource,
      collections: {
        fixture: {
          collection: t.table,
          tenantField: t.tenantColumn,
          idField: t.idColumn,
          fields: table.columns,
        },
      },
    });
    read = (tenant, id) =>
      adapter.run({ tenantId: tenant }, route(tenant, 'mongodb'), (c) =>
        c.collection<Row>('fixture').find({ [t.idColumn]: id }, { limit: 2 }),
      );
    close = () => resource.close();
  } else if (s.engine === 'sqlite') {
    const { createSqliteResource, createSqliteAdapter } =
      await import('@tenantguard/sqlite');
    const resource = createSqliteResource({ filename: s.filename! });
    const adapter = createSqliteAdapter({
      resolveResource: () => resource,
      tables: { fixture: table },
    });
    read = (tenant, id) =>
      adapter.run({ tenantId: tenant }, route(tenant, 'sqlite'), (c) =>
        c.table<Row>('fixture').find({ [t.idColumn]: id }, { limit: 2 }),
      );
    close = () => resource.close();
  } else {
    const connection = {
      host: s.host,
      port: s.port ?? 3306,
      user: s.user,
      password: s.password,
      database: s.database!,
      ssl: s.tls === 'verify' ? { rejectUnauthorized: true } : undefined,
    };
    if (s.engine === 'mysql') {
      const { createMysqlPool, createMysqlAdapter } =
        await import('@tenantguard/mysql');
      const pool = createMysqlPool({ connection, max: 1 });
      const adapter = createMysqlAdapter({
        resolvePool: () => pool,
        tables: { fixture: table },
      });
      read = (tenant, id) =>
        adapter.run({ tenantId: tenant }, route(tenant, 'mysql'), (c) =>
          c.table<Row>('fixture').find({ [t.idColumn]: id }, { limit: 2 }),
        );
      close = () => pool.close();
    } else {
      const { createMariadbPool, createMariadbAdapter } =
        await import('@tenantguard/mariadb');
      const pool = createMariadbPool({ connection, max: 1 });
      const adapter = createMariadbAdapter({
        resolvePool: () => pool,
        tables: { fixture: table },
      });
      read = (tenant, id) =>
        adapter.run({ tenantId: tenant }, route(tenant, 'mariadb'), (c) =>
          c.table<Row>('fixture').find({ [t.idColumn]: id }, { limit: 2 }),
        );
      close = () => pool.close();
    }
  }
  try {
    await matrix(read, p, out);
    out.add(
      'ISOLATION.APPLICATION_PATH_LIMIT',
      'warning',
      'Probes use the bundled direct scoped adapter, not application authorization, framework middleware or ORM query paths.',
      t,
    );
  } finally {
    await close();
  }
}
