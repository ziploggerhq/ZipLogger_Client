# frozen_string_literal: true

# Northwind Coffee — notifications service (Ruby).
#
# Renders order notifications (shipping confirmations, low-stock alerts, roast-day reminders)
# in the customer's language and ships every log line to ZipLogger through
# Ziplogger::Logger, which is how most Ruby services adopt it: a ::Logger that happens to
# ship, handed to code that already knows how to log.
#
# The interesting part for a demo is what the logs look like when something goes wrong: the
# storefront added Brazilian Portuguese to its locale picker, nobody added a template for it,
# and the KeyError raised in Templates.for below is a real exception from a real line, so the
# stack trace ZipLogger receives resolves to an actual commit in this repository.

require "logger"
require "ziplogger"

$stdout.sync = true # unbuffered so container logs appear immediately in `docker logs`

ENDPOINT = ENV.fetch("ZIPLOGGER_ENDPOINT", "https://app.ziplogger.ai")
API_KEY = ENV.fetch("ZIPLOGGER_API_KEY", "")
INTERVAL = Float(ENV.fetch("DEMO_INTERVAL_SECONDS", "8"))

abort "ZIPLOGGER_API_KEY is required" if API_KEY.empty?

client = Ziplogger::Client.new(
  endpoint: ENDPOINT,
  api_key: API_KEY,
  source: "notifications",
  environment: ENV.fetch("ZIPLOGGER_ENVIRONMENT", "production"),
  tags: %w[demo ruby]
)

# Ships to ZipLogger and writes to stdout so `docker logs` shows the same lines.
LOG = Ziplogger::Logger.new(client, $stdout, level: Logger::INFO, progname: "notifications")

CHANNELS = %w[email sms push].freeze
KINDS = %w[order_shipped low_stock_alert roast_day_reminder].freeze

# Locales the storefront lets customers pick. "pt-BR" was added to the picker last sprint.
LOCALES = %w[en en de fr pt-BR].freeze

module Templates
  TEXT = {
    "en" => {
      "order_shipped" => "Your order %<orderId>s is on its way",
      "low_stock_alert" => "Only %<remaining>d bags of %<product>s left",
      "roast_day_reminder" => "Fresh roast of %<product>s tomorrow"
    },
    "de" => {
      "order_shipped" => "Ihre Bestellung %<orderId>s ist unterwegs",
      "low_stock_alert" => "Nur noch %<remaining>d Beutel %<product>s",
      "roast_day_reminder" => "Frische Röstung von %<product>s morgen"
    },
    "fr" => {
      "order_shipped" => "Votre commande %<orderId>s est en route",
      "low_stock_alert" => "Plus que %<remaining>d sachets de %<product>s",
      "roast_day_reminder" => "Torréfaction fraîche de %<product>s demain"
    }
    # Bug: no "pt-BR" entry, although the storefront offers it.
  }.freeze

  # Pick the template for a locale and notification kind.
  def self.for(locale, kind)
    # KeyError for any locale the storefront offers but this table does not know.
    TEXT.fetch(locale).fetch(kind)
  end
end

PRODUCTS = ["Ethiopia Yirgacheffe", "Colombia Huila", "Kenya AA", "Brazil Santos", "Swiss Water Decaf"].freeze

def render(kind, locale, context)
  format(Templates.for(locale, kind), context)
end

def deliver(channel, customer_id, body)
  # Stand-in for the real provider call; SMS bodies are capped, which is worth a warning.
  latency_ms = rand(20..180)
  sleep(latency_ms / 1000.0)
  LOG.warn(message: "SMS body truncated", customerId: customer_id, length: body.length) if channel == "sms" && body.length > 60
  latency_ms
end

def send_one_notification
  customer_id = "cust-#{rand(1000..9999)}"
  locale = LOCALES.sample
  kind = KINDS.sample
  channel = CHANNELS.sample
  context = { orderId: "NW-#{rand(100_000..999_999)}", product: PRODUCTS.sample, remaining: rand(1..4) }

  body = render(kind, locale, context)
  latency_ms = deliver(channel, customer_id, body)

  LOG.info(message: "Notification sent", customerId: customer_id, locale: locale, kind: kind,
           channel: channel, orderId: context[:orderId], latencyMs: latency_ms)
rescue KeyError => e
  # Logging the exception object gives ZipLogger the stack trace, which is what drives
  # "which commit broke this?" analysis. The Hash form keeps the context searchable.
  LOG.error(message: "Notification rendering failed", exception: e, customerId: customer_id,
            locale: locale, kind: kind, channel: channel)
end

# Signal handling without touching a Mutex inside the trap: write a byte to a pipe and let the
# main loop wake from IO.select.
stop_reader, stop_writer = IO.pipe
%w[INT TERM].each do |signal|
  Signal.trap(signal) { stop_writer.write_nonblock("x", exception: false) }
end

LOG.info(message: "Notifications service started", locales: LOCALES.uniq.size, templates: Templates::TEXT.size)

loop do
  send_one_notification
  break if IO.select([stop_reader], nil, nil, INTERVAL)
end

LOG.info("Notifications service stopping")
client.close(timeout: 5)
