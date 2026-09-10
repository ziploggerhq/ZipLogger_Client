# frozen_string_literal: true

require_relative "test_helper"

class ClientTest < Minitest::Test
  include ClientHelpers

  def test_batches_entries_as_ndjson_with_api_key_and_enrichment
    unset = { "ZIPLOGGER_ENVIRONMENT" => nil, "ENVIRONMENT" => nil, "RAILS_ENV" => nil, "RACK_ENV" => nil }
    client = with_env(unset) { make_client(source: "unit-test", release: "1.2.3", commit_sha: "abc1234") }
    5.times { |i| client.log(severity: :info, message: "event #{i}", fields: { i: i }) }
    client.close

    @server.wait_for(1)
    assert_equal 1, @server.requests.length
    req = @server.requests[0]
    assert_equal "/ingest/v1/logs", req[:path]
    assert_equal "zk_test", req[:api_key]
    assert_equal "application/x-ndjson", req[:content_type]
    assert_equal 5, req[:lines].length
    first = req[:lines][0]
    assert_equal "event 0", first["message"]
    assert_equal "info", first["severity"]
    assert_equal "unit-test", first["source"]
    assert_equal "1.2.3", first["release"]
    assert_equal "abc1234", first["commitSha"]
    assert_equal 0, first["fields"]["i"]
    refute_empty first["fields"]["machineName"]
    assert_equal "production", first["fields"]["environment"]
    assert_match(/\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\z/, first["timestamp"])
    assert_equal 0, client.dropped
  end

  def test_exception_maps_to_stack_trace_and_exception_fields
    client = make_client
    begin
      raise KeyError, "boom"
    rescue KeyError => e
      client.log(severity: :error, message: "it failed", exception: e)
    end
    client.close

    @server.wait_for(1)
    entry = @server.requests[0][:lines][0]
    assert_equal "error", entry["severity"]
    assert_equal "it failed", entry["message"]
    assert_match(/\AKeyError: boom\n\s+from .*client_test\.rb:\d+/, entry["stackTrace"])
    assert_equal "KeyError", entry["fields"]["exceptionType"]
    assert_equal "boom", entry["fields"]["exceptionMessage"]
  end

  def test_exception_as_message_and_cause_chain
    client = make_client
    begin
      begin
        raise IOError, "disk"
      rescue IOError
        raise RuntimeError, "wrapped"
      end
    rescue RuntimeError => e
      client.error(e, jobId: 42)
    end
    client.close

    @server.wait_for(1)
    entry = @server.requests[0][:lines][0]
    assert_equal "wrapped", entry["message"]
    assert_equal "RuntimeError", entry["fields"]["exceptionType"]
    assert_equal 42, entry["fields"]["jobId"]
    assert_includes entry["stackTrace"], "Caused by:\nIOError: disk"
  end

  def test_severity_mapping_and_convenience_methods
    client = make_client
    client.debug("d")
    client.info("i")
    client.warn("w")
    client.error("e")
    client.fatal("f")
    client.log(severity: "WARNING", message: "alias")
    client.log(severity: :nonsense, message: "unknown")
    client.close

    @server.wait_for(1)
    severities = @server.requests.flat_map { |r| r[:lines] }.map { |l| l["severity"] }
    assert_equal %w[debug info warn error fatal warn info], severities
  end

  def test_retries_on_429_then_succeeds_without_dropping
    @server.responses.concat([429, 429, 202])
    client = make_client
    client.info("retry me")
    @server.wait_for(3)
    client.close

    assert_equal [429, 429, 202], @server.requests.map { |r| r[:status] }
    assert_equal 0, client.dropped
    assert_equal @server.requests[0][:lines][0]["message"], @server.requests[2][:lines][0]["message"]
  end

  def test_drops_the_batch_after_max_retries
    @server.responses.concat([500, 503, 500])
    client = make_client(max_retries: 2)
    client.info("doomed")
    wait_until { client.dropped >= 1 }

    assert_equal 3, @server.requests.length # initial + 2 retries
    assert_equal 1, client.dropped
    client.close
  end

  def test_non_transient_errors_do_not_retry
    @server.responses << 401
    client = make_client
    client.info("bad key")
    wait_until { client.dropped >= 1 }
    client.close

    assert_equal 1, @server.requests.length
    assert_equal 1, client.dropped
  end

  def test_network_errors_are_transient
    dead = TCPServer.new("127.0.0.1", 0)
    port = dead.addr[1]
    dead.close
    client = Ziplogger::Client.new(endpoint: "http://127.0.0.1:#{port}", api_key: "zk_test",
                                   flush_interval: 0.01, retry_base_delay: 0.01, max_retries: 1)
    @clients << client
    client.info("nobody home")
    wait_until { client.dropped >= 1 }
    assert_equal 1, client.dropped
  end

  def test_queue_overflow_drops_instead_of_blocking
    # Hold the worker inside one slow request so the burst below meets a queue nobody is draining.
    @server.response_delay = 0.5
    client = make_client(queue_size: 3, batch_size: 1, flush_interval: 60)
    client.info("blocker")
    @server.wait_for(1)

    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    50.times { |i| client.info("burst #{i}") }
    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 0.4, "log must not block"
    assert_equal 47, client.dropped # 3 queued, the rest dropped and counted
    @server.response_delay = nil
    client.close
  end

  def test_large_volumes_split_into_batches_of_batch_size
    client = make_client(batch_size: 10)
    25.times { |i| client.info("m#{i}") }
    client.close

    sizes = @server.requests.map { |r| r[:lines].length }
    assert_equal 25, sizes.sum
    assert_operator sizes.max, :<=, 10
  end

  def test_flush_interval_is_the_max_age_of_the_oldest_entry_not_an_idle_timeout
    client = make_client(flush_interval: 0.2, batch_size: 1000)
    # Log steadily faster than the interval: an idle-timeout implementation would never ship.
    12.times do
      client.info("steady")
      sleep 0.05
    end
    assert_operator @server.requests.length, :>=, 1, "a partial batch must ship once its oldest entry is 200 ms old"
    client.close
  end

  def test_flush_sends_remaining_entries_and_keeps_the_client_usable
    client = make_client(flush_interval: 60)
    client.info("before flush")
    assert client.flush(timeout: 5)
    assert_equal 1, @server.requests.length
    assert_equal "before flush", @server.requests[0][:lines][0]["message"]

    client.info("after flush")
    client.close
    assert_equal 2, @server.requests.length
    assert_equal "after flush", @server.requests[1][:lines][0]["message"]
  end

  def test_close_flushes_and_then_drops_new_entries
    client = make_client(flush_interval: 60)
    client.info("last words")
    assert client.close
    assert client.closed?
    assert_equal 1, @server.requests.length

    refute client.log(severity: :info, message: "too late")
    assert_equal 1, client.dropped
    assert client.close, "close is idempotent"
  end

  def test_endpoint_already_ending_in_logs_is_not_suffixed
    client = make_client(endpoint: "#{@server.url}/custom/logs/")
    assert_equal "#{@server.url}/custom/logs", client.url
    client.info("custom path")
    client.close
    assert_equal "/custom/logs", @server.requests[0][:path]
  end

  def test_constructor_validates_required_options
    assert_raises(ArgumentError) { Ziplogger::Client.new(endpoint: "", api_key: "zk") }
    assert_raises(ArgumentError) { Ziplogger::Client.new(endpoint: @server.url, api_key: nil) }
    assert_raises(ArgumentError) { Ziplogger::Client.new(endpoint: "not a url", api_key: "zk") }
  end

  def test_env_var_enrichment
    env = {
      "ZIPLOGGER_SOURCE" => "env-source", "ZIPLOGGER_RELEASE" => "9.9.9",
      "ZIPLOGGER_COMMIT_SHA" => nil, "GIT_COMMIT" => "deadbeef", "COMMIT_SHA" => nil,
      "ZIPLOGGER_ENVIRONMENT" => nil, "ENVIRONMENT" => nil, "RAILS_ENV" => "staging", "RACK_ENV" => nil
    }
    client = with_env(env) { make_client }
    client.info("from env")
    client.close

    entry = @server.requests[0][:lines][0]
    assert_equal "env-source", entry["source"]
    assert_equal "9.9.9", entry["release"]
    assert_equal "deadbeef", entry["commitSha"]
    assert_equal "staging", entry["fields"]["environment"]
  end

  def test_options_win_over_env_vars_and_rack_env_is_honoured
    env = { "ZIPLOGGER_SOURCE" => "env-source", "ZIPLOGGER_ENVIRONMENT" => nil, "ENVIRONMENT" => nil,
            "RAILS_ENV" => nil, "RACK_ENV" => "development" }
    client = with_env(env) { make_client(source: "explicit") }
    client.info("x")
    client.close

    entry = @server.requests[0][:lines][0]
    assert_equal "explicit", entry["source"]
    assert_equal "development", entry["fields"]["environment"]
    assert_nil entry["release"]
  end

  def test_tags_and_per_entry_overrides
    client = make_client(tags: %w[demo ruby], source: "default-source")
    client.info("tagged")
    client.log(severity: :info, message: "override", source: "other", tags: ["one"], release: "r2",
               commit_sha: "c2", timestamp: Time.utc(2026, 1, 2, 3, 4, 5, 678_000))
    client.close

    tagged, override = @server.requests[0][:lines]
    assert_equal %w[demo ruby], tagged["tags"]
    assert_equal "default-source", tagged["source"]
    assert_equal ["one"], override["tags"]
    assert_equal "other", override["source"]
    assert_equal "r2", override["release"]
    assert_equal "c2", override["commitSha"]
    assert_equal "2026-01-02T03:04:05.678Z", override["timestamp"]
  end

  def test_field_values_are_normalised_and_never_break_serialisation
    hostile = Object.new
    def hostile.to_s
      raise "no string for you"
    end
    client = make_client
    client.info("fields", sym: :value, time: Time.utc(2026, 1, 1), nested: { a: [1, { b: 2 }] },
                          nan: Float::NAN, obj: hostile, binary: "caf\xE9".b)
    client.close

    fields = @server.requests[0][:lines][0]["fields"]
    assert_equal "value", fields["sym"]
    assert_equal "2026-01-01T00:00:00.000Z", fields["time"]
    assert_equal({ "a" => [1, { "b" => 2 }] }, fields["nested"])
    assert_equal "NaN", fields["nan"]
    assert_equal "Object", fields["obj"]
    assert_equal "caf\uFFFD", fields["binary"]
    assert_equal 0, client.dropped
  end

  def test_logging_call_never_raises
    client = make_client
    assert_nothing_raised_here { client.log(severity: nil, message: nil) }
    assert_nothing_raised_here { client.info(nil) }
    assert_nothing_raised_here { client.log(severity: :info, message: "x", fields: nil, tags: nil) }
    client.close
    assert_equal 3, @server.requests.sum { |r| r[:lines].length }
  end

  def test_forked_child_gets_its_own_worker_and_does_not_resend_parent_entries
    skip "fork is not available on this platform" unless Process.respond_to?(:fork)

    client = make_client(flush_interval: 60)
    client.info("parent")
    pid = fork do
      client.info("child")
      client.close(timeout: 5)
      exit!(0) # skip at_exit hooks and Minitest's autorun in the child
    end
    Process.wait(pid)

    @server.wait_for(1)
    assert_equal 1, @server.requests.length
    assert_equal ["child"], @server.requests[0][:lines].map { |l| l["message"] }
    client.close
    assert_equal ["parent"], @server.requests[1][:lines].map { |l| l["message"] }
  end

  private

  def assert_nothing_raised_here
    yield
    pass
  rescue StandardError => e
    flunk "expected no exception, got #{e.class}: #{e.message}"
  end
end
