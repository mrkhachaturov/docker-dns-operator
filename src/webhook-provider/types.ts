// Wire types for the generic webhook-provider contract.
//
// Sidecars that implement the kubernetes-sigs/external-dns webhook
// provider API are plug-compatible with this operator. The contract is
// documented publicly at
// https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/webhook-provider/
// and the canonical OpenAPI spec ships in that repo as api/webhook.yaml.

/**
 * The single media type used for both Accept and Content-Type on every
 * webhook request and response. Upstream pins the version in the media
 * type rather than in the URL path.
 */
export const WEBHOOK_MEDIA_TYPE =
  'application/external.dns.webhook+json;version=1';

/**
 * A single DNS record. Mirrors endpoint.Endpoint in upstream.
 *
 * targets is always a list. For an A record it's IPs; for a CNAME a
 * single hostname; for an MX a list of "<priority> <host>" strings.
 *
 * recordTTL of 0 (or omitted) means "unconfigured" — sidecar chooses.
 *
 * labels carries operator-side metadata (e.g. the ownership tag); the
 * sidecar passes it through. providerSpecific is a free-form bag the
 * sidecar may use for backend-specific data without touching the
 * contract.
 */
export interface Endpoint {
  dnsName: string;
  targets: string[];
  recordType: string;
  recordTTL?: number;
  setIdentifier?: string;
  labels?: Record<string, string>;
  providerSpecific?: ProviderSpecificProperty[];
}

export interface ProviderSpecificProperty {
  name: string;
  value: string;
}

/**
 * A batch of changes the sidecar applies per cycle. Mirrors plan.Changes.
 *
 * updateOld and updateNew are paired by index: updateNew[i] is the
 * desired state of the record whose current state is updateOld[i].
 */
export interface Changes {
  create?: Endpoint[];
  updateOld?: Endpoint[];
  updateNew?: Endpoint[];
  delete?: Endpoint[];
}

/**
 * Wire shape returned by GET /. Mirrors the JSON form of upstream's
 * DomainFilter (domainFilterSerde).
 *
 * Either the list form (include/exclude) OR the regex form
 * (regexInclude/regexExclude) is populated — upstream rejects a mix.
 * All fields are optional; an empty object means "no filter".
 */
export interface DomainFilter {
  include?: string[];
  exclude?: string[];
  regexInclude?: string;
  regexExclude?: string;
}

/**
 * Liveness/readiness response on GET /healthz.
 *
 * The healthz endpoint is not part of the upstream webhook contract
 * (upstream exposes it on a separate port for k8s probes). We keep it
 * on the same port for simplicity and require a minimal { ok } body.
 */
export interface HealthResponse {
  ok: boolean;
  detail?: string;
}

/**
 * Discriminated result type returned by every WebhookClient method.
 *
 * Retry semantics follow upstream:
 *   - HTTP 5xx → retryable: true (sidecar/backend transient failure)
 *   - HTTP 4xx → retryable: false (caller bug; retrying won't help)
 *   - Network/timeout errors → retryable: true (transient)
 *   - Malformed 2xx body → retryable: false (sidecar contract violation)
 */
export type WebhookResult<T> =
  | { ok: true; value: T }
  | { ok: false; retryable: boolean; status?: number; message: string };
