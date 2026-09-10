# frozen_string_literal: true

require_relative "test_helper"
require "stringio"

class LoggerTest < Minitest::Test
  include ClientHelpers

  def lines
    @server.requests.flat_map { |r| r[:lines] }
  end

  def test_logger_maps_severities_and_progname_to_category
    client = make_client
    logger = Ziplogger::Logger.new(client, progname: "app")
    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")
    logger.fatal("f")
    logger.unknown("u")
    logger.add(Logger::WARN, "slow query", "ActiveRecord")
    logger.add(Logger::INFO) { "from block" }
    client.close

    assert_equal %w[debug info warn error fatal error warn info], lines.map { |l| l["severity"] }
    assert_equal %w[d i w e f u], lines.first(6).map { |l| l["message"] }
    assert_equal ["app"] * 6, lines.first(6).map { |l| l["fields"]["category"] }
    assert_equal "slow query", lines[6]["message"]
    assert_equal "ActiveRecord", lines[6]["fields"]["category"]
    assert_equal "from block", lines[7]["message"]
  end

  def test_logger_hash_message_becomes_message_and_fields
    client = make_client
    logger = Ziplogger::Logger.new(client)
    logger.info(message: "Order created", orderId: 83112, "customer" => "acme")
    logger.error("message" => "Payment failed", :error => ArgumentError.new("declined"), :amount => 12.5)
    client.close

    created, failed = lines
    assert_equal "Order created", created["message"]
    assert_equal 83112, created["fields"]["orderId"]
    assert_equal "acme", created["fields"]["customer"]
    assert_equal "Payment failed", failed["message"]
    assert_equal 12.5, failed["fields"]["amount"]
    assert_equal "ArgumentError", failed["fields"]["exceptionType"]
    assert_match(/\AArgumentError: declined/, failed["stackTrace"])
  end

  def test_logger_exception_message_becomes_stack_trace
    client = make_client
    logger = Ziplogger::Logger.new(client)
    begin
      { "en" => 1 }.fetch("pt-BR")
    rescue KeyError => e
      logger.error(e)
    end
    client.close

    entry = lines[0]
    assert_equal "error", entry["severity"]
    assert_equal 'key not found: "pt-BR"', entry["message"]
    assert_equal "KeyError", entry["fields"]["exceptionType"]
    assert_match(/logger_test\.rb:\d+/, entry["stackTrace"])
  end

  def test_logger_splits_pre_rendered_backtraces_from_frameworks
    client = make_client
    logger = Ziplogger::Logger.new(client)
    rendered = "KeyError (key not found: \"pt-BR\"):\n  \napp/services/notifier.rb:12:in `render'\n" \
               "app/controllers/orders_controller.rb:30:in `create'"
    logger.fatal(rendered)
    logger.info("plain\nmultiline message without frames")
    client.close

    rails_style, plain = lines
    assert_equal 'KeyError (key not found: "pt-BR")', rails_style["message"]
    assert_equal rendered, rails_style["stackTrace"]
    assert_equal "plain\nmultiline message without frames", plain["message"]
    assert_nil plain["stackTrace"]
  end

  def test_logger_respects_level
    client = make_client
    logger = Ziplogger::Logger.new(client, level: Logger::WARN)
    logger.info("hidden")
    logger.debug { raise "block must not be evaluated below the level" }
    logger.warn("shown")
    client.close

    assert_equal ["shown"], lines.map { |l| l["message"] }
  end

  def test_logger_also_writes_to_a_local_device_when_given
    client = make_client
    io = StringIO.new
    logger = Ziplogger::Logger.new(client, io, progname: "web")
    logger.info("hello")
    client.close

    assert_match(/INFO -- web: hello/, io.string)
    assert_equal "hello", lines[0]["message"]
  end

  def test_log_device_recognises_the_default_format_and_ships_raw_lines
    client = make_client
    device = Ziplogger::LogDevice.new(client, severity: :warn, category: "rack")
    logger = Logger.new(device, progname: "web")
    logger.error("disk full")
    logger.info("two\nlines")
    device.write("raw line one\nraw line two\n")
    client.close

    formatted, multiline, raw1, raw2 = lines
    assert_equal "error", formatted["severity"]
    assert_equal "disk full", formatted["message"]
    assert_equal "web", formatted["fields"]["category"]
    assert_equal "two\nlines", multiline["message"]
    assert_equal "info", multiline["severity"]
    assert_equal %w[warn warn], [raw1["severity"], raw2["severity"]]
    assert_equal %w[rack rack], [raw1["fields"]["category"], raw2["fields"]["category"]]
    assert_equal ["raw line one", "raw line two"], [raw1["message"], raw2["message"]]
  end

  def test_logger_never_raises_when_the_message_is_hostile
    client = make_client
    logger = Ziplogger::Logger.new(client)
    hostile = Object.new
    def hostile.to_s
      raise "nope"
    end
    logger.info(hostile)
    logger.info("still alive")
    client.close

    assert_equal ["still alive"], lines.map { |l| l["message"] }
  end
end
