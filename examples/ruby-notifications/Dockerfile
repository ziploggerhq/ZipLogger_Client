FROM ruby:3.3-slim

WORKDIR /app

# Installed from RubyGems, exactly as a customer would.
RUN gem install ziplogger --version 0.4.0 --no-document

COPY app.rb .

CMD ["ruby", "app.rb"]
