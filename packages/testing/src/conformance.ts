import {
  createTenantContext,
  type DatabaseAdapter,
  type TenantContext,
  type TenantRoute,
} from '@tenantguard/core';

export interface ConformanceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly value: string;
}
/** Each case needs a fresh, isolated fixture with one seeded record for each tenant.
 * Run against real databases to certify an adapter; mocks only test this harness.
 */
export interface AdapterConformanceFixture<Client> {
  readonly adapter: DatabaseAdapter<Client>;
  readonly tenantA: Readonly<TenantContext>;
  readonly tenantB: Readonly<TenantContext>;
  readonly seedA: ConformanceRecord;
  readonly seedB: ConformanceRecord;
  route(context: Readonly<TenantContext>): TenantRoute;
  read(client: Client, id?: string): Promise<readonly ConformanceRecord[]>;
  insert(client: Client, row: ConformanceRecord): Promise<void>;
  update(
    client: Client,
    id: string,
    changes: { tenantId?: string; value?: string },
  ): Promise<number>;
  delete(client: Client, id: string): Promise<number>;
  close(): Promise<void>;
}
export interface AdapterConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}
export class AdapterConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterConformanceError';
  }
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AdapterConformanceError(message);
}
async function rejects(work: () => Promise<unknown>, message: string) {
  let rejected = false;
  try {
    await work();
  } catch {
    rejected = true;
  }
  check(rejected, message);
}
/** Runner-independent cases: register each run function with node:test, Vitest or Jest.
 * transactional selects required behavior, never a silent capability-based skip.
 */
export function adapterConformanceCases<Client>(options: {
  createFixture(): Promise<AdapterConformanceFixture<Client>>;
  transactional: boolean;
  concurrency?: number;
}): readonly AdapterConformanceCase[] {
  const concurrency = options.concurrency ?? 24;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 2 ||
    concurrency > 1000
  )
    throw new TypeError('concurrency must be an integer between 2 and 1000');
  type Fixture = AdapterConformanceFixture<Client>;
  const scoped = <T>(
    f: Fixture,
    context: Readonly<TenantContext>,
    work: (client: Client) => Promise<T>,
  ) => f.adapter.run(context, f.route(context), work);
  const cases: [string, (f: Fixture) => Promise<void>][] = [
    [
      'reads expose only the current tenant',
      async (f) => {
        for (const [context, seed] of [
          [f.tenantA, f.seedA],
          [f.tenantB, f.seedB],
        ] as const) {
          const rows = await scoped(f, context, (client) => f.read(client));
          check(
            rows.length === 1 &&
              rows[0]?.id === seed.id &&
              rows[0]?.tenantId === context.tenantId,
            'Tenant visibility differs from the seeded fixture',
          );
        }
      },
    ],
    [
      'foreign identifiers cannot be read, updated or deleted',
      async (f) => {
        for (const [context, foreign] of [
          [f.tenantA, f.seedB],
          [f.tenantB, f.seedA],
        ] as const) {
          check(
            (await scoped(f, context, (client) => f.read(client, foreign.id)))
              .length === 0,
            'Cross-tenant read exposed a record',
          );
          check(
            (await scoped(f, context, (client) =>
              f.update(client, foreign.id, { value: 'foreign' }),
            )) === 0,
            'Cross-tenant update affected a record',
          );
          check(
            (await scoped(f, context, (client) =>
              f.delete(client, foreign.id),
            )) === 0,
            'Cross-tenant delete affected a record',
          );
        }
      },
    ],
    [
      'own writes persist and remain invisible to the other tenant',
      async (f) => {
        const row = {
          id: 'conformance-own',
          tenantId: f.tenantA.tenantId,
          value: 'new',
        };
        await scoped(f, f.tenantA, (client) => f.insert(client, row));
        check(
          (await scoped(f, f.tenantA, (client) =>
            f.update(client, row.id, { value: 'updated' }),
          )) === 1,
          'Own update failed',
        );
        const rows = await scoped(f, f.tenantA, (client) =>
          f.read(client, row.id),
        );
        check(
          rows.length === 1 && rows[0]?.value === 'updated',
          'Own write did not persist',
        );
        check(
          (await scoped(f, f.tenantB, (client) => f.read(client, row.id)))
            .length === 0,
          'Own write leaked to another tenant',
        );
        check(
          (await scoped(f, f.tenantA, (client) => f.delete(client, row.id))) ===
            1,
          'Own delete failed',
        );
        check(
          (await scoped(f, f.tenantA, (client) => f.read(client, row.id)))
            .length === 0,
          'Own delete did not persist',
        );
      },
    ],
    [
      'foreign inserts and tenant reassignment are rejected',
      async (f) => {
        for (const [context, own, foreign] of [
          [f.tenantA, f.seedA, f.tenantB],
          [f.tenantB, f.seedB, f.tenantA],
        ] as const) {
          await rejects(
            () =>
              scoped(f, context, (client) =>
                f.insert(client, {
                  id: 'conformance-foreign',
                  tenantId: foreign.tenantId,
                  value: 'bad',
                }),
              ),
            'Foreign insert was accepted',
          );
          check(
            (
              await scoped(f, foreign, (client) =>
                f.read(client, 'conformance-foreign'),
              )
            ).length === 0,
            'Rejected foreign insert persisted a record',
          );
          await rejects(
            () =>
              scoped(f, context, (client) =>
                f.update(client, own.id, { tenantId: foreign.tenantId }),
              ),
            'Tenant reassignment was accepted',
          );
          const rows = await scoped(f, context, (client) =>
            f.read(client, own.id),
          );
          check(
            rows.length === 1 && rows[0]?.tenantId === context.tenantId,
            'Rejected reassignment changed ownership',
          );
        }
      },
    ],
    [
      'missing context and mismatched routes deny callback execution',
      async (f) => {
        let called = false;
        const work = async () => {
          called = true;
        };
        await rejects(
          () => f.adapter.run({ tenantId: '' }, f.route(f.tenantA), work),
          'Missing context was accepted',
        );
        await rejects(
          () => f.adapter.run(f.tenantA, f.route(f.tenantB), work),
          'Mismatched route was accepted',
        );
        check(!called, 'Invalid scope invoked application code');
      },
    ],
    [
      'concurrent tenant scopes do not mix',
      async (f) => {
        await Promise.all(
          Array.from({ length: concurrency }, async (_, index) => {
            const context = index % 2 === 0 ? f.tenantA : f.tenantB;
            const rows = await scoped(f, context, async (client) => {
              await Promise.resolve();
              return f.read(client);
            });
            check(
              rows.length > 0 &&
                rows.every((row) => row.tenantId === context.tenantId),
              'Concurrent scopes exposed foreign records',
            );
          }),
        );
      },
    ],
  ];
  if (options.transactional)
    cases.push([
      'callback failure rolls back writes',
      async (f) => {
        check(
          f.adapter.capabilities.transactions,
          'Transactional conformance requires transaction capability',
        );
        const failure = new Error('Conformance rollback sentinel');
        let caught: unknown;
        try {
          await scoped(f, f.tenantA, async (client) => {
            await f.insert(client, {
              id: 'conformance-rollback',
              tenantId: f.tenantA.tenantId,
              value: 'rollback',
            });
            throw failure;
          });
        } catch (error) {
          caught = error;
        }
        check(caught === failure, 'Adapter did not preserve callback error');
        check(
          (
            await scoped(f, f.tenantA, (client) =>
              f.read(client, 'conformance-rollback'),
            )
          ).length === 0,
          'Failed callback persisted a write',
        );
      },
    ]);
  return Object.freeze(
    cases.map(([name, run]) =>
      Object.freeze({
        name,
        async run() {
          const fixture = await options.createFixture();
          let failed = false;
          let failure: unknown;
          try {
            createTenantContext(fixture.tenantA);
            createTenantContext(fixture.tenantB);
            check(
              fixture.tenantA.tenantId !== fixture.tenantB.tenantId,
              'Fixture requires distinct tenant IDs',
            );
            check(
              fixture.seedA.id !== fixture.seedB.id &&
                fixture.seedA.tenantId === fixture.tenantA.tenantId &&
                fixture.seedB.tenantId === fixture.tenantB.tenantId,
              'Fixture seeds do not match tenant identities',
            );
            await run(fixture);
          } catch (error) {
            failed = true;
            failure = error;
          }
          try {
            await fixture.close();
          } catch (cleanup) {
            if (failed)
              throw new AggregateError(
                [failure, cleanup],
                'Conformance case and fixture cleanup failed',
              );
            throw cleanup;
          }
          if (failed) throw failure;
        },
      }),
    ),
  );
}
