# Reproducible benchmarks

Run from the repository with development dependencies installed:

```sh
pnpm benchmark --engine core --iterations 1000 --warmup 100
pnpm benchmark --engine all --iterations 100 --warmup 10 > benchmark.json
```

`core` is the default and needs no database. `all` additionally creates disposable PostgreSQL 17 and real temporary SQLite fixtures using the same infrastructure as integration tests; Docker must be running. `postgres` and `sqlite` select those engines individually. No supplied production credentials or databases are used. Counts must be integers from 1 to 10000. JSON is emitted only after all selected cases and cleanup succeed; errors use a nonzero exit without a partial performance report.

The versioned JSON records Node version, OS, architecture, CPU, sample/warmup counts, concurrency, milliseconds per complete operation, mean/min/max, nearest-rank p50/p95 and reciprocal mean throughput. Warmup is excluded. Every measured operation checks its result, preventing timings for failed or optimized-away work. Runs are serial at concurrency one, with no automatic regression threshold. CPU scheduling, containers, JIT, assertions and awaited callback overhead all affect results. Small core durations require repeated larger runs before drawing conclusions.

| Case                           | Work included                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Core direct callback           | Increment and async measurement boundary                                                                       |
| Node context scope             | Create/validate scope, AsyncLocalStorage and context assertion                                                 |
| Authorization/context          | Membership resolver, context validation and callback                                                           |
| Authorized routed memory scope | Authorization, registry lookup, route/capability validation and memory adapter callback                        |
| PostgreSQL manual scope        | Acquire restricted connection, BEGIN, transaction-local tenant context, fixture read and COMMIT/release        |
| PostgreSQL guarded scope       | Direct pg adapter's full acquisition, role/policy/schema checks, tenant transaction, fixture read and cleanup  |
| SQLite prepared direct read    | Synchronous prepared read on an existing connection with a binary tenant predicate                             |
| SQLite guarded scope           | Worker creation, fresh connection, schema verification, scoped read, transaction settlement and worker cleanup |

These are complete-operation measurements, not interchangeable query latency baselines. In particular, SQLite worker/transaction lifecycle costs cannot be attributed solely to predicate injection. PostgreSQL manual scope is a performance baseline, not a recommended replacement for adapter safety checks. Benchmarks do not establish isolation, security or production capacity. MySQL, MariaDB, MongoDB, SQL Server, frameworks, ORM adapters, contention/load and memory profiles remain future benchmark coverage; their correctness is covered separately by integration tests.

[Recorded local run](results/local-node25.json): Node 25.9.0, 30 measured operations plus 5 warmups per case. This is reproducibility evidence, not a performance promise. Re-run on your deployment hardware and compare matching runtimes, sample counts, datasets and database images.
