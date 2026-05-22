# 🧭 docker-dns-operator

> 🐳 Declarative DNS for Docker. The Docker analog of [kubernetes-sigs/external-dns](https://github.com/kubernetes-sigs/external-dns): label your containers (standalone Docker) or services (Swarm) with the desired DNS records and the operator reconciles them into Cloudflare, MikroTik RouterOS, and/or Active Directory DNS on every tick.

[![Docker Hub](https://img.shields.io/docker/v/mrkhachaturov/docker-dns-operator?label=docker&sort=semver)](https://hub.docker.com/r/mrkhachaturov/docker-dns-operator)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

| | Scope | Meaning |
|---|---|---|
| 🐳 | Runs on | Standalone Docker (default) and Docker Swarm (`DOCKER_SWARM_MODE=true`) |
| 🏷️ | Source of truth | Container labels, or Swarm `deploy.labels` |
| 🔄 | Reconciler | Reads labels every `EXECUTION_FREQUENCY_SECONDS`, diffs, applies |
| 🌐 | Providers | Cloudflare, MikroTik RouterOS, RFC 2136 / Active Directory |
| 🛡️ | Ownership | TXT marker `ddo-<type>.<name>`. Pre-existing records are never touched |
| 🧩 | Records | A, AAAA (rfc2136), CNAME, MX, NS |

> [!TIP]
> Two instances with different `INSTANCE_ID`s can manage the same zone without conflicting. Each instance only sees and modifies records carrying its own ownership marker.

---

## 📚 Contents

- [🗺️ Architecture](#️-architecture)
- [⚡ Quick start](#-quick-start)
- [🌐 Providers](#-providers)
- [⚙️ Configuration](#️-configuration)
- [📦 Examples](#-examples)
- [🛠️ Operations](#️-operations)
- [🔐 Security](#-security)
- [🧪 Development](#-development)
- [🙏 Credits](#-credits)
- [📜 License](#-license)

---

## 🗺️ Architecture

```mermaid
graph LR
    DK["🐳 Docker socket<br/>containers / services"] --> OP["🧭 docker-dns-operator<br/>reconciler loop"]

    OP --> CF["☁️ Cloudflare<br/>public DNS"]
    OP --> MT["📡 MikroTik<br/>RouterOS REST"]
    OP --> TR["🔌 transport-rfc2136<br/>Kerberos / GSS-TSIG"]
    TR --> AD["🏢 Active Directory<br/>DNS (RFC 2136)"]

    style DK fill:#2496ed,color:#fff,stroke:#2496ed
    style OP fill:#0f766e,color:#fff,stroke:#0f766e
    style CF fill:#f38020,color:#fff,stroke:#f38020
    style MT fill:#293039,color:#fff,stroke:#293039
    style TR fill:#8b5cf6,color:#fff,stroke:#8b5cf6
    style AD fill:#0078d4,color:#fff,stroke:#0078d4
```

Each tick the reconciler:

1. 📥 Lists Docker containers (or Swarm services when `DOCKER_SWARM_MODE=true`).
2. 🏷️ Parses the `${PROJECT_LABEL}:${INSTANCE_ID}` label as a JSON array of entries.
3. 🔀 Groups entries by their `providers` field.
4. ⚖️ For each provider, diffs desired state against owned records and applies create/update/delete.

Standalone Docker is the default. Swarm mode is opt-in via `DOCKER_SWARM_MODE=true`, in which case labels must live under `deploy.labels` and the operator must run on a manager node.

> [!IMPORTANT]
> Every managed record carries a sibling TXT record at `ddo-<type>.<name>` whose value is `owned-by=${PROJECT_LABEL}:${INSTANCE_ID}`. The reconciler refuses to modify any record without that marker.
>
> For an A record at `app.example.com` you'll see a paired `TXT ddo-a.app.example.com "owned-by=docker-dns-operator:1"` in the zone.

---

## ⚡ Quick start

Minimum Cloudflare setup. Drop this into a `docker-compose.yml`, supply a token, run `docker compose up -d`:

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

The operator polls Docker every `EXECUTION_FREQUENCY_SECONDS` (default 60), reads the label off `whoami`, and creates `whoami.example.com` in Cloudflare. Remove the container, the record is removed on the next tick.

For MikroTik or Active Directory, see [Providers](#-providers).

---

## 🌐 Providers

### ☁️ Cloudflare

Enabled when `API_TOKEN` **or** `API_TOKEN_FILE` is set. The token needs `Zone.Zone:Read` and `Zone.DNS:Edit` for every zone you manage.

Supports A, CNAME, MX, NS, with optional proxying via `providerOptions.cf.proxy`.

> [!WARNING]
> Use `API_TOKEN_FILE` with a Docker secret in production. `API_TOKEN` plain-env is visible via `docker inspect`.

### 📡 MikroTik RouterOS

Enabled when `MIKROTIK_BASEURL`, `MIKROTIK_USERNAME`, and `MIKROTIK_PASSWORD` are all set. Talks to the RouterOS REST API on the same port as the web UI (`www` 80 / `www-ssl` 443).

Supports A, CNAME, MX, NS.

If your router uses a self-signed certificate, set `MIKROTIK_SKIP_TLS_VERIFY=true`. Trusted networks only.

### 🏢 RFC 2136 / Active Directory

Enabled when the full `RFC2136_*` block is set. Uses the same RFC 2136 provider model as [external-dns](https://github.com/kubernetes-sigs/external-dns/blob/master/docs/tutorials/rfc2136.md), with GSS-TSIG enabled for Active Directory DNS.

Supports A, AAAA, CNAME, MX, NS.

```mermaid
graph LR
    OP["🧭 operator"] -->|HTTP| TR["🔌 transport-rfc2136<br/>Go sidecar"]
    KT["🔑 keytab"] -->|kinit -kt| TR
    TR -->|GSS-TSIG signed| DC1["🏢 DC #1"]
    TR -->|GSS-TSIG signed| DC2["🏢 DC #2"]
    TR -->|/healthz| HC{"🩺 alive?"}

    style OP fill:#0f766e,color:#fff,stroke:#0f766e
    style TR fill:#8b5cf6,color:#fff,stroke:#8b5cf6
    style KT fill:#f59e0b,color:#000,stroke:#f59e0b
    style DC1 fill:#0078d4,color:#fff,stroke:#0078d4
    style DC2 fill:#0078d4,color:#fff,stroke:#0078d4
    style HC fill:#10b981,color:#fff,stroke:#10b981
```

The Kerberos/TSIG protocol layer runs in a separate Go sidecar (`transport-rfc2136`). The sidecar runs `kinit -kt` against a keytab on startup, refreshes the TGT every `RFC2136_KINIT_REFRESH_INTERVAL`, signs UPDATE and AXFR with GSS-TSIG, and exposes `/healthz` (HTTP 503 with `{"kerberos":"expired"}` on refresh failure).

The operator implements failover across multiple DCs (`RFC2136_HOSTS`) with a per-DC circuit breaker, per-zone DC pinning, and a TAXFR-off mode for environments where AXFR is denied.

> [!CAUTION]
> `RFC2136_HOSTS` must contain real DNS hostnames of your DCs. IPs and bare hostnames are rejected at startup. AD's Kerberos service principal is bound to the host you contact; an IP or short name produces `KDC_ERR_S_PRINCIPAL_UNKNOWN` or `KDC_ERR_WRONG_REALM` on every cycle.

See [docs/rfc2136-integration-runbook.md](docs/rfc2136-integration-runbook.md) for keytab generation, AD permission setup, and the full deployment walkthrough.

---

## ⚙️ Configuration

### 🌍 Environment variables

<details>
<summary><strong>🧭 Common (always applicable)</strong></summary>

| Variable | Default | Description |
|---|---|---|
| `PROJECT_LABEL` | `docker-dns-operator` | First half of the Docker label key, and the ownership marker for managed records. |
| `INSTANCE_ID` | `1` | Second half of the label key. Combined as `${PROJECT_LABEL}:${INSTANCE_ID}`. |
| `EXECUTION_FREQUENCY_SECONDS` | `60` | Reconciliation interval. Integer ≥ 1. |
| `DDNS_EXECUTION_FREQUENCY_MINUTES` | `60` | Public IP check interval. Only active when an entry uses `"address": "DDNS"`. |
| `PRESERVE_STOPPED` | `false` | If `true`, stopped containers keep their DNS entries. Removed containers always lose them. Ignored in Swarm mode. |
| `DOCKER_SWARM_MODE` | `false` | If `true`, discover entries from Swarm services (`deploy.labels`) instead of containers. |
| `LOG_LEVEL` | `error` | One of `fatal`, `error`, `warn`, `log`, `debug`, `verbose`. |

</details>

<details>
<summary><strong>☁️ Cloudflare</strong></summary>

| Variable | Default | Description |
|---|---|---|
| `API_TOKEN` |  | Cloudflare API token. Setting this OR `API_TOKEN_FILE` enables the provider. |
| `API_TOKEN_FILE` |  | Path to a file containing the token. Preferred over `API_TOKEN`. |

</details>

<details>
<summary><strong>📡 MikroTik</strong></summary>

| Variable | Default | Description |
|---|---|---|
| `MIKROTIK_BASEURL` |  | Base URL of the RouterOS REST API, e.g. `https://192.168.1.1`. All three vars must be set together. |
| `MIKROTIK_USERNAME` |  | API username. |
| `MIKROTIK_PASSWORD` |  | API password. |
| `MIKROTIK_SKIP_TLS_VERIFY` | `false` | Disable TLS verification. Trusted networks only. |
| `MIKROTIK_DEFAULT_TTL` | `3600` | TTL applied to newly created records, in seconds. |

</details>

<details>
<summary><strong>🏢 RFC 2136 (all-or-nothing)</strong></summary>

Every required variable must be set, or the provider is silently skipped.

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
| `RFC2136_TAXFR` | `true` | If `false`, skip AXFR (use when AD blocks zone transfers). Reduces drift detection; writes rely on UPDATE prerequisites. |
| `RFC2136_DOMAIN_FILTER` |  | Comma-separated name suffixes. Restricts which entries are managed without narrowing `RFC2136_ZONES`. |
| `RFC2136_KINIT_REFRESH_INTERVAL` | `12h` | Sidecar setting. How often the TGT is refreshed. Go duration syntax. |

</details>

### 🏷️ Label schema

A single Docker label whose **key** is `${PROJECT_LABEL}:${INSTANCE_ID}` and whose **value** is a JSON-stringified array of entry objects.

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

| Field | Type | Description |
|---|---|---|
| `type` | string | One of `A`, `AAAA`, `CNAME`, `MX`, `NS`. |
| `name` | string | Fully-qualified record name. |
| `providers` | string \| array | `["cf"]`, `["mikrotik"]`, `["rfc2136"]`, any combination, or the shorthand `"all"`. Defaults to `["cf"]` when omitted. |
| `provider` | string | Legacy singular form. Accepted and normalized to `providers`. |
| `providerOptions` | object | Per-provider options, keyed by provider id. |

`providerOptions.cf.proxy` (boolean) toggles Cloudflare proxying for A/CNAME. `providerOptions.rfc2136.ttl` (integer seconds) overrides the default TTL on rfc2136. The legacy top-level `proxy` field is still accepted for Cloudflare entries.

### 🧩 Record types

| | Type | Required fields | Notes |
|---|---|---|---|
| 🅰️ | `A` | `address` | Address can be the literal `"DDNS"` to use the host's public IPv4. |
| 6️⃣ | `AAAA` | `address` | Currently implemented only for the rfc2136 provider. Route AAAA entries to `rfc2136`. |
| 🔗 | `CNAME` | `target` | Target should resolve via an existing A or CNAME. |
| ✉️ | `MX` | `server`, `priority` | Priority is an integer 0–65535. |
| 🧭 | `NS` | `server` | Delegates a (sub)domain to another nameserver. |

---

## 📦 Examples

### 🔐 Token in a file (recommended for Cloudflare)

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

<details>
<summary>🔀 <strong>Split routing — public to Cloudflare, internal to MikroTik</strong></summary>

```yaml
services:
  dns-operator:
    image: mrkhachaturov/docker-dns-operator:latest
    environment:
      API_TOKEN_FILE: /run/secrets/cloudflare_token
      MIKROTIK_BASEURL: "https://192.168.1.1"
      MIKROTIK_USERNAME: admin
      MIKROTIK_PASSWORD: changeme
    secrets:
      - cloudflare_token
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

</details>

### 🌐 DDNS — public IPv4 of the host

```yaml
labels:
  docker-dns-operator:1: |
    [{ "type": "A", "name": "home.example.com", "address": "DDNS" }]
```

The operator starts the DDNS service when any entry uses `"DDNS"`, queries the current public IPv4 every `DDNS_EXECUTION_FREQUENCY_MINUTES`, and updates the record when the IP changes.

<details>
<summary>🔢 <strong>Two domains, two operator instances</strong></summary>

Independent Cloudflare tokens by `INSTANCE_ID`:

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

</details>

<details>
<summary>🏢 <strong>Active Directory (RFC 2136)</strong></summary>

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

See [docs/rfc2136-integration-runbook.md](docs/rfc2136-integration-runbook.md) for the full setup.

</details>

<details>
<summary>🐝 <strong>Docker Swarm</strong></summary>

Labels must live under `deploy.labels`, not the top-level `labels` key:

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

</details>

---

## 🛠️ Operations

### 📝 Logging

`LOG_LEVEL` maps to the NestJS logger. Order from most-specific to least: `fatal` → `error` → `warn` → `log` → `debug` → `verbose`. Each level includes everything above. Production deployments typically run at `warn` or `error`. Invalid values are rejected at startup with a clear validation error.

### 🩺 Health

The main operator does not currently expose an HTTP health endpoint. The rfc2136-transport sidecar exposes `/healthz` on port 9090; HTTP 200 means Kerberos is alive, 503 means the TGT could not be refreshed.

### ⚠️ Failure modes worth knowing

- 🏢 The rfc2136 provider is all-or-nothing. Every required variable must be set, or the provider is silently not registered and entries routed to `rfc2136` are dropped with a warning.
- 6️⃣ AAAA is currently implemented only for the rfc2136 provider. Route AAAA entries to `rfc2136`.

---

## 🔐 Security

| | Concern | Recommendation |
|---|---|---|
| 🔑 | Cloudflare tokens | Use `API_TOKEN_FILE` with a Docker secret. Scope to `Zone.Zone:Read` + `Zone.DNS:Edit` on the specific zones only. |
| 📡 | MikroTik creds | Dedicated RouterOS user with `dns` + `read` groups only, console/SSH denied. |
| 🏢 | Keytab (rfc2136) | Mount via Docker secret, never a world-readable bind mount. AD service account scoped to update only zones in `RFC2136_ZONES`. |
| 🐳 | Docker socket | Mount `:ro`. Consider [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) in hostile multi-tenant environments. |
| 🔓 | TLS | `MIKROTIK_SKIP_TLS_VERIFY=true` disables certificate validation. Trusted networks only. |

> [!WARNING]
> `API_TOKEN` plain-env leaks via `docker inspect`, image layers, and container exec. Always prefer `API_TOKEN_FILE` + Docker secrets in production.

---

## 🧪 Development

Requirements: Node.js ≥ 22.11, Yarn 1.22.x (classic, not Berry).

```bash
yarn install
yarn start:dev          # 👀 watch mode
yarn build              # 🏗️ nest build → dist/

yarn lint               # 🧹 eslint --fix
yarn format             # 💅 prettier --write

yarn test               # 🧪 unit
yarn test:cov           # 📊 unit with coverage
yarn test:e2e           # 🐳 e2e (uses testcontainers, Docker required)
```

Adding a new provider means implementing the `DnsProvider` interface in [src/providers/dns-provider.interface.ts](src/providers/dns-provider.interface.ts), registering it in [provider-registry.service.ts](src/providers/provider-registry.service.ts), wiring config in [app.configuration.ts](src/app.configuration.ts), and updating [app.module.ts](src/app.module.ts). Unit specs live next to the code; e2e specs live under `test/`.

The rfc2136 sidecar lives in [transport-rfc2136/](transport-rfc2136/) as a separate Go module with its own build and tests.

Conventions and architecture notes for AI assistants are in [CLAUDE.md](CLAUDE.md).

---

## 🙏 Credits

Started as a fork of [timk153/docker-external-dns](https://github.com/timk153/docker-external-dns) and has since diverged substantially. Conceptual debt to [kubernetes-sigs/external-dns](https://github.com/kubernetes-sigs/external-dns) and [dntsk/extdns](https://github.com/dntsk/extdns). Built on [NestJS](https://github.com/nestjs/nest).

## 📜 License

[MIT](LICENSE).
