import { DomainFilter } from './types';

/**
 * Normalize a domain for comparison: trim trailing dot + lowercase.
 *
 * Upstream external-dns also runs IDNA → unicode here. We skip that — no
 * sidecar in this project ships non-ASCII zones today, and pulling in
 * `punycode` for a contingency would expand the dependency surface.
 * If/when we need IDNA, add `punycode` and replace this with
 * `punycode.toUnicode(d.replace(/\.+$/, '')).toLowerCase()`.
 */
function normalizeDomain(d: string): string {
  return d.replace(/\.+$/, '').toLowerCase();
}

/**
 * Mirrors the three-rule matchFilter in upstream
 * endpoint/domain_filter.go:134:
 *
 *   1. filter starts with "." → match if domain ends with filter (leading-
 *      dot form is subdomain-only — the apex is intentionally excluded).
 *   2. domain equals filter (exact, post-normalization).
 *   3. domain ends with "." + filter (label-boundary suffix — distinguishes
 *      `app.example.com` matching `example.com` from `fakeexample.com`
 *      NOT matching).
 *
 * `emptyResult` controls the empty-filters case: true for include lists
 * (no filter = accept everything), false for exclude lists (no exclusion
 * = nothing rejected).
 */
function matchAny(
  filters: string[],
  domain: string,
  emptyResult: boolean,
): boolean {
  if (filters.length === 0) return emptyResult;
  const d = normalizeDomain(domain);
  return filters.some((raw) => {
    if (raw === '') return false;
    const lowered = raw.toLowerCase();
    if (lowered.startsWith('.')) {
      // Subdomain-only form: don't trim the dot — `.example.com` should
      // match `app.example.com` but not `example.com` itself.
      return d.endsWith(lowered);
    }
    const stripped = lowered.replace(/\.+$/, '');
    if (d === stripped) return true;
    return d.endsWith(`.${stripped}`);
  });
}

/**
 * Returns true iff `domain` is inside the filter's allow-list.
 *
 * Empty / null filter → match-all. This is the same default
 * upstream uses, and it's also our fail-open path for sidecars that
 * fail negotiation or return an unsupported shape — we'd rather
 * accidentally route a record to a sidecar that politely 4xx's it
 * than silently drop every record because one sidecar's `GET /`
 * timed out.
 *
 * Regex form (`regexInclude`/`regexExclude`) is NOT enforced — no
 * sidecar in this project emits it today, and a regex evaluator would
 * be a meaningful new code path. If they're set alongside list form,
 * the list form is honoured and the regex fields are ignored. A
 * regex-only filter degrades to match-all (the fail-open default).
 *
 * Mirrors endpoint.DomainFilter.Match in upstream external-dns.
 */
export function matchDomain(
  filter: DomainFilter | null | undefined,
  domain: string,
): boolean {
  if (!filter) return true;
  return (
    matchAny(filter.include ?? [], domain, true) &&
    !matchAny(filter.exclude ?? [], domain, false)
  );
}
