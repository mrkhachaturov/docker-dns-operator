# Changelog

All notable changes to **docker-dns-operator** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-06-07

### Added

- **Wildcard record names.** A label entry may now use a leading `*.` wildcard `name` (e.g. `*.dev.example.com`) for any record type. The DTO validator switched from a bare `@IsFQDN()` to `@IsFQDN({ allow_wildcard: true })`, mirroring external-dns, which treats `*.` as an ordinary owner name. Whether a wildcard actually lands depends on the target provider/zone: MikroTik stores it as a `regexp` row, Cloudflare supports `*.` natively, and **Windows AD DNS refuses wildcards via RFC 2136 dynamic update** (create manually, delegate the subzone, or route the wildcard to MikroTik). See [LABELS.md](LABELS.md).
- **external-dns-style per-record reconcile logging.** Each applied change now logs a `[<provider>] Desired change: <CREATE|UPDATE|DELETE> <type>:<name>` line, alongside the existing per-provider `Synchronisation complete: …` summary — so a deploy that changes records is visible in `docker logs` out of the box.

### Changed

- **`LOG_LEVEL` now defaults to `log`** (was `error`), matching external-dns's `info` default. Startup, per-record changes, and the sync summary are visible by default; label-validation drops surface at `warn`. Drop to `warn`/`error` for quieter production, or raise to `debug` to also see no-op ticks. `info` remains accepted as an alias for `log`.
- Bumped sidecar submodule pointers to **ddo-mikrotik v0.2.0** and **ddo-rfc2136 v0.2.0** (both add wildcard support; ddo-rfc2136 also self-tunes its Kerberos TGT refresh — see their changelogs).

## [0.1.4] — 2026-06-04

### Fixed

- **Fail-open-to-delete on an unreadable Docker source ([#12]).** A transient socket outage at startup made `DockerService.resolveSwarmMode()` swallow the `docker.info()` failure, cache `container` mode for the life of the process, and never re-probe. In a Swarm stack that meant `getSources()` returned `[]` (service `deploy.labels` aren't visible as container labels), the desired set computed to zero, and reconcile deleted **every owned record** across all providers — then stayed stuck until a manual restart. `resolveSwarmMode()` now **throws** on a failed `docker.info()` probe instead of guessing a mode, and leaves the result **unresolved** so the next event/fallback tick re-probes and self-heals once the socket recovers. A failed probe now aborts the reconcile cycle (no deletes) rather than degrading to a phantom empty source — the legitimate "deployed but not running" case stays governed by `PRESERVE_STOPPED` exactly as before.

[#12]: https://github.com/mrkhachaturov/docker-dns-operator/issues/12

## [0.1.3] — 2026-05-25

Reactive reconcile. The operator stopped polling Docker on a fixed timer and now subscribes to the daemon's event stream — DNS records propagate within ~500 ms of a container start/stop instead of waiting up to a minute. The old fixed-interval timer survives as a slow safety net (and as the DDNS-IP propagation trigger, which has no Docker event).

### Added

- `DockerService.subscribeToEvents(callback)` — long-lived subscription to the Docker daemon's event stream. Filters `container create/start/stop/die/destroy` and, on Swarm managers, additionally `service create/update/remove`. NDJSON line-buffered, auto-reconnects on stream error/end (single reconnect path, 5 s backoff), survives unsubscribe-before-connect via internal state guards.
- `RECONCILE_DEBOUNCE_MS` env var (Joi range 50–10000, default 500). Coalesces bursts of Docker events (e.g. a `docker stack deploy` creating 10 services at once) into a single reconcile pass.
- `HEALTH_PORT` env var (default 9090, same as the sidecars) — port the operator's `GET /healthz` listens on.
- `GET /healthz` HTTP endpoint on the operator. Returns `200 {"status":"ok"}` when the HTTP server is up and the Node event loop is responding — i.e. pure liveness, the same shape `external-dns` exposes (`controller/execute.go::serveMetrics`).
- Lifecycle tests for the new reactive loop: subscribe-before-initial-sync ordering, event-burst coalescing, follow-up queuing during in-flight job, stop-during-in-flight cleanup, start-after-stop rejection.

### Changed

- **Primary reconcile trigger is now Docker events, not the timer.** `EXECUTION_FREQUENCY_SECONDS` (default 60) survives as the **fallback** interval — safety net for missed events and the only mechanism that propagates DDNS public-IP changes (no Docker event fires for those). Existing deployments need no config change; the timer keeps doing its old job, just less often in practice.
- `AppService` no longer extends `CronService`. The reconcile loop is built around a non-reentrant, debounced `scheduleReconcile()` fed by both the event stream and the fallback timer. Stop-guards in every callback prevent post-shutdown work. `DdnsService` keeps extending `CronService` unchanged — public-IP polling is genuinely periodic.
- `main.ts` bootstraps via `NestFactory.create()` + `app.listen(HEALTH_PORT, '0.0.0.0')` instead of the headless `createApplicationContext()` it used in 0.1.2. The operator now actually serves HTTP (the 0.1.2 `EXPOSE 80` was a dead declaration; this release switches to `EXPOSE 9090`).
- `HEALTHCHECK` in the operator's Dockerfile is now `wget -q --spider http://127.0.0.1:9090/healthz` — mirrors the rfc2136 sidecar's probe shape. Removed the shell-arithmetic file-mtime check used in 0.1.2.

### Removed

- `LIVENESS_FILE` env var and the file-mtime liveness mechanism it backed. The check it implemented ("loop has ticked within `2 × freq + 30s`") conflated process liveness with reconcile success; with the event-driven model, "process alive and HTTP responding" is the honest signal and provider failures already surface in the log + each sidecar's own `/healthz`.
- `AppService.onTickComplete()` override (and its dependency on `fs`/`stat` semantics).
- The compose-level healthcheck in 0.1.2's `docker-stack.yml` for the operator that used `stat -c %Y "$LIVENESS_FILE"` — that command silently broke under compose variable interpolation. The new `wget --spider` form has no such trap.

### Fixed

- Operator no longer fails to serve any HTTP at all (a latent 0.1.2 bug: `NestFactory.createApplicationContext` never bound a listener, and the `EXPOSE 80` in the Dockerfile was a misleading hint).

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
