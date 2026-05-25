# CLAUDE.md

## What this is

Docker/Swarm DNS operator. Reads container labels, reconciles records via
external-dns **webhook v1** sidecars (`ddo-cloudflare`, `ddo-mikrotik`,
`ddo-rfc2136`) discovered by `WEBHOOK_<NAME>_URL` env vars. Zero in-process
DNS implementations in the operator.

## Gotchas

- **Yarn 1.22.x classic — DO NOT upgrade to Berry.**
- `sidecars/` are git submodules pointing at separate repos. `ddo-rfc2136`
  needs `CGO_ENABLED=1` + `libkrb5-dev` (GSS-TSIG); the other two are pure Go.
- `yarn test:e2e` uses testcontainers — needs a running Docker daemon.
- Joi schema in [src/app.configuration.ts](src/app.configuration.ts) is the
  source of truth for env vars. Update it + the README table together.
- `.github/workflows/*` action refs are SHA-pinned with version comments —
  Dependabot updates them. **Don't relax to floating tags.**
- `examples/rfc2136/krb5.conf` is gitignored; only `krb5.conf.example` is
  committed. Same pattern for `.env` vs `.env.example`.

## Non-obvious behavior

- **Registry discovery.** Any env `WEBHOOK_<NAME>_URL` registers a provider
  whose key is `<NAME>` lowercased, `_` → `-`. New backends ship as
  separate sidecar repos — zero operator-side code change.
- **Strict routing.** A typo in a label's `providers: [...]` fails that
  entry loudly. No silent fallback.
- **Ownership round-trip.** Operator stamps `labels.owner =
  ${PROJECT_LABEL}:${INSTANCE_ID}` on every Endpoint. Sidecars persist it
  verbatim — CF/MT in the row `comment`, rfc2136 in a paired TXT marker
  `ddo-<type>.<name>=owned-by=<owner>`. **Sidecars NEVER derive ownership
  from their own env.** Two operators with different `INSTANCE_ID`s share a
  zone safely.
- **Swarm auto-detect.** `DockerService.resolveSwarmMode()` calls
  `docker info` on first tick. Manager → `listServices` + `deploy.labels`.
  In Swarm mode `PRESERVE_STOPPED` is irrelevant.
- **CronService.runJobSafely** wraps every tick — a sidecar outage MUST
  NOT crash the operator.

## Workflow

1. TDD. Unit spec next to code (`*.spec.ts`); e2e under `test/` if it
   crosses module boundaries.
2. `yarn lint && yarn test` before declaring done. Run `yarn test:e2e` if
   the change touches reconciliation, Docker source, or webhook wiring.
3. If a sidecar contract changes: commit there first (it's a submodule
   with its own repo), then bump the pointer here.

## Releases

Tag-driven per repo. `git tag vX.Y.Z && git push origin vX.Y.Z` →
`.github/workflows/release.yml` extracts the matching `CHANGELOG.md`
section, builds multi-arch (amd64 native + arm64 on `ubuntu-24.04-arm`),
pushes to `ghcr.io/mrkhachaturov/<repo>` with SBOM + provenance + Trivy
SARIF + GitHub Release. **Sidecars first, operator last.**

Tag rulesets block delete/update on `v*`. `main` is force-push-protected
and requires linear history.

## Conventions

- Don't mock what you can fake — real interfaces with deterministic fakes
  over `jest.mock` spaghetti.
- Comments explain WHY, not WHAT. Skip the comment if the WHY is obvious.
- **DON'T fork the wire contract.** The operator↔sidecar protocol IS
  external-dns webhook provider v1. Read
  [kubernetes-sigs/external-dns](https://github.com/kubernetes-sigs/external-dns)
  before inventing a shape.
- No new top-level deps without a clear need.

## Placeholders in committed examples

- AD realm: `AD.EXAMPLE.ORG` / `CORP.EXAMPLE.COM`
- DC FQDN: `dc01.ad.example.org`
- Zones: `example.com` / `.org` / `.net` (RFC 2606)
- Public IPv4: `192.0.2.x` / `198.51.100.x` / `203.0.113.x` (RFC 5737)
- LAN IPs: RFC 1918 is fine in docs
