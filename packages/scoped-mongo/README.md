# @tenantguard/scoped-mongo

Portable document ownership and aggregation policy shared by the direct MongoDB and Mongoose adapters. It has no Node, framework, BSON or database-driver dependency. The direct adapter's existing guard exports remain available, including @tenantguard/mongodb/guards.

The compiler snapshots restricted JSON data, validates flat identifiers/field allowlists, builds scalar-string ownership predicates and admits only bounded aggregation stages over the scoped stream. It cannot create sessions, connect to a database or authorize tenant membership. Concrete adapters supply verified context, force simple collation and own transaction/session cleanup.

Mongoose uses the same aggregation policy while narrowing CRUD values/declarations to its supported scalar model API. Sharing policy rather than native driver objects allows each adapter to use its own supported MongoDB/BSON/session version.

See the [MongoDB guide](../mongodb/README.md) and [Mongoose guide](../mongoose/README.md) for exact query grammars, lifecycle guarantees and verified support. These are application-filter adapters, which strict routing rejects. No native MongoDB RLS claim is made.
