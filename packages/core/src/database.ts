import { createTenantContext, type TenantContext } from './context.js';
export type IsolationMode =
  'database-policy' | 'database-per-tenant' | 'application-filter';
export interface AdapterCapabilities {
  readonly isolationModes: readonly IsolationMode[];
  readonly transactions: boolean;
}
/** Opaque server-controlled references. Never populate these from raw request input. */
export interface TenantRoute {
  readonly tenantId: string;
  readonly source: string;
  readonly adapter: string;
  readonly resource: string;
  readonly secretRef?: string;
  readonly revision: string;
  readonly status: 'active' | 'pending' | 'suspended' | 'migrating' | 'failed';
  readonly mode: IsolationMode;
}
export interface TenantRegistry {
  resolve(
    context: Readonly<TenantContext>,
    source: string,
  ): Promise<TenantRoute | undefined>;
}
/** Adapters own acquisition, enforcement, commit/rollback and cleanup before resolving.
 * Failed cleanup must destroy the connection. Clients must not escape the callback.
 */
export interface DatabaseAdapter<Client> {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  run<T>(
    context: Readonly<TenantContext>,
    route: Readonly<TenantRoute>,
    work: (client: Client) => Promise<T>,
  ): Promise<T>;
}
export interface TenantDataSource<Client> {
  readonly adapter: DatabaseAdapter<Client>;
  readonly mode: IsolationMode;
}
export class TenantRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantRoutingError';
  }
}
function assertMode(value: unknown): asserts value is IsolationMode {
  if (
    !['database-policy', 'database-per-tenant', 'application-filter'].includes(
      value as string,
    )
  )
    throw new TenantRoutingError('Unknown isolation mode');
}
/** No ambient state, credentials, SQL dialect or framework assumptions. */
export function createTenantRouter<
  Sources extends Record<string, TenantDataSource<unknown>>,
>(options: { registry: TenantRegistry; sources: Sources; strict?: boolean }) {
  const sources = new Map(
    Object.entries(options.sources).map(([name, source]) => {
      assertMode(source.mode);
      if (
        !name ||
        !source.adapter.name ||
        !source.adapter.capabilities.isolationModes.includes(source.mode)
      )
        throw new TenantRoutingError(
          `Unsupported isolation mode for source ${name}`,
        );
      if (options.strict && source.mode === 'application-filter')
        throw new TenantRoutingError(
          `Strict mode rejects application filtering for source ${name}`,
        );
      return [
        name,
        Object.freeze({ adapter: source.adapter, mode: source.mode }),
      ] as const;
    }),
  );
  return Object.freeze({
    async run<Key extends keyof Sources & string, T>(
      context: Readonly<TenantContext>,
      source: Key,
      work: (
        client: Sources[Key]['adapter'] extends DatabaseAdapter<infer Client>
          ? Client
          : never,
      ) => Promise<T>,
    ): Promise<T> {
      const trustedContext = createTenantContext(context);
      const configured = sources.get(source);
      if (!configured) throw new TenantRoutingError('Unknown data source');
      const resolved = await options.registry.resolve(trustedContext, source);
      if (!resolved) throw new TenantRoutingError('No tenant route');
      // Snapshot registry output: do not retain mutable cache objects across asynchronous work.
      const route = Object.freeze({
        tenantId: resolved.tenantId,
        source: resolved.source,
        adapter: resolved.adapter,
        resource: resolved.resource,
        secretRef: resolved.secretRef,
        revision: resolved.revision,
        status: resolved.status,
        mode: resolved.mode,
      });
      if (
        route.tenantId !== trustedContext.tenantId ||
        route.source !== source ||
        route.adapter !== configured.adapter.name ||
        route.mode !== configured.mode ||
        route.status !== 'active'
      )
        throw new TenantRoutingError(
          'Tenant route does not match the requested active scope',
        );
      if (
        typeof route.resource !== 'string' ||
        !route.resource ||
        typeof route.revision !== 'string' ||
        !route.revision ||
        (route.secretRef !== undefined &&
          (typeof route.secretRef !== 'string' || !route.secretRef))
      )
        throw new TenantRoutingError('Invalid resource references');
      // Client type is determined by the selected source; runtime selection was checked above.
      return configured.adapter.run(
        trustedContext,
        route,
        work as (client: unknown) => Promise<T>,
      );
    },
  });
}
