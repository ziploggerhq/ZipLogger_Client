<?php

declare(strict_types=1);

namespace Northwind\Loyalty;

/**
 * Northwind Coffee loyalty programme: points, tiers, and the distance to the next tier.
 *
 * The interesting part for a demo is not the arithmetic, it is what the logs look like when it
 * goes wrong. Guests earn no points, so the "how much do I need to spend to reach Bronze" figure
 * divides by zero for them. That is a real DivisionByZeroError from a real line in this file, so
 * the stack trace ZipLogger receives resolves to an actual commit in this repository.
 */
final class Loyalty
{
    /** @var list<array{name: string, threshold: int, pointsPerDollar: int}> lowest tier first */
    public const TIERS = [
        ['name' => 'Guest', 'threshold' => 0, 'pointsPerDollar' => 0],
        ['name' => 'Bronze', 'threshold' => 100, 'pointsPerDollar' => 1],
        ['name' => 'Silver', 'threshold' => 500, 'pointsPerDollar' => 2],
        ['name' => 'Gold', 'threshold' => 1500, 'pointsPerDollar' => 3],
    ];

    /** @return array{name: string, threshold: int, pointsPerDollar: int} */
    public static function tierFor(int $points): array
    {
        $current = self::TIERS[0];
        foreach (self::TIERS as $tier) {
            if ($points >= $tier['threshold']) {
                $current = $tier;
            }
        }

        return $current;
    }

    /** @return array{name: string, threshold: int, pointsPerDollar: int}|null */
    public static function nextTier(array $tier): ?array
    {
        foreach (self::TIERS as $candidate) {
            if ($candidate['threshold'] > $tier['threshold']) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * Dollars a customer must still spend to reach the next tier.
     *
     * Bug: guests have a pointsPerDollar of 0, so for them this is a division by zero. PHP 8
     * throws DivisionByZeroError for `/` by zero rather than returning INF, so a guest looking at
     * their balance takes the whole request down.
     */
    public static function spendToNextTier(int $points, array $tier, array $next): int
    {
        $pointsNeeded = $next['threshold'] - $points;

        return (int) ceil($pointsNeeded / $tier['pointsPerDollar']);
    }

    /** @return array{customerId: string, points: int, tier: string, nextTier: ?string, spendToNextTier: ?int} */
    public static function summary(string $customerId, int $points): array
    {
        $tier = self::tierFor($points);
        $next = self::nextTier($tier);

        return [
            'customerId' => $customerId,
            'points' => $points,
            'tier' => $tier['name'],
            'nextTier' => $next['name'] ?? null,
            'spendToNextTier' => $next === null ? null : self::spendToNextTier($points, $tier, $next),
        ];
    }

    public static function pointsEarned(float $amount, array $tier): int
    {
        return (int) floor($amount * $tier['pointsPerDollar']);
    }
}
