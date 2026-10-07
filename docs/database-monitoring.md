# PostgreSQL monitoring and application-operation service levels

The current ZipLogger implementation supports PostgreSQL inventory, health and IO, query counter trends,
sanitized SQL and structural plans, blocking investigations, probe and application-operation service levels,
and incident monitors. Use the PostgreSQL page's setup wizard to download the customer installation bundle.
Database credentials stay in the customer Collector/probe. Use verified PostgreSQL and upstream HTTPS TLS,
separate monitoring/probe roles, protected persistent queues and environment-bound databases keys.

The .NET DatabaseOperationReporter exists in current server-repository source; its new package release has
not been published by this implementation task. It records every selected completed operation independently
of trace sampling, includes errors/cancellations and supplies zero-traffic reporter heartbeats. Declare fixed
expected source membership and instrument all selected completions. Missing reporters reduce coverage;
uninstrumented and unfinished operations are outside this population. A source must have one spool owner.

Query counter samples, active-query samples and SELECT 1 probes are distinct populations. Top queries do
not supply application SLO denominators. Plans are estimated unless actual measurements were supplied;
the Collector never automatically requests ANALYZE. Only supported identifiers establish direct
cross-signal relationships. Local fixture checks do not establish production or managed-service acceptance.

The installation bundle includes detailed configuration, grants, Compose/systemd templates and a read-only
diagnostic. Both logs and metrics pass through a private customer gateway; backend credential refusals
retain the Collector queue for repair. Preserve local transport and role-identity secrets across key rotation.
