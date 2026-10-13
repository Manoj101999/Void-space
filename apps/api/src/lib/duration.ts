/**
 * Formats and durations shared by the token/session services.
 */

const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;

/**
 * Parses the compact durations used in .env (`15m`, `7d`, `60s`) into seconds.
 * Cookie max-age needs a number, while @fastify/jwt takes the string form, so
 * both representations come from the same configured value.
 */
export function parseDurationSeconds(value: string, fallbackSeconds: number): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return fallbackSeconds;

  const amount = Number.parseInt(match[1] as string, 10);
  switch (match[2]) {
    case 's':
      return amount;
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3600;
    case 'd':
      return amount * 86_400;
    default:
      return fallbackSeconds;
  }
}

/** Human-friendly duration for audit entries and docs. */
export function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
