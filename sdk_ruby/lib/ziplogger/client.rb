# frozen_string_literal: true

require "json"
require "net/http"
require "socket"
require "time"
require "uri"

module Ziplogger
  # Ships log entries to ZipLogger in the background.
  #
  # Design goals (mirroring the official .NET client):
  #   * +log+ never blocks and never raises: entries go onto a bounded in-memory queue and a
  #     worker thread ships them as NDJSON batches;
  #   * when the queue is full the entry is dropped and counted in +dropped+, so a slow or dead
  #     endpoint can never grow the process without bound;
  #   * transient failures (429 honouring Retry-After, 408, 5xx, network errors) retry with
  #     exponential backoff and jitter; non-transient responses drop the batch immediately.
  class Client
    SEVERITIES = %w[debug info warn error fatal].freeze
    DEFAULT_ENDPOINT = "https://app.ziplogger.ai"

    # Entries lost to backpressure, exhausted retries, non-transient responses, or entries that
    # could not be serialised. Non-zero means real loss: alert on it in long-running services.
    attr_reader :dropped

    # The resolved ingestion URL, for diagnostics.
    attr_reader :url

    # Bracketed values are the enrichment defaults: option, then environment variables, then the
    # runtime. Options passed in code always win.
    #
    # @param endpoint [String] server origin; +/ingest/v1/logs+ is appended unless the value
    #   already ends with +/logs+
    # @param api_key [String] ingestion key, sent as +X-Api-Key+
    # @param source [String, nil] service name [ZIPLOGGER_SOURCE, then the script name]
    # @param release [String, nil] build version [ZIPLOGGER_RELEASE]
    # @param commit_sha [String, nil] [ZIPLOGGER_COMMIT_SHA, GIT_COMMIT, COMMIT_SHA]
    # @param environment [String, nil] [ZIPLOGGER_ENVIRONMENT, ENVIRONMENT, RAILS_ENV, RACK_ENV,
    #   then "production"]
    # @param tags [Array<String>, nil] tags added to every entry
    # @param queue_size [Integer] max buffered entries; beyond it entries are dropped and counted
    # @param batch_size [Integer] entries per HTTP request
    # @param flush_interval [Float] seconds: the maximum age of the oldest buffered entry before a
    #   partial batch ships (not an idle timeout, see #pump)
    # @param max_retries [Integer] retry attempts per batch after the first try
    # @param retry_base_delay [Float] seconds before the first retry; doubles per attempt
    # @param retry_max_delay [Float] ceiling on any single backoff
    # @param timeout [Float] per-request HTTP open/read/write timeout in seconds
    def initialize(endpoint:, api_key:, source: nil, release: nil, commit_sha: nil, environment: nil,
                   tags: nil, queue_size: 10_000, batch_size: 100, flush_interval: 2.0, max_retries: 5,
                   retry_base_delay: 0.5, retry_max_delay: 30.0, timeout: 10.0)
      raise ArgumentError, "ZipLogger: endpoint is required" if blank?(endpoint)
      raise ArgumentError, "ZipLogger: api_key is required" if blank?(api_key)

      trimmed = endpoint.to_s.sub(%r{/+\z}, "")
      @url = trimmed.match?(%r{/logs\z}i) ? trimmed : "#{trimmed}/ingest/v1/logs"
      @uri = begin
        URI.parse(@url)
      rescue URI::Error
        nil
      end
      raise ArgumentError, "ZipLogger: endpoint must be an http(s) URL" unless @uri.is_a?(URI::HTTP) && @uri.host

      @api_key = api_key.to_s
      @capacity = [queue_size.to_i, 1].max
      @batch_size = [batch_size.to_i, 1].max
      @flush_interval = [flush_interval.to_f, 0.0].max
      @max_retries = [max_retries.to_i, 0].max
      @retry_base_delay = [retry_base_delay.to_f, 0.0].max
      @retry_max_delay = [retry_max_delay.to_f, 0.0].max
      @timeout = timeout.to_f

      # Resolved once at startup rather than per entry, as the HTTP API guide recommends.
      @source = presence(source) || env("ZIPLOGGER_SOURCE") || default_source
      @release = presence(release) || env("ZIPLOGGER_RELEASE")
      @commit_sha = presence(commit_sha) || env("ZIPLOGGER_COMMIT_SHA", "GIT_COMMIT", "COMMIT_SHA")
      @environment = presence(environment) ||
                     env("ZIPLOGGER_ENVIRONMENT", "ENVIRONMENT", "RAILS_ENV", "RACK_ENV") ||
                     "production"
      @hostname = hostname
      @tags = tags.nil? || tags.empty? ? nil : tags.map(&:to_s).freeze

      @dropped = 0
      @queue = []          # entries and Flush markers, oldest first; guarded by @mutex
      @mutex = Mutex.new
      @cond = ConditionVariable.new # wakes the worker: new entry, flush request, or close
      @closing = false
      @http = nil          # persistent Net::HTTP session, touched only by the worker thread
      @pid = Process.pid
      @worker = start_worker

      # Ruby kills non-main threads only after at_exit hooks run, so the worker is still there to
      # drain the queue. close is idempotent, so an explicit close beforehand costs nothing.
      at_exit { close }
    end

    # Queue one entry for background delivery. Never blocks, never raises.
    #
    # @param severity [String, Symbol] debug | info | warn | error | fatal (unknown => info)
    # @param message [String, Exception] the log line; an Exception is unpacked as +exception:+
    # @param fields [Hash] searchable key/values; +environment+ and +machineName+ are added
    # @param exception [Exception, nil] becomes +stackTrace+, +fields.exceptionType+ and
    #   +fields.exceptionMessage+
    # @param stack_trace [String, nil] a pre-rendered stack trace, when there is no Exception object
    # @param timestamp [Time, String, nil] defaults to now
    # @param source, release, commit_sha, tags per-entry overrides of the client defaults
    # @return [Boolean] true if the entry was queued, false if it was dropped
    def log(severity:, message:, fields: {}, exception: nil, stack_trace: nil, timestamp: nil,
            source: nil, release: nil, commit_sha: nil, tags: nil)
      if message.is_a?(Exception) && exception.nil?
        exception = message
        message = exception_message(exception)
      end
      entry = build_entry(severity, message, fields, exception, stack_trace, timestamp,
                          source, release, commit_sha, tags)
      enqueue(entry)
    rescue StandardError
      # Formatting must never break the application. The entry is lost; say so in the counter.
      count_dropped(1)
      false
    end

    # Convenience methods: +client.info("Order created", orderId: 83112)+. Keyword arguments become
    # fields; +exception:+ is reserved and mapped to the stack trace.
    SEVERITIES.each do |severity|
      define_method(severity) do |message, exception: nil, **fields|
        log(severity: severity, message: message, fields: fields, exception: exception)
      end
    end

    # Ship everything queued before this call, waiting at most +timeout+ seconds.
    # The client stays usable afterwards (use this in warm-start runtimes such as Lambda).
    # @return [Boolean] true if the queue was drained in time
    def flush(timeout: 5)
      marker = nil
      worker = nil
      @mutex.synchronize do
        ensure_worker_locked unless @closing
        worker = @worker
        unless @closing
          marker = Flush.new
          @queue << marker # markers never count against the capacity
          @cond.signal
        end
      end
      return marker.wait(timeout) if marker

      # Already shutting down: the worker is draining on its own, so just wait for it.
      worker.join(timeout) unless worker.nil? || worker == Thread.current
      worker.nil? || !worker.alive?
    rescue StandardError
      false
    end

    # Stop accepting entries, ship what is buffered (bounded by +timeout+ seconds) and stop the
    # worker. Entries logged after close are dropped and counted. Idempotent.
    # @return [Boolean] true if everything was shipped before the timeout
    def close(timeout: 5)
      worker = nil
      @mutex.synchronize do
        @closing = true
        worker = @worker
        @cond.broadcast
      end
      return true if worker.nil? || worker == Thread.current

      worker.join(timeout)
      !worker.alive?
    rescue StandardError
      false
    end

    def closed?
      @mutex.synchronize { @closing }
    end

    private

    # ---------------------------------------------------------------- entries

    def build_entry(severity, message, fields, exception, stack_trace, timestamp, source, release,
                    commit_sha, tags)
      # Enrichment defaults first, then the caller's fields, so an explicit per-entry value wins.
      merged = { "environment" => @environment, "machineName" => @hostname }
      (fields || {}).each { |key, value| merged[key.to_s] = normalize(value) }

      entry = {
        "timestamp" => format_timestamp(timestamp),
        "severity" => normalize_severity(severity),
        "message" => clean_string(message.nil? ? "" : message.to_s),
        "source" => presence(source) || @source
      }
      rel = presence(release) || @release
      sha = presence(commit_sha) || @commit_sha
      entry["release"] = rel if rel
      entry["commitSha"] = sha if sha

      if exception.is_a?(Exception)
        # The full class + message + backtrace is what feeds "which commit broke this?" analysis.
        stack_trace = render_exception(exception)
        merged["exceptionType"] = exception.class.name
        merged["exceptionMessage"] = clean_string(exception_message(exception))
      end
      entry["stackTrace"] = clean_string(stack_trace.to_s) if stack_trace

      entry["fields"] = merged
      entry_tags = tags.nil? ? @tags : tags.map(&:to_s)
      entry["tags"] = entry_tags if entry_tags && !entry_tags.empty?
      entry
    end

    def normalize_severity(severity)
      name = severity.to_s.downcase
      return "warn" if name == "warning"
      return "fatal" if name == "critical"

      SEVERITIES.include?(name) ? name : "info"
    end

    def format_timestamp(timestamp)
      case timestamp
      when nil then Time.now.utc.iso8601(3)
      when Time then timestamp.utc.iso8601(3)
      else
        timestamp.respond_to?(:to_time) ? timestamp.to_time.utc.iso8601(3) : timestamp.to_s
      end
    end

    # Field values that JSON can carry pass through; everything else is stringified so a model
    # object or a Struct arrives readable rather than failing serialisation. Nesting is capped so a
    # self-referencing structure cannot recurse forever.
    def normalize(value, depth = 0)
      case value
      when String then clean_string(value)
      when Symbol then value.to_s
      when Integer, true, false, nil then value
      when Float then value.finite? ? value : value.to_s # NaN/Infinity are not valid JSON
      when Time then value.utc.iso8601(3)
      when Hash
        return value.to_s if depth >= 4

        value.each_with_object({}) { |(k, v), h| h[k.to_s] = normalize(v, depth + 1) }
      when Array
        return value.to_s if depth >= 4

        value.map { |v| normalize(v, depth + 1) }
      else
        clean_string(value.to_s)
      end
    rescue StandardError
      value.class.name
    end

    # JSON generation rejects strings with invalid bytes; scrub rather than lose the entry.
    def clean_string(string)
      return string if string.encoding == Encoding::UTF_8 && string.valid_encoding?

      string.encode(Encoding::UTF_8, invalid: :replace, undef: :replace, replace: "�")
    rescue StandardError
      string.b.encode(Encoding::UTF_8, invalid: :replace, undef: :replace, replace: "�")
    end

    def exception_message(exception)
      message = exception.message.to_s
      message.empty? ? exception.class.name : message
    rescue StandardError
      exception.class.name
    end

    # "KeyError: key not found" followed by the backtrace, then the cause chain the way Ruby prints
    # it, so the trace ZipLogger clusters on is the one a developer would see in a terminal.
    def render_exception(exception)
      lines = []
      current = exception
      depth = 0
      while current && depth < 5
        lines << "Caused by:" if depth.positive?
        lines << "#{current.class.name}: #{exception_message(current)}"
        (current.backtrace || []).each { |frame| lines << "    from #{frame}" }
        current = current.cause
        depth += 1
      end
      lines.join("\n")
    end

    # ---------------------------------------------------------------- queue

    def enqueue(entry)
      @mutex.synchronize do
        if @closing
          @dropped += 1
          return false
        end
        ensure_worker_locked
        if @queue.length >= @capacity
          @dropped += 1 # backpressure: drop, never grow
          return false
        end
        @queue << entry
        @cond.signal
        true
      end
    end

    def count_dropped(count)
      @mutex.synchronize { @dropped += count }
    end

    # Must be called with @mutex held. A forked child (Puma cluster mode, Unicorn, Resque,
    # Spring) inherits the queue but not the worker thread, so entries would buffer forever.
    # Detect the new pid, discard the parent's copies (the parent still ships them itself) and
    # start a fresh worker. Also revives a worker that died, which the pump makes unlikely.
    def ensure_worker_locked
      if @pid != Process.pid
        @pid = Process.pid
        @queue.clear
        @http = nil
        @worker = start_worker
      elsif @worker.nil? || !@worker.alive?
        @worker = start_worker
      end
    end

    def start_worker
      thread = Thread.new { pump }
      thread.name = "ziplogger-shipper"
      thread.report_on_exception = false # pump handles its own errors; never spam stderr
      thread
    end

    # Blocks until an entry or Flush marker is available, the deadline passes (returns nil), or the
    # client is closing with an empty queue (returns CLOSE).
    def take(deadline)
      @mutex.synchronize do
        loop do
          return @queue.shift unless @queue.empty?
          return CLOSE if @closing

          if deadline
            remaining = deadline - monotonic
            return nil if remaining <= 0

            @cond.wait(@mutex, remaining)
          else
            @cond.wait(@mutex)
          end
        end
      end
    end

    # ---------------------------------------------------------------- worker

    def pump
      batch = []
      # When the batch must go out regardless of what arrives next. flush_interval is the maximum
      # age of the oldest entry in a batch, not an idle timeout: re-arming the wait on every
      # arrival would mean a service logging steadily faster than the interval never went idle, so
      # nothing shipped until the batch hit batch_size: 100 seconds of held logs at one record a
      # second.
      deadline = nil
      loop do
        item = take(deadline)
        case item
        when CLOSE
          send_batch(batch)
          return
        when Flush
          # Everything queued before the marker is in the batch or already sent; ship it now.
          send_batch(batch)
          batch = []
          deadline = nil
          item.complete!
          next
        when nil
          # The oldest entry reached flush_interval.
        else
          batch << item
          deadline ||= monotonic + @flush_interval # first entry of a new batch starts the clock
        end

        if batch.length >= @batch_size || (item.nil? && !batch.empty?)
          send_batch(batch)
          batch = []
          deadline = nil
        end
      end
    rescue StandardError
      # A bug in the worker must not silently stop shipping: drop what was in hand and carry on.
      count_dropped(batch.length) if batch
      retry unless closed?
    ensure
      finish_connection
    end

    def send_batch(batch)
      return if batch.empty?

      lines = []
      batch.each do |entry|
        lines << JSON.generate(entry)
      rescue StandardError
        count_dropped(1) # one unserialisable entry must not sink its 99 neighbours
      end
      return if lines.empty?

      payload = lines.join("\n")
      attempt = 0
      loop do
        retry_after = nil
        begin
          response = post(payload)
          code = response.code.to_i
          return if code >= 200 && code < 300

          if code != 408 && code != 429 && code < 500
            count_dropped(lines.length) # 400/401/403...: retrying cannot help
            return
          end
          retry_after = parse_retry_after(response["Retry-After"])
        rescue StandardError
          finish_connection # network failure / timeout: transient, start the next try on a fresh socket
        end

        if attempt >= @max_retries
          count_dropped(lines.length)
          return
        end
        backoff = [@retry_base_delay * (2**attempt), @retry_max_delay].min * (1 + rand * 0.2)
        delay = [retry_after || backoff, @retry_max_delay].min
        backoff_sleep(delay)
        attempt += 1
      end
    end

    def parse_retry_after(header)
      return nil if header.nil? || header.strip.empty?

      Float(header)
    rescue ArgumentError, TypeError
      nil # an HTTP-date is legal but rare; fall back to backoff
    end

    # Waits for the backoff, but wakes early when close is called so shutdown is not held hostage
    # by a slow endpoint; once closing, remaining attempts pause at most 250 ms each.
    def backoff_sleep(seconds)
      if closed?
        sleep([seconds, 0.25].min)
        return
      end
      deadline = monotonic + seconds
      @mutex.synchronize do
        while !@closing && (remaining = deadline - monotonic).positive?
          @cond.wait(@mutex, remaining)
        end
      end
    end

    # ---------------------------------------------------------------- http

    def post(payload)
      request = Net::HTTP::Post.new(@uri.request_uri,
                                    "Content-Type" => "application/x-ndjson",
                                    "X-Api-Key" => @api_key,
                                    "User-Agent" => "ziplogger-ruby/#{VERSION}")
      request.body = payload
      connection.request(request)
    end

    # One persistent session per worker. Net::HTTP reconnects by itself when the socket was idle
    # longer than keep_alive_timeout, and any error mid-request finishes the session so the retry
    # starts clean. Proxies come from the usual http_proxy / https_proxy variables.
    def connection
      @http ||= begin
        http = Net::HTTP.new(@uri.host, @uri.port)
        http.use_ssl = @uri.scheme == "https"
        http.open_timeout = @timeout
        http.read_timeout = @timeout
        http.write_timeout = @timeout if http.respond_to?(:write_timeout=)
        # Ruby's default is 2 s, which would reconnect on nearly every 2 s linger flush. Servers
        # and load balancers keep idle connections open far longer than 15 s.
        http.keep_alive_timeout = 15
        http.start
        http
      end
    end

    def finish_connection
      http = @http
      @http = nil
      http&.finish if http&.started?
    rescue StandardError
      nil
    end

    # ---------------------------------------------------------------- helpers

    def monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def blank?(value)
      value.nil? || value.to_s.strip.empty?
    end

    def presence(value)
      blank?(value) ? nil : value.to_s
    end

    def env(*names)
      names.each do |name|
        value = ENV.fetch(name, nil)
        return value unless blank?(value)
      end
      nil
    end

    def default_source
      name = File.basename($PROGRAM_NAME.to_s, ".*")
      blank?(name) ? "ruby" : name
    rescue StandardError
      "ruby"
    end

    def hostname
      Socket.gethostname
    rescue StandardError
      "unknown"
    end

    # Sentinel returned by #take once the client is closing and the queue is drained.
    CLOSE = Object.new.freeze
    private_constant :CLOSE

    # A flush request travelling through the queue: when the worker reaches it, everything queued
    # before it has been handed to send_batch, and the caller waiting in #flush is released.
    class Flush
      def initialize
        @mutex = Mutex.new
        @cond = ConditionVariable.new
        @done = false
      end

      def complete!
        @mutex.synchronize do
          @done = true
          @cond.broadcast
        end
      end

      # @return [Boolean] true if the flush completed within +timeout+ seconds
      def wait(timeout)
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout.to_f
        @mutex.synchronize do
          until @done
            remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
            return false if remaining <= 0

            @cond.wait(@mutex, remaining)
          end
          true
        end
      end
    end
    private_constant :Flush
  end
end
