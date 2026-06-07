# Labels

Reference for every Docker label field the operator reads. The operator
consumes **exactly one Docker label per container/service**. Its value is a
JSON array of entry objects — one object per DNS record. Sources of truth:
[src/docker/label-normalizer.ts](src/docker/label-normalizer.ts) and the
DTOs under [src/dto/](src/dto/).

For label-driven examples and broader operator/sidecar setup see
[README.md](README.md). This file enumerates fields only.

## The label key

| Key                               | Required | Notes                                                                                                                                                                                                            |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${PROJECT_LABEL}:${INSTANCE_ID}` | yes      | Composed from the two env vars on the operator (defaults: `docker-dns-operator:1`). On Swarm this must be set under `deploy.labels` so the manager API surfaces it; container `labels:` work in standalone mode. |

The value is a JSON-stringified **array**. Empty arrays, non-arrays, or
non-JSON values are warned and skipped — they don't crash the operator.

```yaml
labels:
  docker-dns-operator:1: |
    [
      { "type": "A", "name": "app.example.com", "address": "192.0.2.10" }
    ]
```

## Common entry fields

Apply to every entry regardless of `type`.

| Field             | Type               | Required | Default  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`            | string             | yes      | —        | One of `A`, `AAAA`, `CNAME`, `MX`, `NS`. `Unsupported` is reserved and skipped with a warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `name`            | string (FQDN)      | yes      | —        | Fully-qualified record name. Validated with `class-validator`'s `@IsFQDN({ allow_wildcard: true })`, so a leading `*.` wildcard (e.g. `*.dev.example.com`) is accepted for any record type — mirroring external-dns, which treats `*.` as an ordinary owner name and leaves per-type/zone-cut handling to the DNS server. **Whether a wildcard actually lands depends on the target provider/zone:** MikroTik creates it as a `regexp` row (works); Cloudflare supports `*.` natively; **Windows AD DNS refuses wildcards via RFC 2136 dynamic update** (create it manually in AD, delegate the subzone, or route the wildcard to MikroTik). |
| `providers`       | string \| string[] | no       | `["cf"]` | Provider keys this entry targets — e.g. `["cf"]`, `["mikrotik"]`, `["cf", "mikrotik-home"]`, or the shorthand `"all"`. Strings are lowercased and trimmed; `_` in env-derived keys becomes `-`. A typo here fails the entry loudly — no silent fallback.                                                                                                                                                                                                                                                                                                                                                                                     |
| `provider`        | string             | no       | —        | Legacy singular form. Accepted and normalized into `providers`. `providers` wins if both are present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `providerOptions` | object             | no       | —        | Per-provider options keyed by provider id. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `id`              | —                  | —        | —        | **Forbidden.** Present-but-not-empty `id` warns and skips the entry — it's reserved for the operator's internal bookkeeping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### `providers` normalization rules

Implemented in [src/docker/label-normalizer.ts:11](src/docker/label-normalizer.ts#L11).

- Absent → `["cf"]` (backward compatibility with the pre-sidecar era; if no
  `WEBHOOK_CF_URL` is registered the strict-routing guard surfaces a clear
  error at reconcile time).
- Empty string, empty array, or any non-string element → entry is skipped
  with a warning.
- Strings are `.trim().toLowerCase()`. Comparison against the registry uses
  the same normalization, so `"CF"`, `"cf"`, and `" cf "` all match key `cf`.
- `"all"` is a fan-out shorthand: every registered provider sees the entry.

### `providerOptions`

Per-provider options keyed by provider id. The only field the operator
currently round-trips is Cloudflare proxy:

| Path                         | Type    | Applies to   | Description                                                                                                                                                                                                                        |
| ---------------------------- | ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providerOptions.cf.proxy`   | boolean | `A`, `CNAME` | Toggles Cloudflare orange-cloud proxying. Forwarded to `ddo-cloudflare` as the standard external-dns `providerSpecific` property. Booleans or the literal strings `"true"`/`"false"` are accepted — anything else fails the entry. |
| `proxy` _(legacy top-level)_ | boolean | `A`, `CNAME` | Pre-`providerOptions` shorthand for the same toggle. Still accepted; `providerOptions.cf.proxy` takes precedence if both are set.                                                                                                  |

Per-entry TTL is not wired today — TTL defaults live on each sidecar's own
env. Unknown `providerOptions.<key>` blocks are not stripped; they ride
through to the sidecar via external-dns `providerSpecific` if that sidecar
chooses to interpret them.

## Type-specific fields

### `A`

| Field     | Type   | Required | Notes                                                                                                                                             |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address` | string | yes      | IPv4 literal **or** the magic string `"DDNS"` to resolve to the host's current public IPv4 (re-checked every `DDNS_EXECUTION_FREQUENCY_MINUTES`). |

### `AAAA`

| Field     | Type   | Required | Notes                                      |
| --------- | ------ | -------- | ------------------------------------------ |
| `address` | string | yes      | IPv6 literal. Compared case-insensitively. |

### `CNAME`

| Field    | Type          | Required | Notes                                      |
| -------- | ------------- | -------- | ------------------------------------------ |
| `target` | string (FQDN) | yes      | Should resolve via an existing A or CNAME. |

### `MX`

| Field      | Type          | Required | Notes                    |
| ---------- | ------------- | -------- | ------------------------ |
| `server`   | string (FQDN) | yes      | Mail exchanger hostname. |
| `priority` | integer       | yes      | `0`–`65535`.             |

### `NS`

| Field    | Type          | Required | Notes                      |
| -------- | ------------- | -------- | -------------------------- |
| `server` | string (FQDN) | yes      | Nameserver to delegate to. |

## Validation behavior

- The JSON is parsed once per source. Malformed JSON, non-array root,
  empty array, or `id`-bearing entries are warned and skipped — never
  fatal.
- Each entry is materialized into the type's class and runs through
  `class-validator`'s `validateSync`. Any validation error skips that
  entry with the per-field reason logged.
- Strict routing: if `providers` references a key not registered via
  `WEBHOOK_<NAME>_URL`, the entry is dropped for that target and the error
  is surfaced. No silent fallback to a different provider.
- Domain pre-routing: at startup the operator calls each sidecar's
  external-dns `GET /` negotiation endpoint and caches the returned
  `DomainFilter`. During reconciliation, an entry whose `name` falls
  **outside** the target provider's zone scope is dropped from that
  provider's apply pass with a WARN naming the entry and provider —
  e.g. routing `sslk.cc` to a sidecar that only serves `example.com`
  is skipped at the operator instead of round-tripping a sidecar 4xx.
  Sidecars that fail negotiation or return an empty filter degrade to
  match-all (fail-open). Zone changes on a sidecar require an operator
  restart, mirroring upstream external-dns behavior.

## Worked examples

Single A record, default provider:

```json
[{ "type": "A", "name": "whoami.example.com", "address": "192.0.2.10" }]
```

Split routing — public to Cloudflare (proxied), internal to MikroTik:

```json
[
  {
    "type": "A",
    "name": "app.example.com",
    "address": "192.0.2.10",
    "providers": ["cf"],
    "providerOptions": { "cf": { "proxy": true } }
  },
  {
    "type": "A",
    "name": "app.lan",
    "address": "192.168.1.50",
    "providers": ["mikrotik"]
  }
]
```

One record, two named providers (publish the **same** A record to both
Cloudflare and MikroTik simultaneously — public DNS + internal LAN view):

```json
[
  {
    "type": "A",
    "name": "app.example.com",
    "address": "192.0.2.10",
    "providers": ["cf", "mikrotik"]
  }
]
```

The operator runs one reconcile pass per registered provider; an entry
whose `providers` list contains that provider's key is included for that
pass. So the array above creates `app.example.com` in Cloudflare **and**
in MikroTik from a single label entry. `providerOptions` are applied
per-provider — `providerOptions.cf.proxy` would proxy the Cloudflare copy
without affecting the MikroTik one.

If one of the targeted providers doesn't actually serve `example.com`
(it negotiated a `DomainFilter` listing only other zones), the entry is
silently dropped for that provider with a WARN — the other providers
still apply. No partial-write needed, no manual `providers: [...]`
surgery to keep records out of the wrong sidecar.

Same idea across N MikroTik routers (home + office), keeping the
Cloudflare copy too:

```json
[
  {
    "type": "CNAME",
    "name": "wiki.example.com",
    "target": "app.example.com",
    "providers": ["cf", "mikrotik-home", "mikrotik-office"]
  }
]
```

DDNS-tracked A record fanned out to **every** registered provider via the
`"all"` shorthand (equivalent to listing every key explicitly):

```json
[
  {
    "type": "A",
    "name": "home.example.com",
    "address": "DDNS",
    "providers": "all"
  }
]
```

CNAME alias, Cloudflare-proxied:

```json
[
  {
    "type": "CNAME",
    "name": "www.example.com",
    "target": "app.example.com",
    "providers": ["cf"],
    "providerOptions": { "cf": { "proxy": true } }
  }
]
```

MX + NS on the same source:

```json
[
  {
    "type": "MX",
    "name": "example.com",
    "server": "mx1.example.com",
    "priority": 10,
    "providers": ["rfc2136"]
  },
  {
    "type": "NS",
    "name": "sub.example.com",
    "server": "ns1.example.com",
    "providers": ["rfc2136"]
  }
]
```
