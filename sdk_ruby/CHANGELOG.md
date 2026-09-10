# Changelog

## 0.4.0

First release of the Ruby SDK, versioned in step with the other ZipLogger SDKs.

- `Ziplogger::Client`: non-blocking, never-raising `log` with a bounded queue, NDJSON batches,
  retry with exponential backoff (429 `Retry-After`, 408, 5xx, network), drop-on-backpressure
  with a public `dropped` counter, bounded `flush` / `close`, and an `at_exit` flush.
- Automatic enrichment: `source`, `release`, `commitSha`, `environment` (`RAILS_ENV` and
  `RACK_ENV` honoured), `machineName`, optional `tags`.
- Fork detection: a forked worker (Puma cluster mode, Unicorn, Resque) gets its own shipper thread.
- `Ziplogger::Logger`: a `::Logger` that ships every record; Hash messages become fields,
  exceptions become `stackTrace`, `progname` becomes `fields.category`.
- `Ziplogger::LogDevice`: a `write`/`close` device for frameworks that emit formatted lines.
