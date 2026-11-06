import { runWithTenant } from '@tenantguard/node';
/** Verifies visibility using the application's actual query path. Seed records first. */
export async function assertTenantIsolation<T>(options: {
  tenantA: string;
  tenantB: string;
  read: () => Promise<T[]>;
  tenantOf: (row: T) => string;
}): Promise<void> {
  if (options.tenantA === options.tenantB)
    throw new Error('Isolation checks require two distinct tenants');
  for (const tenant of [options.tenantA, options.tenantB]) {
    const rows = await runWithTenant(tenant, options.read);
    if (!rows.length)
      throw new Error(
        'Isolation check requires seeded visible records for each tenant',
      );
    if (rows.some((row) => options.tenantOf(row) !== tenant))
      throw new Error('Cross-tenant data exposure detected');
  }
}
