/**
 * Converts seconds (number) to MikroTik duration string format.
 * Example: 3661 → "1h1m1s"
 */
export function secondsToMikrotikTTL(totalSeconds: number): string {
  if (totalSeconds < 0)
    throw new Error(`Negative TTL not allowed: ${totalSeconds}`);

  const days = Math.floor(totalSeconds / 86400);
  const remainder1 = totalSeconds % 86400;
  const hours = Math.floor(remainder1 / 3600);
  const remainder2 = remainder1 % 3600;
  const minutes = Math.floor(remainder2 / 60);
  const seconds = remainder2 % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join('');
}

const UNIT_MAP: Record<string, number> = {
  d: 86400,
  h: 3600,
  m: 60,
  s: 1,
};
const TTL_REGEX = /(-?\d*\.?\d+)([dhms])/g;

/**
 * Converts a MikroTik duration string to seconds (number).
 * Example: "1h1m1s" → 3661
 */
export function mikrotikTTLToSeconds(ttl: string): number {
  if (!ttl) return 0;

  const matches = [...ttl.matchAll(TTL_REGEX)];
  if (matches.length === 0)
    throw new Error(`Invalid MikroTik duration: '${ttl}'`);

  const reconstructed = matches.map((m) => m[0]).join('');
  if (reconstructed !== ttl.replace(/\s/g, '')) {
    throw new Error(`Invalid characters in MikroTik duration: '${ttl}'`);
  }

  let total = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const [, valueStr, unitStr] of matches) {
    const value = parseFloat(valueStr);
    if (value < 0)
      throw new Error(`Negative value in MikroTik duration: '${ttl}'`);
    total += value * UNIT_MAP[unitStr];
  }

  return Math.round(total);
}
