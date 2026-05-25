# Changelog

All notable changes to **docker-dns-operator** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] — 2026-05-25

### Added
- `LIVENESS_FILE` env var (default `/tmp/ddo.alive` inside the image, empty/disabled outside). The reconciler writes the current epoch-ms to this file at the end of every cron tick — success **or** caught failure. Verifies the loop is actually ticking, not just that the process is alive.
- `HEALTHCHECK` directive in the operator's Dockerfile — file-mtime comparison against `2 × EXECUTION_FREQUENCY_SECONDS + 30s`. Catches hard hangs (event-loop deadlock, OOM, SIGKILL) without flapping on transient sidecar outages.
- `CronService.onTickComplete()` hook — called once per tick from outside the per-tick try/catch. Subclasses override to plug in liveness markers or metrics; `DdnsService` is unaffected (default no-op).
- `docker-stack.yml` now ships explicit `healthcheck:` blocks for the operator and all three sidecars, mirroring the image-baked HEALTHCHECK directives. Surfaces in `docker service inspect` and easy to override per environment.

### Changed
- Bumped submodule pointers to the new sidecar releases:
  - `ddo-rfc2136` → v0.1.1 (file-delivered base64 keytab + principal, baked HEALTHCHECK).
  - `ddo-cloudflare` → v0.1.1 (`webhook healthcheck` subcommand + baked HEALTHCHECK).
  - `ddo-mikrotik` → v0.1.1 (same shape as cloudflare).

## [0.1.1] — 2026-05-25

### Changed
- `PRESERVE_STOPPED` is now honoured in Swarm mode. The operator queries `listServices` with `status: true` and filters services whose `ServiceStatus.RunningTasks` is `0` the same way it filters `exited` containers in standalone mode: included only when `PRESERVE_STOPPED=true`. The standalone-vs-swarm mapping is now consistent — both modes treat a removed workload (`docker rm` / `docker service rm`) as record-drop, and a "deployment exists but not running" state (crash loop, scaled to 0, image pull failure) as governed by `PRESERVE_STOPPED`.
- Removed the startup warning `"PRESERVE_STOPPED has no effect on a swarm manager"` — the flag is no longer a no-op there.

## [0.1.0] — 2026-05-25

First tagged release of the sidecar-based architecture.

### Added
- Generic webhook-provider discovery: every backend is a sidecar registered via a `WEBHOOK_<NAME>_URL` env var. `<NAME>` becomes the provider key (lowercased; underscores → hyphens) referenced from each entry's `providers: [...]` label. Multiple named instances of the same backend (e.g. `mikrotik-home` + `mikrotik-office`, `cf-personal` + `cf-work`) are first-class — declare more env vars, route accordingly.
- Per-entry routing via the `providers` field on each label entry. Fan-out is strict: a typo in the provider name fails the entry loudly; the operator never guesses.
- Three reference sidecars shipped as git submodules under [sidecars/](sidecars/):
  - [ddo-cloudflare](https://github.com/mrkhachaturov/ddo-cloudflare) — Cloudflare API
  - [ddo-mikrotik](https://github.com/mrkhachaturov/ddo-mikrotik) — MikroTik RouterOS native binary API
  - [ddo-rfc2136](https://github.com/mrkhachaturov/ddo-rfc2136) — GSS-TSIG against Active Directory
- Docker Swarm support auto-detected at startup via `docker info`. On a manager the operator switches to `listServices` and reads `deploy.labels`; on standalone Docker it stays on container labels.
- Records supported: A, AAAA (rfc2136 only), CNAME, MX, NS.
- DDNS mode: an A record with `address: "DDNS"` is reconciled to the host's public IPv4 every `DDNS_EXECUTION_FREQUENCY_MINUTES`.
- Ownership marker `${PROJECT_LABEL}:${INSTANCE_ID}` carried through each sidecar's native facility — the record `comment` field on Cloudflare/MikroTik, a paired TXT marker `ddo-<type>.<name>` on rfc2136. Pre-existing records are never touched. Two instances with different `INSTANCE_ID`s coexist in the same zone.
- Per-CRON-tick failure isolation: a stuck or erroring sidecar logs and the operator continues; the next tick retries.
- Joi-validated env schema with clear startup failures on misconfiguration.

### Changed
- Removed every in-process DNS provider from the operator. Cloudflare, MikroTik, and RFC 2136 implementations now live in their own repos and are addressed only via `WEBHOOK_<NAME>_URL`. The operator side of each provider has shrunk to a single env var.
- The wire format between operator and sidecar is the [kubernetes-sigs/external-dns webhook provider v1 contract](https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/webhook-provider/) — chosen so the same sidecar can serve docker-dns-operator and the upstream external-dns controller interchangeably.

### Notes
- Forked from [timk153/docker-external-dns](https://github.com/timk153/docker-external-dns); diverged substantially.
- See [README.md](README.md) for the full configuration reference and examples.

[Unreleased]: https://github.com/mrkhachaturov/docker-dns-operator/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/mrkhachaturov/docker-dns-operator/releases/tag/v0.1.2
[0.1.1]: https://github.com/mrkhachaturov/docker-dns-operator/releases/tag/v0.1.1
[0.1.0]: https://github.com/mrkhachaturov/docker-dns-operator/releases/tag/v0.1.0
