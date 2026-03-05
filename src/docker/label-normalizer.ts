import { IProviderOptions } from '../dto/dnsbase-entry';

/**
 * Normalizes raw label provider fields into a canonical string[].
 * Returns null for malformed input (caller should warn and skip the entry).
 * Returns ['cf'] if both fields are absent (backward compatibility).
 *
 * @param rawProvider  Raw value of the `provider` (singular) label field
 * @param rawProviders Raw value of the `providers` (plural) label field
 */
export function normalizeProviders(
  rawProvider: unknown,
  rawProviders: unknown,
): string[] | null {
  // `providers` field takes precedence over `provider`
  const raw = rawProviders !== undefined ? rawProviders : rawProvider;

  // Absent: backward compatibility — default to CloudFlare
  if (raw === undefined || raw === null) return ['cf'];

  // String (including "all")
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return null;
    return [trimmed];
  }

  // Array
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const lowercased = raw.map((item) => {
      if (typeof item !== 'string') return null;
      return item.trim().toLowerCase();
    });
    if (lowercased.some((item) => !item)) return null;
    return lowercased as string[];
  }

  // Anything else is malformed
  return null;
}

/**
 * Parses a raw label value as a boolean.
 * Accepts: true/false (boolean), "true"/"false" (string).
 * Returns null for any other value — caller must warn and skip the entry.
 * Boolean("false") === true in JS, so explicit string comparison is required.
 */
export function parseProxyBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null; // malformed — reject, do not coerce
}

/**
 * Extracts provider-specific options from a raw label entry object.
 * Handles both legacy top-level `proxy` and explicit `providerOptions.cf.proxy`.
 * Returns null if proxy is present but has an invalid type (caller must warn + skip entry).
 */
export function normalizeProviderOptions(
  raw: Record<string, unknown>,
): IProviderOptions | null | undefined {
  // Explicit nested form takes precedence
  const nested = (raw.providerOptions as any)?.cf?.proxy;
  if (nested !== undefined) {
    const parsed = parseProxyBoolean(nested);
    if (parsed === null) return null; // malformed — signal caller to warn + skip
    return { cf: { proxy: parsed } };
  }

  // Legacy top-level proxy (CF-specific backward compat)
  if (raw.proxy !== undefined) {
    const parsed = parseProxyBoolean(raw.proxy);
    if (parsed === null) return null; // malformed — signal caller to warn + skip
    return { cf: { proxy: parsed } };
  }

  return undefined;
}
