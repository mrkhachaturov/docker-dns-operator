/**
 * Minimal view of a registered provider the selector needs: its routing key
 * and the tags declared for it (via WEBHOOK_<NAME>_TAGS). Kept deliberately
 * small so the selector can be unit-tested without constructing real
 * WebhookProvider instances.
 */
export interface RegisteredProviderMeta {
  providerKey: string;
  tags: string[];
}

/**
 * Outcome of resolving one entry's `providers` + `tags` fields.
 *
 * `keys` is the set of provider keys the entry targets. `unknownProviders`
 * and `unknownTags` list any references that matched nothing — the caller
 * turns a non-empty either into a loud per-entry error and skips the entry.
 * A tag that matches zero providers lands in `unknownTags`, so "resolves to
 * nothing" is always reported, never a silent no-op.
 */
export interface SelectionResult {
  keys: Set<string>;
  unknownProviders: string[];
  unknownTags: string[];
}

/** `providers: ["all"]` fans an entry out to every registered provider. */
const ALL = 'all';

/**
 * When an entry names NEITHER providers NOR tags it defaults to this key, so
 * a deployment upgrading from the pre-sidecar era (single in-process
 * CloudFlare, no routing field) keeps working after it adds WEBHOOK_CF_URL.
 */
const BACKCOMPAT_DEFAULT = 'cf';

/**
 * Resolves an entry's `providers` + `tags` fields to the concrete set of
 * provider keys it targets.
 *
 * Modeled on external-dns's DomainFilter: all pre-processing — the known-key
 * set and the tag → keys index — happens once in the constructor, so
 * resolve() on the reconcile hot path is cheap lookups rather than repeated
 * scans of the registry. Build one selector per reconcile pass and reuse it
 * across every entry.
 *
 * Providers and tags compose as a union: the target set is every explicitly
 * named provider key plus every provider carrying one of the named tags.
 */
export class ProviderSelector {
  private readonly knownKeys: Set<string>;

  private readonly tagIndex: Map<string, string[]>;

  constructor(providers: RegisteredProviderMeta[]) {
    this.knownKeys = new Set(providers.map((p) => p.providerKey));
    this.tagIndex = new Map();
    providers.forEach((provider) => {
      provider.tags.forEach((tag) => {
        const existing = this.tagIndex.get(tag);
        if (existing) existing.push(provider.providerKey);
        else this.tagIndex.set(tag, [provider.providerKey]);
      });
    });
  }

  /**
   * Effective target keys for one entry.
   *
   * Empty-semantics are explicit (borrowed from external-dns matchFilter's
   * `emptyval`): an entry that names neither providers nor tags falls back to
   * the backward-compat default; ANY explicit selector — even a single tag —
   * suppresses that default so a tags-only entry never leaks to `cf`.
   *
   * @param providers normalized `providers` field, or undefined if absent
   * @param tags      normalized `tags` field, or undefined if absent
   */
  resolve(
    providers: string[] | undefined,
    tags: string[] | undefined,
  ): SelectionResult {
    const providerRefs =
      (providers === undefined || providers.length === 0) &&
      (tags === undefined || tags.length === 0)
        ? [BACKCOMPAT_DEFAULT]
        : (providers ?? []);
    const tagRefs = tags ?? [];

    const keys = new Set<string>();
    const unknownProviders: string[] = [];
    providerRefs.forEach((ref) => {
      if (ref === ALL) {
        this.knownKeys.forEach((key) => keys.add(key));
        return;
      }
      if (this.knownKeys.has(ref)) keys.add(ref);
      else unknownProviders.push(ref);
    });

    const unknownTags: string[] = [];
    tagRefs.forEach((tag) => {
      const matched = this.tagIndex.get(tag);
      if (matched && matched.length > 0)
        matched.forEach((key) => keys.add(key));
      else unknownTags.push(tag);
    });

    return { keys, unknownProviders, unknownTags };
  }
}
