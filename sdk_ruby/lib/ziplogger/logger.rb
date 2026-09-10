# frozen_string_literal: true

require "logger"

module Ziplogger
  # A standard-library +::Logger+ that ships every record through a Ziplogger::Client.
  #
  # Anything that accepts a +Logger+ (Rails, Sidekiq, Rack, your own code) can be pointed at it,
  # and because it is a real +::Logger+ it also honours +level+, +progname+ and the block form.
  # Pass a +logdev+ as the second argument to keep writing locally as well; without one the
  # logger only ships. With Rails, add it to the broadcast logger instead (see docs/ruby.md).
  #
  #   logger = Ziplogger::Logger.new(client)
  #   logger.info("Order created")                              # message
  #   logger.info(message: "Order created", orderId: 83112)     # message + fields
  #   logger.error(exception)                                   # stackTrace + exception fields
  #   logger.add(Logger::WARN, "Slow query", "ActiveRecord")    # progname => fields.category
  class Logger < ::Logger
    SEVERITY_NAMES = {
      ::Logger::DEBUG => "debug",
      ::Logger::INFO => "info",
      ::Logger::WARN => "warn",
      ::Logger::ERROR => "error",
      ::Logger::FATAL => "fatal",
      ::Logger::UNKNOWN => "error"
    }.freeze

    attr_reader :client

    # @param client [Ziplogger::Client]
    # @param logdev [IO, String, nil] optional local device written through the normal ::Logger path
    def initialize(client, logdev = nil, level: ::Logger::DEBUG, progname: nil, formatter: nil,
                   datetime_format: nil)
      super(logdev, level: level, progname: progname, formatter: formatter,
                    datetime_format: datetime_format)
      @client = client
    end

    # The single entry point of ::Logger: debug/info/warn/error/fatal/unknown all land here.
    # Resolving the message once here keeps the block form and the two-argument form
    # (+add(severity, nil, "message")+ meaning "message with the default progname") identical to
    # the stdlib, then the resolved record is shipped and handed to the local device, if any.
    def add(severity, message = nil, progname = nil)
      severity ||= ::Logger::UNKNOWN
      return true if severity < level

      if message.nil?
        if block_given?
          message = yield
        else
          message = progname
          progname = self.progname
        end
      end
      ship(severity, message, progname)
      super(severity, message, progname, &nil) # message is resolved; never let the block run twice
    end
    alias log add

    # Raw writes (+logger << "text"+) ship as info entries.
    def <<(message)
      ship(::Logger::INFO, message, nil)
      super
    end

    # Flush pending entries; does not close the client, which may be shared.
    def close
      super
      @client.flush
    end

    private

    def ship(severity, message, progname)
      fields = {}
      category = progname.to_s
      fields["category"] = category unless category.empty?

      exception = nil
      stack_trace = nil
      case message
      when Exception
        exception = message
        message = exception_message(exception)
      when Hash
        message, exception = unpack_hash(message, fields)
      when String
        message, stack_trace = split_embedded_backtrace(message)
      else
        message = message.to_s
      end

      @client.log(severity: severity_name(severity), message: message, fields: fields,
                  exception: exception, stack_trace: stack_trace)
    rescue StandardError
      nil # shipping must never break the caller; the client counts what it could not take
    end

    def severity_name(severity)
      SEVERITY_NAMES.fetch(severity) do
        # Custom numeric levels map by value, like the Python handler.
        severity.to_i >= ::Logger::ERROR ? "error" : (severity.to_i >= ::Logger::WARN ? "warn" : "info")
      end
    end

    # A Hash message: +:message+ (or "message") is the log line, +:exception+/+:error+ holding an
    # Exception becomes the stack trace, and every other key is a searchable field.
    def unpack_hash(hash, fields)
      exception = nil
      message = ""
      hash.each do |key, value|
        name = key.to_s
        if name == "message"
          message = value.to_s
        elsif (name == "exception" || name == "error") && value.is_a?(Exception) && exception.nil?
          exception = value
        else
          fields[name] = value
        end
      end
      message = exception_message(exception) if message.empty? && exception
      [message, exception]
    end

    def exception_message(exception)
      text = exception.message.to_s
      text.empty? ? exception.class.name : text
    end

    # Frameworks often log an exception as pre-rendered text: Rails' DebugExceptions writes
    # "KeyError (key not found):\n  app/models/x.rb:12:in `render'\n ...". Shipping that whole
    # blob as the message would make every occurrence its own pattern and lose the trace. When the
    # text carries Ruby backtrace frames, the first line becomes the message and the full text the
    # stack trace, which is what regression attribution needs.
    BACKTRACE_FRAME = /^[^\n]*:\d+:in [`']/
    private_constant :BACKTRACE_FRAME

    def split_embedded_backtrace(text)
      return [text, nil] unless text.include?("\n") && text.match?(BACKTRACE_FRAME)

      first = text.lines.first.to_s.strip.sub(/:\z/, "")
      [first.empty? ? text : first, text]
    end
  end

  # A log device for frameworks that only know how to write formatted lines: anything with a
  # +write(String)+ and +close+ contract, such as +::Logger.new(Ziplogger::LogDevice.new(client))+
  # or Rack::CommonLogger. Output in the stdlib default format ("I, [time #pid]  INFO -- prog:
  # message") is recognised so severity, progname and message survive; any other text ships as
  # one info entry per line.
  class LogDevice
    DEFAULT_FORMAT = /\A(?<letter>[DIWEFUA]), \[(?<time>[^\]]*)\]\s+(?<label>\w+) -- (?<progname>[^:]*): (?<message>.*)\z/m
    LETTERS = { "D" => "debug", "I" => "info", "W" => "warn", "E" => "error", "F" => "fatal",
                "U" => "error", "A" => "error" }.freeze

    attr_reader :client

    # @param severity [String, Symbol] severity for lines that are not in the default format
    # @param category [String, nil] value for +fields.category+ when the line carries no progname
    def initialize(client, severity: :info, category: nil)
      @client = client
      @severity = severity
      @category = category
    end

    def write(message)
      text = message.to_s
      if (match = DEFAULT_FORMAT.match(text.chomp))
        ship(LETTERS.fetch(match[:letter], "info"), match[:message], match[:progname])
      else
        text.each_line(chomp: true) do |line|
          next if line.strip.empty?

          ship(@severity, line, nil)
        end
      end
      text.bytesize
    rescue StandardError
      0
    end

    # ::Logger#close calls this; flush without closing a client that may be shared.
    def close
      @client.flush
    end

    def reopen(_logdev = nil)
      self
    end

    private

    def ship(severity, message, progname)
      fields = {}
      category = progname.to_s.strip
      category = @category.to_s if category.empty? && @category
      fields["category"] = category unless category.empty?
      @client.log(severity: severity, message: message, fields: fields)
    end
  end
end
