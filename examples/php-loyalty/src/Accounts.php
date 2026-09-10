<?php

declare(strict_types=1);

namespace Northwind\Loyalty;

/**
 * A pretend account store. Balances are derived from the customer id so the service is
 * stateless across requests, which is what a `php -S` worker or an FPM pool would be anyway.
 */
final class Accounts
{
    private const NAMES = ['Aviva', 'Noam', 'Tamar', 'Eitan', 'Maya', 'Yoav', 'Shira', 'Omer'];

    public static function points(string $customerId): int
    {
        // Roughly a fifth of customers are guests with zero points, which is what trips the bug.
        $hash = crc32($customerId);
        if ($hash % 5 === 0) {
            return 0;
        }

        return 20 + $hash % 1800;
    }

    public static function name(string $customerId): string
    {
        return self::NAMES[crc32($customerId) % count(self::NAMES)];
    }

    public static function randomCustomerId(): string
    {
        return 'cust-' . random_int(1000, 9999);
    }
}
