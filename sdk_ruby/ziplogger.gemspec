# frozen_string_literal: true

require_relative "lib/ziplogger/version"

Gem::Specification.new do |spec|
  spec.name = "ziplogger"
  spec.version = Ziplogger::VERSION
  spec.authors = ["Ahaliav Fox"]
  spec.email = ["support@ziplogger.ai"]

  spec.summary = "Ruby SDK for ZipLogger: batching, retries, backpressure, and automatic enrichment."
  spec.description = "Ruby client and ::Logger for ZipLogger (https://ziplogger.ai). A logging call never " \
                     "blocks and never raises: entries buffer in a bounded queue and ship as NDJSON batches " \
                     "with retry and backoff (429-aware), drop-on-backpressure, and automatic enrichment " \
                     "(source, release, commit SHA, environment, hostname). Standard library only."
  spec.homepage = "https://ziplogger.ai"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.0"

  spec.metadata = {
    "homepage_uri" => "https://ziplogger.ai",
    "source_code_uri" => "https://github.com/ziploggerhq/ZipLogger_Client/tree/main/sdk_ruby",
    "documentation_uri" => "https://github.com/ziploggerhq/ZipLogger_Client/blob/main/docs/ruby.md",
    "changelog_uri" => "https://github.com/ziploggerhq/ZipLogger_Client/blob/main/sdk_ruby/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/ziploggerhq/ZipLogger_Client/issues",
    "rubygems_mfa_required" => "true"
  }

  spec.files = Dir["lib/**/*.rb"] + %w[README.md LICENSE CHANGELOG.md]
  spec.require_paths = ["lib"]

  # Standard library only: net/http, json, socket, logger. No runtime dependencies.
end
