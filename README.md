# docker-dns-operator

[![CI](https://github.com/mrkhachaturov/docker-dns-operator/actions/workflows/ci.yaml/badge.svg)](https://github.com/mrkhachaturov/docker-dns-operator/actions/workflows/ci.yaml)
[![Docker Hub](https://img.shields.io/docker/v/mrkhachaturov/docker-dns-operator?label=docker&sort=semver)](https://hub.docker.com/r/mrkhachaturov/docker-dns-operator)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Declarative DNS for Docker. Annotate a container or Swarm service with a JSON label and the operator reconciles those records into CloudFlare, MikroTik RouterOS, and/or Active Directory DNS on every tick. Records you didn't create are never touched.

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Providers](#providers)
  - [CloudFlare](#cloudflare)
  - [MikroTik RouterOS](#mikrotik-routeros)
  - [RFC 2136 / Active Directory](#rfc-2136--active-directory)
- [Configuration](#configuration)
  - [Environment variables](#environment-variables)
  - [Label schema](#label-schema)
  - [Record types](#record-types)
- [Examples](#examples)
- [Operations](#operations)
- [Security](#security)
- [Development](#development)
- [Credits](#credits)
- [License](#license)

---

## What it does

- Watches the Docker socket and reads DNS entries from container labels (or `deploy.labels` in Swarm mode).
- Reconciles those entries into three DNS providers: CloudFlare, MikroTik RouterOS, and Active Directory DNS via RFC 2136 + GSS-TSIG.
- Routes each entry to one, several, or all providers via a `providers` field on the entry.
- Owns only records it created, marked with a `ddo-<type>.<name>` TXT marker. Pre-existing zone entries are left alone.
- Supports A, AAAA (rfc2136), CNAME, MX, and NS records.
- Multi-DC failover with a per-DC circuit breaker, per-zone DC pinning, and AXFR-or-prereq-only modes for the rfc2136 provider.
- Per-entry TTL overrides on rfc2136. DDNS (public IPv4) on CloudFlare.
- Runs on a configurable interval. Multiple instances can target the same zones with separate `INSTANCE_ID`s without conflicting.

---

## Quick start

Minimum CloudFlare setup. Drop this into a `docker-compose.yml`, supply an API token, and run `docker compose up -d`:

```yaml
services:
  dns-operator:
    image: mrkhachaturov/docker-dns-operator:latest
    environment:
      API_TOKEN_FILE: /run/secrets/cloudflare_token
    secrets:
      - cloudflare_token
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped

  whoami:
    image: traefik/whoami
    labels:
      docker-dns-operator:1: |
        [{ "type": "A", "name": "whoami.example.com", "address": "1.2.3.4" }]

secrets:
  cloudflare_token:
    file: ./cloudflare_token.txt
```

The operator polls Docker every `EXECUTION_FREQUENCY_SECONDS` (default 60), reads the label off `whoami`, and creates `whoami.example.com` in CloudFlare. Remove the container and the record is removed on the next tick.

For MikroTik or Active Directory, see the [Providers](#providers) section.

---

## How it works

```
┌──────────────────┐  reads labels   ┌────────────────────┐  applies records   ┌──────────────┐
│  Docker socket   │ ───────────────▶│  docker-dns-operator│ ─────────────────▶│  CloudFlare  │
│  (containers     │                 │                    │                    ├──────────────┤
│   or services)   │                 │  - reconciler loop │ ─────────────────▶│   MikroTik   │
└──────────────────┘                 │  - ownership check │                    ├──────────────┤
                                     │  - per-entry route │ ─────────────────▶│  AD via      │
                                     └─────────┬──────────┘     gss-tsig       │  rfc2136     │
                                               │                              └──────────────┘
                                               ▼
                                     ┌────────────────────┐
                                     │  rfc2136-transport │  (sidecar, only when rfc2136 is enabled)
                                     │  Go binary with    │
                                     │  Kerberos/TSIG     │
                                     └────────────────────┘
```

The reconciler runs on a fixed interval. Each cycle:

1. List Docker containers (or Swarm services, if `DOCKER_SWARM_MODE=true`).
2. Parse the `${PROJECT_LABEL}:${INSTANCE_ID}` label as a JSON array of entries.
3. Group entries by provider based on each entry's `providers` field.
4. For each provider, diff desired state against currently-owned records and apply create/update/delete.

**Ownership marker.** Every managed record carries a sibling TXT record at `ddo-<type>.<name>` whose value is `owned-by=${PROJECT_LABEL}:${INSTANCE_ID}`. The reconciler only touches records that carry this marker, so pre-existing zone entries are safe. Two operator instances with different `INSTANCE_ID`s can coexist on the same zone without stepping on each other.

At least one provider must be configured at startup.

---

## Providers

### CloudFlare

Enabled when `API_TOKEN` **or** `API_TOKEN_FILE` is set. The token needs `Zone.Zone:Read` and `Zone.DNS:Edit` for every zone you want to manage.

Supports: A, CNAME, MX, NS, with optional proxying.

Use `API_TOKEN_FILE` with a Docker secret in production. `API_TOKEN` plain-env is supported but writes the token into the container's environment, which is visible via `docker inspect`.

### MikroTik RouterOS

Enabled when `MIKROTIK_BASEURL`, `MIKROTIK_USERNAME`, and `MIKROTIK_PASSWORD` are all set. Talks to the RouterOS REST API (same port as the web UI: `www` on 80, `www-ssl` on 443).

Supports: A, CNAME, MX, NS.

If your router uses a self-signed certificate, set `MIKROTIK_SKIP_TLS_VERIFY=true`. Only do this on trusted networks.

### RFC 2136 / Active Directory

Enabled when the full `RFC2136_*` block is set. Performs secure dynamic DNS updates (RFC 2136 + GSS-TSIG) against Active Directory domain controllers, which is the same protocol [external-dns](https://github.com/kubernetes-sigs/external-dns/blob/master/docs/tutorials/rfc2136.md) uses for AD integration.

Supports: A, AAAA, CNAME, MX, NS.

The Kerberos/TSIG protocol layer runs in a separate sidecar container (`transport-rfc2136`, written in Go). The main operator talks to it over HTTP. The sidecar:

- runs `kinit -kt` against a keytab on startup and refreshes the TGT every `RFC2136_KINIT_REFRESH_INTERVAL`,
- signs UPDATE and AXFR messages with GSS-TSIG,
- exposes `/healthz` for liveness, which flips to HTTP 503 with `{"kerberos":"expired"}` if `kinit` fails.

The operator implements failover across multiple DCs (`RFC2136_HOSTS`) with a per-DC circuit breaker, per-zone DC pinning, and a TAXFR-off mode for environments where AXFR is denied.

**Hostnames, not IPs.** `RFC2136_HOSTS` must contain real DNS hostnames of your DCs. IPs and bare hostnames are rejected at startup. AD's Kerberos service principal is bound to the host you contact, and using an IP or short name produces `KDC_ERR_S_PRINCIPAL_UNKNOWN` or `KDC_ERR_WRONG_REALM` on every cycle.

See [docs/rfc2136-integration-runbook.md](docs/rfc2136-integration-runbook.md) for keytab generation, AD permission setup, and the full deployment walkthrough.

---

## Configuration

### Environment variables

Common to all providers:

| Variable | Default | Description |
|---|---|---|
| `PROJECT_LABEL` | `docker-dns-operator` | First half of the Docker label key the operator reads, and the ownership marker for managed records. |
| `INSTANCE_ID` | `1` | Second half of the label key. Combined as `${PROJECT_LABEL}:${INSTANCE_ID}`. |
| `EXECUTION_FREQUENCY_SECONDS` | `60` | Reconciliation interval. Integer, minimum 1, no maximum. |
| `DDNS_EXECUTION_FREQUENCY_MINUTES` | `60` | Public IP check interval. Only active when at least one entry uses `"address": "DDNS"`. |
| `PRESERVE_STOPPED` | `false` | If `true`, stopped containers keep their DNS entries. Removed containers always lose them. Ignored in Swarm mode. |
| `DOCKER_SWARM_MODE` | `false` | If `true`, discover entries from Swarm services (`deploy.labels`) instead of containers. |
| `LOG_LEVEL` | `error` | One of `fatal`, `error`, `warn`, `log`, `debug`, `verbose`. Invalid values currently cause the process to hang at startup. |

CloudFlare:

| Variable | Default | Description |
|---|---|---|
| `API_TOKEN` |  | CloudFlare API token. Setting this OR `API_TOKEN_FILE` enables the provider. |
| `API_TOKEN_FILE` |  | Path to a file containing the token. Preferred over `API_TOKEN`. |

MikroTik:

| Variable | Default | Description |
|---|---|---|
| `MIKROTIK_BASEURL` |  | Base URL of the RouterOS REST API, e.g. `https://192.168.1.1`. All three MikroTik vars must be set together. |
| `MIKROTIK_USERNAME` |  | API username. |
| `MIKROTIK_PASSWORD` |  | API password. |
| `MIKROTIK_SKIP_TLS_VERIFY` | `false` | Disable TLS verification. Trusted networks only. |
| `MIKROTIK_DEFAULT_TTL` | `3600` | TTL applied to newly created records, in seconds. |

RFC 2136 (all-or-nothing; every required variable must be set to enable the provider):

| Variable | Default | Description |
|---|---|---|
| `RFC2136_TRANSPORT_URL` |  | URL of the rfc2136-transport sidecar, e.g. `http://transport:9090`. Probed at `<URL>/healthz` on startup. |
| `RFC2136_AUTH_MODE` |  | Only `gss-tsig` is supported. |
| `RFC2136_HOSTS` |  | Comma-separated FQDNs of AD DCs in failover order. IPs and short names are rejected. |
| `RFC2136_PORT` | `53` | UDP/TCP port for DNS UPDATE. |
| `RFC2136_ZONES` |  | Comma-separated zones this provider manages. |
| `RFC2136_KERBEROS_REALM` |  | Kerberos realm, uppercase (`CORP.EXAMPLE.COM`). |
| `RFC2136_KERBEROS_PRINCIPAL` |  | Service principal the keytab authenticates (`svc-dns@CORP.EXAMPLE.COM`). |
| `RFC2136_KEYTAB_FILE` |  | Path to the keytab **inside the sidecar container**, typically `/run/secrets/rfc2136_keytab`. |
| `RFC2136_KRB5_CONF` | `/etc/krb5.conf` | Path to `krb5.conf` inside the sidecar. |
| `RFC2136_DEFAULT_TTL` | `3600` | TTL when none is supplied per entry. |
| `RFC2136_MIN_TTL` | `60` | Minimum TTL floor. Values below are clamped up. |
| `RFC2136_AXFR_TIMEOUT_SECONDS` | `30` | AXFR request timeout. |
| `RFC2136_UPDATE_TIMEOUT_SECONDS` | `15` | DNS UPDATE request timeout. |
| `RFC2136_CIRCUIT_BREAKER_THRESHOLD` | `3` | Consecutive failures before failing over to the next DC. |
| `RFC2136_DRY_RUN` | `false` | If `true`, log intended changes but do not apply. |
| `RFC2136_TAXFR` | `true` | If `false`, skip AXFR (use when AD blocks zone transfers). Drift detection is reduced; writes rely on UPDATE prerequisites. |
| `RFC2136_DOMAIN_FILTER` |  | Comma-separated name suffixes. Restricts which entries are managed without narrowing `RFC2136_ZONES`. |
| `RFC2136_KINIT_REFRESH_INTERVAL` | `12h` | Sidecar setting. How often the TGT is refreshed. Go duration syntax. |

### Label schema

The operator reads a single Docker label whose **key** is `${PROJECT_LABEL}:${INSTANCE_ID}` and whose **value** is a JSON-stringified array of entry objects.

```yaml
labels:
  docker-dns-operator:1: |
    [
      {
        "type": "A",
        "name": "app.example.com",
        "address": "1.2.3.4",
        "providers": ["cf", "mikrotik"],
        "providerOptions": {
          "cf": { "proxy": true },
          "rfc2136": { "ttl": 600 }
        }
      }
    ]
```

Per-entry fields common to every record type:

| Field | Type | Description |
|---|---|---|
| `type` | string | One of `A`, `AAAA`, `CNAME`, `MX`, `NS`. |
| `name` | string | Fully-qualified record name. |
| `providers` | string\|array | `["cf"]`, `["mikrotik"]`, `["rfc2136"]`, any combination, or the shorthand `"all"`. Defaults to `["cf"]` for backward compatibility when omitted. |
| `provider` | string | Legacy singular form. Accepted and normalized to `providers`. |
| `providerOptions` | object | Per-provider options, keyed by provider id. |

`providerOptions.cf.proxy` (boolean) controls CloudFlare proxying for A and CNAME records. `providerOptions.rfc2136.ttl` (integer seconds) overrides the default TTL for that entry on rfc2136. The legacy top-level `proxy` field is still accepted for CloudFlare entries.

### Record types

**A.** Points a name to an IPv4 address. Required: `address`. The literal string `"DDNS"` is accepted as the address value, which makes the operator resolve and use the host's current public IPv4.

**AAAA.** Points a name to an IPv6 address. Required: `address`. Currently only the rfc2136 provider accepts AAAA; CloudFlare and MikroTik throw at runtime.

**CNAME.** Aliases one name to another. Required: `target`. The target should resolve via an existing A or CNAME.

**MX.** Declares a mail server for a domain. Required: `server`, `priority` (0–65535). The `server` should resolve via an existing A or CNAME.

**NS.** Delegates a (sub)domain to another nameserver. Required: `server`.

---

## Examples

### Token in a file (recommended for CloudFlare)

```yaml
services:
  dns-operator:
    image: mrkhachaturov/docker-dns-operator:latest
    environment:
      API_TOKEN_FILE: /run/secrets/cloudflare_token
    secrets:
      - cloudflare_token
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro

  whoami:
    image: traefik/whoami
    labels:
      docker-dns-operator:1: |
        [{ "type": "A", "name": "whoami.example.com", "address": "1.2.3.4" }]

secrets:
  cloudflare_token:
    file: ./cloudflare_token.txt
```

### Split routing: public to CloudFlare, internal to MikroTik

```yaml
services:
  dns-operator:
    image: mrkhachaturov/docker-dns-operator:latest
    environment:
      API_TOKEN_FILE: /run/secrets/cloudflare_token
      MIKROTIK_BASEURL: https://192.168.1.1
      MIKROTIK_USERNAME_FILE: /run/secrets/mikrotik_user
      MIKROTIK_PASSWORD_FILE: /run/secrets/mikrotik_pass
    secrets:
      - cloudflare_token
      - mikrotik_user
      - mikrotik_pass
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro

  app:
    image: nginx
    labels:
      docker-dns-operator:1: |
        [
          { "type": "A", "name": "app.example.com", "address": "1.2.3.4",
            "providers": ["cf"], "providerOptions": { "cf": { "proxy": true } } },
          { "type": "A", "name": "app.lan", "address": "192.168.1.50",
            "providers": ["mikrotik"] }
        ]
```

### DDNS (public IPv4 of the host)

```yaml
labels:
  docker-dns-operator:1: |
    [{ "type": "A", "name": "home.example.com", "address": "DDNS" }]
```

The operator starts the DDNS service when any entry uses `"DDNS"`, queries the current public IPv4 every `DDNS_EXECUTION_FREQUENCY_MINUTES`, and updates the record when the IP changes.

### Two domains, two operator instances

Independent CloudFlare tokens by `INSTANCE_ID`:

```yaml
services:
  dns-a:
    image: mrkhachaturov/docker-dns-operator:latest
    environment:
      INSTANCE_ID: a
      API_TOKEN_FILE: /run/secrets/token_a
    secrets: [token_a]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro

  dns-b:
    image: mrkhachaturov/docker-dns-operator:latest
    environment:
      INSTANCE_ID: b
      API_TOKEN_FILE: /run/secrets/token_b
    secrets: [token_b]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro

  app:
    image: nginx
    labels:
      docker-dns-operator:a: '[{ "type": "A", "name": "a.com", "address": "1.2.3.4" }]'
      docker-dns-operator:b: '[{ "type": "A", "name": "b.org", "address": "5.6.7.8" }]'
```

### Active Directory (RFC 2136)

```yaml
services:
  dns-operator:
    image: mrkhachaturov/docker-dns-operator:latest
    environment:
      RFC2136_TRANSPORT_URL: http://transport:9090
      RFC2136_AUTH_MODE: gss-tsig
      RFC2136_HOSTS: dc01.corp.example.com,dc02.corp.example.com
      RFC2136_ZONES: corp.example.com
      RFC2136_KERBEROS_REALM: CORP.EXAMPLE.COM
      RFC2136_KERBEROS_PRINCIPAL: svc-dns@CORP.EXAMPLE.COM
      RFC2136_KEYTAB_FILE: /run/secrets/rfc2136_keytab
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro

  transport:
    image: mrkhachaturov/docker-dns-operator-transport:latest
    environment:
      RFC2136_KERBEROS_REALM: CORP.EXAMPLE.COM
      RFC2136_KERBEROS_PRINCIPAL: svc-dns@CORP.EXAMPLE.COM
      RFC2136_KEYTAB_FILE: /run/secrets/rfc2136_keytab
    secrets:
      - rfc2136_keytab

  app:
    image: nginx
    labels:
      docker-dns-operator:1: |
        [{ "type": "A", "name": "app.corp.example.com", "address": "10.20.30.40",
           "providers": ["rfc2136"],
           "providerOptions": { "rfc2136": { "ttl": 600 } } }]

secrets:
  rfc2136_keytab:
    file: ./rfc2136.keytab
```

See [docs/rfc2136-integration-runbook.md](docs/rfc2136-integration-runbook.md) for the full setup: creating the AD service account, generating the keytab, granting Allow Authenticated Users to update its own records, and validating end-to-end.

### Docker Swarm

Labels must live under `deploy.labels` (the Swarm-level location), not the top-level `labels` key:

```yaml
services:
  dns-operator:
    image: mrkhachaturov/docker-dns-operator:latest
    environment:
      DOCKER_SWARM_MODE: "true"
      API_TOKEN_FILE: /run/secrets/cloudflare_token
    secrets: [cloudflare_token]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    deploy:
      placement:
        constraints: [node.role == manager]

  app:
    image: nginx
    deploy:
      labels:
        docker-dns-operator:1: '[{ "type": "A", "name": "app.example.com", "address": "1.2.3.4" }]'
```

`PRESERVE_STOPPED` has no effect in Swarm mode. The operator must run on a manager node so it can list services.

---

## Operations

**Image tags.** Published on Docker Hub as [`mrkhachaturov/docker-dns-operator`](https://hub.docker.com/r/mrkhachaturov/docker-dns-operator). Tags:

| Tag | Meaning |
|---|---|
| `latest` | Most recent release across all major versions. |
| `<major>-latest` | Most recent release of that major version, e.g. `1-latest`. |
| `<semver>` | Specific release, e.g. `1.0.0`. |
| `<semver>-<pre>` | Pre-release builds, e.g. `1.1.0-alpha`. |

**Logging.** `LOG_LEVEL` maps to the NestJS logger and orders from most-specific to least: `fatal` → `error` → `warn` → `log` → `debug` → `verbose`. Each level includes everything above it. Production deployments typically run at `warn` or `error`.

**Health.** The main operator does not currently expose an HTTP health endpoint. The rfc2136-transport sidecar exposes `/healthz` on port 9090; HTTP 200 means Kerberos is alive, 503 means the TGT could not be refreshed.

**Failure modes worth knowing.**

- An invalid `LOG_LEVEL` makes the process hang at startup with no output. If startup hangs, the log level is the first thing to check.
- The rfc2136 provider is all-or-nothing: every required variable must be set, or the provider is silently not registered and entries routed to `rfc2136` are dropped with a warning.
- AAAA records on CloudFlare or MikroTik will throw at runtime. Route AAAA only to `rfc2136`.

---

## Security

**API tokens.** Use `API_TOKEN_FILE` over `API_TOKEN`. Plain env vars leak into `docker inspect`, image layers, and container exec output. CloudFlare tokens should be scoped to the minimum: `Zone.Zone:Read` and `Zone.DNS:Edit`, restricted to the specific zones you manage.

**MikroTik credentials.** RouterOS accounts used here should have only the `dns` and `read` group permissions, never `full`. Pair this with a dedicated user that is denied console/SSH access on the router side.

**Keytab (rfc2136).** Mount via a Docker secret, never via a bind mount that's world-readable on the host. The AD service account behind the keytab should have permissions to update only the zones listed in `RFC2136_ZONES`. Typically that means granting "Write" on those zones in DNS Manager and revoking write everywhere else.

**Docker socket.** The operator needs read access to `/var/run/docker.sock`. Mount it `:ro`. In Swarm or hostile multi-tenant environments, consider [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) to expose only the `containers` and `services` endpoints.

**TLS.** `MIKROTIK_SKIP_TLS_VERIFY=true` disables certificate validation. Only use it on networks where MITM is not in your threat model.

---

## Development

Requirements: Node.js ≥ 22.11, Yarn 1.22.x (classic, not Berry).

```bash
yarn install
yarn start:dev          # watch mode
yarn build              # nest build → dist/

yarn lint               # eslint --fix
yarn format             # prettier --write

yarn test               # unit
yarn test:cov           # unit with coverage
yarn test:e2e           # e2e (uses testcontainers; Docker required)
```

Adding a new provider means implementing the `DnsProvider` interface in [src/providers/dns-provider.interface.ts](src/providers/dns-provider.interface.ts), registering it in [provider-registry.service.ts](src/providers/provider-registry.service.ts), wiring config in [app.configuration.ts](src/app.configuration.ts), and updating [app.module.ts](src/app.module.ts). Unit specs live next to the code; e2e specs live under `test/`.

The rfc2136 sidecar lives in [transport-rfc2136/](transport-rfc2136/) and is a separate Go module with its own build and tests.

Conventions, architecture notes, and contribution guidelines for AI assistants are in [CLAUDE.md](CLAUDE.md).

---

## Credits

Started as a fork of [timk153/docker-external-dns](https://github.com/timk153/docker-external-dns) and has since diverged substantially. Conceptual debt to [kubernetes-sigs/external-dns](https://github.com/kubernetes-sigs/external-dns) and [dntsk/extdns](https://github.com/dntsk/extdns). Built on [NestJS](https://github.com/nestjs/nest).

## License

[MIT](LICENSE).
