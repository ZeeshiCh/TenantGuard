#!/usr/bin/env node
import pg from 'pg';
import { AUDIT_SQL } from '@tenantguard/postgres';
async function main() {
  if (process.argv[2] !== 'audit')
    throw new Error('Usage: tenantguard audit (requires DATABASE_URL)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(AUDIT_SQL);
    console.table(rows);
    console.log(
      'Inventory only: review policy expressions, role grants, ownership, views and SECURITY DEFINER functions separately.',
    );
    if (
      rows.some((row) => !row.rls_enabled || !row.rls_forced || !row.has_policy)
    )
      process.exitCode = 1;
  } finally {
    await client.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
