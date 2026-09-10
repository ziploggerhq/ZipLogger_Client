# frozen_string_literal: true

# ZipLogger Ruby SDK.
#
# Mirrors the delivery semantics of the other official clients:
#   * a logging call never blocks and never raises: delivery is fully asynchronous;
#   * bounded queue with drop-on-backpressure (counted, never unbounded memory);
#   * NDJSON batches over HTTP with retry + exponential backoff, honouring 429 Retry-After;
#   * automatic enrichment: source, release, commit SHA, environment, hostname;
#   * standard library only, no runtime dependencies.
#
#   client = Ziplogger::Client.new(endpoint: "https://app.ziplogger.ai", api_key: "zk_...")
#   client.info("Order created", orderId: 83112)
#
#   logger = Ziplogger::Logger.new(client)        # a ::Logger that ships every record
#   logger.error(exception)                        # => stackTrace + exception fields
require_relative "ziplogger/version"
require_relative "ziplogger/client"
require_relative "ziplogger/logger"

module Ziplogger
end
