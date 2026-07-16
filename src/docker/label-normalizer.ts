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

  // Absent: backward compatibility — default to "cf" so a user upgrading from
  // the in-process CloudFlare provider only has to add WEBHOOK_CF_URL to keep
  // routing working. If "cf" isn't registered, the strict-routing guard in
  // app.service surfaces a clear error.
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
 * Normalizes the raw label `tags` field into a canonical string[].
 *
 * Three-valued return, mirroring the entry-skip contract used elsewhere:
 *   - `undefined` — the field is absent. Distinct from `[]`: tags carry NO
 *     backward-compat default (that belongs to `providers`), so "absent"
 *     must stay distinguishable so the resolver knows not to invent one.
 *   - `null` — the field is present but malformed (empty string, empty array,
 *     blank or non-string element). Caller warns and skips the entry.
 *   - `string[]` — trimmed, lower-cased tags.
 *
 * A bare string is accepted as a one-element list, same as `providers`. Tags
 * are matched against provider tags declared via `WEBHOOK_<NAME>_TAGS`; an
 * unknown tag is rejected loudly at reconcile time, never silently dropped.
 */
export function normalizeTags(rawTags: unknown): string[] | null | undefined {
  if (rawTags === undefined || rawTags === null) return undefined;

  if (typeof rawTags === 'string') {
    const trimmed = rawTags.trim().toLowerCase();
    if (!trimmed) return null;
    return [trimmed];
  }

  if (Array.isArray(rawTags)) {
    if (rawTags.length === 0) return null;
    const lowercased = rawTags.map((item) =>
      typeof item === 'string' ? item.trim().toLowerCase() : null,
    );
    if (lowercased.some((item) => !item)) return null;
    return lowercased as string[];
  }

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
 * Supports cf (proxy). Returns null on any malformed value so the caller
 * can warn and skip the entry.
 */
export function normalizeProviderOptions(
  raw: Record<string, unknown>,
): IProviderOptions | null | undefined {
  const out: IProviderOptions = {};

  // CF: explicit nested form takes precedence; legacy top-level `proxy` is fallback.
  const nestedProxy = (raw.providerOptions as Record<string, any> | undefined)
    ?.cf?.proxy;
  if (nestedProxy !== undefined) {
    const parsed = parseProxyBoolean(nestedProxy);
    if (parsed === null) return null;
    out.cf = { proxy: parsed };
  } else if (raw.proxy !== undefined) {
    const parsed = parseProxyBoolean(raw.proxy);
    if (parsed === null) return null;
    out.cf = { proxy: parsed };
  }

  if (Object.keys(out).length === 0) return undefined;
  return out;
}
