# Northwind Coffee — notifications (Ruby)

A small Ruby service that renders order notifications in the customer's language and ships
every log line to ZipLogger through `Ziplogger::Logger`, a `::Logger` subclass, which is how
most Ruby code adopts the SDK: hand it to anything that already takes a logger.

What it demonstrates:

- `Ziplogger::Logger` shipping *and* writing to stdout from one logger, no call sites changed
- Hash messages (`LOG.info(message: "...", customerId: ...)`) becoming searchable fields
- `exception:` in a Hash message becoming a `stackTrace` plus `exceptionType` / `exceptionMessage`

## The deliberate defect

The storefront added Brazilian Portuguese (`pt-BR`) to its locale picker; nobody added a
template for it. `Templates.for` does `TEXT.fetch(locale)`, so every notification for a `pt-BR`
customer raises a real `KeyError` from a real line in `app.rb`. The stack trace ZipLogger
receives resolves to an actual commit in this repository, so "which commit broke this?" has an
honest answer.

## Run

```bash
gem install ziplogger
ZIPLOGGER_API_KEY=zk_... ruby app.rb
```

Or with Docker:

```bash
docker build -t northwind-notifications .
docker run --rm -e ZIPLOGGER_API_KEY=zk_... northwind-notifications
```

Variables, shared with the other demo services: `ZIPLOGGER_ENDPOINT`, `ZIPLOGGER_API_KEY`,
`ZIPLOGGER_ENVIRONMENT`, `DEMO_INTERVAL_SECONDS` (default 8).
