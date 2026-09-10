FROM php:8.3-cli

WORKDIR /app

# Composer from its official image; ext-curl and ext-json ship with php:8.3-cli.
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Installed from Packagist, exactly as a customer would.
ENV COMPOSER_ALLOW_SUPERUSER=1
COPY composer.json ./
RUN composer install --no-dev --no-interaction --no-progress --prefer-dist \
    && composer clear-cache

COPY public ./public
COPY src ./src
COPY bin ./bin
RUN composer dump-autoload --optimize --no-dev

EXPOSE 8080

# The built-in server handles the HTTP side, one request per PHP run as under FPM; the traffic
# loop keeps a demo workspace populated. `exec` on the loop makes it PID 1 so signals stop the container.
CMD ["sh", "-c", "php -S 0.0.0.0:8080 public/index.php & exec php bin/traffic.php"]
