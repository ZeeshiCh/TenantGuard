# Compatibility matrix

This table records the versions exercised by the repository's real integration and packed-consumer tests. An entry means the documented API and lifecycle tests pass for the listed combination; it does not imply support for every provider feature or topology.

| Runtime / integration | Verified versions                        | Isolation mode                             | Status                                              |
| --------------------- | ---------------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| Node                  | 22.23.4, 25.9.0 local                    | All adapter modes through explicit context | Tested                                              |
| NestJS + TypeORM      | NestJS 11, TypeORM 0.3, PostgreSQL 17    | PostgreSQL native RLS                      | Tested                                              |
| Hono                  | Hono 4, Node HTTP bridge                 | PostgreSQL native RLS example              | Tested by example typecheck; Docker HTTP test in CI |
| Express               | Express 5                                | Adapter-dependent                          | Real HTTP tested                                    |
| Fastify               | Fastify 5                                | Adapter-dependent                          | Real HTTP tested                                    |
| Koa                   | Koa 3                                    | Adapter-dependent                          | Real HTTP tested                                    |
| PostgreSQL direct pg  | PostgreSQL 17, pg 8                      | Native RLS                                 | Real conformance tested                             |
| SQL Server            | SQL Server 2022 Developer, Tedious 19    | Native RLS                                 | Real conformance tested; x86 image                  |
| MySQL                 | MySQL 8.4, mysql2 3                      | Application filter / InnoDB                | Real conformance tested                             |
| MariaDB               | MariaDB 11.8, mariadb 3                  | Application filter / InnoDB                | Real conformance tested                             |
| MongoDB               | MongoDB 8 replica set, mongodb 6         | Application filter                         | Real replica-set tested                             |
| SQLite                | Node built-in SQLite, file database      | Application filter                         | Real file tested                                    |
| Prisma                | Prisma 7.10.1, PostgreSQL/MySQL/MariaDB  | Application filter                         | Real conformance tested                             |
| Drizzle               | Drizzle 0.45.4, PostgreSQL/MySQL/MariaDB | Application filter                         | Real conformance tested                             |
| Mongoose              | Mongoose 9.12, MongoDB 8 replica set     | Application filter                         | Real session tested                                 |

The compatibility boundary is intentionally narrower than the package dependency ranges. Other Node versions, database versions, cloud proxies, sharding, read replicas, integrated SQL Server authentication, edge runtimes and additional ORM providers require a separate test job before being labeled supported. Application-filter adapters cannot prevent a caller with the underlying native handle from bypassing the facade; strict routing rejects that mode when native database enforcement is required.
