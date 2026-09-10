# frozen_string_literal: true

require "minitest/autorun"
require "json"
require "socket"
require "ziplogger"

# Scriptable in-process HTTP server capturing NDJSON bodies. Raw TCPServer rather than WEBrick,
# which is no longer a default gem, so the tests stay standard-library only.
class StubServer
  REASONS = { 200 => "OK", 202 => "Accepted", 400 => "Bad Request", 401 => "Unauthorized",
              408 => "Request Timeout", 429 => "Too Many Requests", 500 => "Internal Server Error",
              503 => "Service Unavailable" }.freeze

  attr_reader :requests, :responses, :port
  attr_accessor :response_delay # seconds to hold every response; pins the client's worker in I/O

  def initialize
    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
    @requests = []  # { path:, api_key:, content_type:, lines:, status: }
    @responses = [] # queued status codes; default 202
    @response_delay = nil
    @mutex = Mutex.new
    @acceptor = Thread.new { accept_loop }
    @acceptor.report_on_exception = false
  end

  def url
    "http://127.0.0.1:#{@port}"
  end

  def wait_for(count, timeout: 5.0)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    while @mutex.synchronize { @requests.length } < count
      raise "expected #{count} requests, saw #{@requests.length}" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.01
    end
  end

  def stop
    @server.close
    @acceptor.join(1)
  end

  private

  def accept_loop
    loop do
      socket = @server.accept
      Thread.new(socket) { |s| serve(s) }.report_on_exception = false
    end
  rescue IOError, SystemCallError
    nil # server closed
  end

  # Handles any number of keep-alive requests on one connection.
  def serve(socket)
    while (request_line = socket.gets)
      _method, path, = request_line.split(" ")
      headers = {}
      while (line = socket.gets) && line != "\r\n"
        name, value = line.split(":", 2)
        headers[name.downcase] = value.to_s.strip
      end
      body = socket.read(headers["content-length"].to_i)
      status = @mutex.synchronize { @responses.shift || 202 }
      @mutex.synchronize do
        @requests << {
          path: path,
          api_key: headers["x-api-key"],
          content_type: headers["content-type"],
          lines: body.split("\n").reject(&:empty?).map { |l| JSON.parse(l) },
          status: status
        }
      end
      delay = @response_delay
      sleep(delay) if delay
      response = "HTTP/1.1 #{status} #{REASONS.fetch(status, 'X')}\r\nContent-Length: 0\r\n"
      response += "Retry-After: 0\r\n" if status == 429
      response += "Connection: keep-alive\r\n\r\n"
      socket.write(response)
    end
  rescue IOError, SystemCallError
    nil
  ensure
    socket.close unless socket.closed?
  end
end

module ClientHelpers
  def setup
    @server = StubServer.new
    @clients = []
  end

  def teardown
    @clients.each { |c| c.close(timeout: 2) }
    @server.stop
  end

  def make_client(**overrides)
    options = { endpoint: @server.url, api_key: "zk_test", flush_interval: 0.05, retry_base_delay: 0.01 }
    client = Ziplogger::Client.new(**options.merge(overrides))
    @clients << client
    client
  end

  def with_env(values)
    saved = values.keys.to_h { |k| [k, ENV.fetch(k, nil)] }
    apply_env(values)
    yield
  ensure
    apply_env(saved)
  end

  def apply_env(values)
    values.each do |key, value|
      if value.nil?
        ENV.delete(key)
      else
        ENV[key] = value
      end
    end
  end

  def wait_until(timeout: 5.0)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    until yield
      raise "condition not met within #{timeout}s" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.01
    end
  end
end
