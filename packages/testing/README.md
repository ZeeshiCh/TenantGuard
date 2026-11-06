# Adapter conformance tests

`adapterConformanceCases` provides runner-independent async cases for tenant visibility, foreign identifiers, CRUD persistence, insert/ownership boundaries, invalid context/routes, concurrent scopes and optional transactional rollback. Register each case with your test runner:

```ts
const cases = adapterConformanceCases({
  transactional: true,
  createFixture: async () => createFreshRealDatabaseFixture(),
});
for (const entry of cases) test(entry.name, entry.run);
```

The fixture implements `AdapterConformanceFixture<Client>`: supply the real adapter, two distinct tenant contexts, one seeded record per tenant, route lookup and driver-specific CRUD functions. Each case calls createFixture and always closes a successfully created fixture. Fixture creation must clean up its own partial failures. Concurrently scheduled cases require independently isolated datasets. The repository integration runner executes subtests sequentially against reset data.

Set transactional to true to require rollback behavior; the harness fails if the adapter lacks that capability. False omits this case explicitly, rather than silently skipping based on the adapter's claim. Driver-specific cleanup, timeouts, session contamination and privilege checks require additional integration tests.

Mock fixtures in unit tests validate the harness, not database isolation. The PostgreSQL TypeORM adapter runs these same cases against a real PostgreSQL container. Passing this suite is regression evidence, not a complete security audit.
