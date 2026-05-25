# CLAUDE.md

## Project overview

Docker-aware DNS operator. Reads container labels (or Swarm `deploy.labels`),
reconciles A/AAAA/CNAME/MX/NS records via external-dns webhook v1 sidecars.

- **Sidecar-based DNS providers** — every backend (Cloudflare, MikroTik, RFC 2136) is
  a standalone webhook sidecar discovered via `WEBHOOK_<NAME>_URL` env vars. The
  operator carries no in-process DNS implementation.
- **Per-entry provider routing** via a `providers` label
- **Docker Swarm** discovery (auto-detected at startup via `docker info`)

The operator reads DNS labels from Docker containers (or Swarm services), reconciles
them against the configured sidecars on a CRON tick, and tags managed records with
`${PROJECT_LABEL}:${INSTANCE_ID}` so it never touches records it doesn't own.

The wire format between operator and sidecar is the
[kubernetes-sigs/external-dns webhook provider v1 contract](https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/webhook-provider/) —
the same sidecars work with upstream `external-dns` interchangeably.

See [README.md](README.md) for the user-facing guide.

## Tech stack

- **Runtime:** Node.js ≥ 22.11
- **Package manager:** Yarn 1.22.x (classic — do not upgrade to Berry)
- **Framework:** NestJS 11 (TypeScript)
- **Test runner:** Jest (unit + e2e)
- **Lint/format:** ESLint (airbnb-typescript) + Prettier
- **Container:** Dockerfile in repo root, published to GHCR
- **CI/CD:** GitHub Actions (CI, Release, CodeQL, Scorecard) — all action refs
  SHA-pinned with version comments; Dependabot keeps them current.

## Repository layout

```
src/
├── app.module.ts              Composition root
├── app.service.ts             Top-level reconciliation orchestrator
├── app.configuration.ts       Joi-validated env config (source of truth)
├── app.functions.ts           Pure helpers (diffing, routing)
├── webhook-provider/          Generic external-dns webhook v1 client + registry
├── docker/                    Docker / Swarm source — label parsing
├── providers/                 Provider interface + registry (kept thin; no impls)
├── ddns/                      DDNS (public IP) service
├── cron/                      CRON scheduler (with runJobSafely wrapper)
├── dto/, validators/, errors/, @types/
└── main.ts                    Nest bootstrap
sidecars/                      Git submodules (their own repos):
├── ddo-cloudflare/            Go, distroless, pure
├── ddo-mikrotik/              Go, distroless, pure
└── ddo-rfc2136/               Go, alpine + krb5 (CGO required for GSS-TSIG)
.github/workflows/             ci.yml, release.yml, codeql.yml, scorecard.yml
examples/                      Provider-specific compose minimal examples
test/                          e2e specs (jest-e2e.json) — testcontainers
docker-compose.yml             Full all-providers showcase
docker-stack.yml               Swarm-mode variant
```

Unit specs live next to the code (`*.spec.ts`). E2E specs live under `test/`.

## Common commands

```bash
yarn install                   # install deps
yarn start:dev                 # watch mode
yarn build                     # nest build → dist/
yarn lint                      # eslint --fix
yarn format                    # prettier --write

yarn test                      # unit tests
yarn test:watch
yarn test:cov                  # with coverage
yarn test:e2e                  # e2e (testcontainers — Docker required)
```

CI variants (`test:ci`, `test:e2e:ci`) tolerate non-zero exits — don't use them locally
for verification.

## Architecture notes

- **Provider abstraction** — every backend is a webhook sidecar speaking the
  external-dns webhook v1 contract. Discovery lives in
  [src/webhook-provider/registry.ts](src/webhook-provider/registry.ts):
  any env var matching `WEBHOOK_<NAME>_URL` registers a named provider whose key
  is `<NAME>` lowercased with underscores → hyphens. Adding a new backend is
  zero operator-side code: publish a sidecar repo + add one env var.
- **Per-entry routing** — each discovered DNS entry carries a `providers` field.
  The reconciler fans out entries strictly: a typo in `providers: [...]` fails
  that entry loudly. Empty/missing means "all enabled providers."
- **Ownership tagging** — the operator stamps every Endpoint with
  `labels.owner = ${PROJECT_LABEL}:${INSTANCE_ID}`. Sidecars round-trip that
  value verbatim through their backend's native facility:
  - Cloudflare / MikroTik — record `comment` field
  - RFC 2136 — paired TXT marker `ddo-<type>.<name>` with value `owned-by=<owner>`
  No sidecar derives ownership from its own env — two operators with different
  `INSTANCE_ID`s coexist safely in the same zone.
- **Swarm mode** — `DockerService.resolveSwarmMode()` calls `docker info` on the
  first `getSources()` tick. Enabled iff `Swarm.LocalNodeState === 'active'`
  AND `Swarm.ControlAvailable === true` (manager). In Swarm mode labels must
  live under `deploy.labels`, and `PRESERVE_STOPPED` is irrelevant.

## Release process

Tag-driven, fully automated per repo (operator + 3 sidecars):

1. Update `CHANGELOG.md` with a `## [X.Y.Z] — YYYY-MM-DD` section (Keep-a-Changelog).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. GitHub Actions `release.yml` triggers:
   - Extracts the matching CHANGELOG section via `awk` → release notes
   - Builds linux/amd64 (native) + linux/arm64 (`ubuntu-24.04-arm` native) per matrix
   - Push-by-digest to GHCR, then `buildx imagetools create` merges to manifest list
   - Tags: `:X.Y.Z`, `:X.Y`, `:X`, `:latest` (when not prerelease)
   - SBOM (SPDX) via `anchore/sbom-action`, provenance attestation via OIDC,
     Trivy SARIF → Security tab, GitHub Release with notes + SBOM
4. Sidecars first, operator last — so the operator's `:latest` references
   sidecars that already exist.

Tag protection rulesets block deletion/update of `v*` tags. Branch protection
on `main` blocks force-push, requires linear history + resolved conversations.

## Conventions

- **Tests are mandatory** for new behaviour — TDD-style. Unit spec next to the
  file; e2e under `test/` when crossing module boundaries.
- **Don't mock what you can fake.** Provider integration code prefers real
  interfaces with deterministic fakes over `jest.mock` spaghetti.
- **No comments explaining WHAT.** Only WHY, and only when the WHY isn't obvious.
- **Joi schemas are the source of truth** for env config —
  [src/app.configuration.ts](src/app.configuration.ts). Update them when adding
  variables, and update the README table.
- **Don't introduce new top-level deps** without a clear need; small, focused service.
- **Don't fork the wire contract.** The operator-to-sidecar protocol IS
  external-dns webhook provider v1. Read
  [.upstream/external-dns](https://github.com/kubernetes-sigs/external-dns) before
  inventing a shape.

## Placeholder conventions in committed examples

- AD/Kerberos realm: `AD.EXAMPLE.ORG` or `CORP.EXAMPLE.COM`.
- DC FQDN: `dc01.ad.example.org`.
- Zones/hostnames: `example.com` / `example.org` / `example.net` (RFC 2606).
- IPv4: RFC 5737 — `192.0.2.x` / `198.51.100.x` / `203.0.113.x`.
- RouterOS / LAN IPs: RFC 1918 ranges are fine for docs (`10.0.0.1`, `192.168.1.1`).

`examples/rfc2136/krb5.conf` is gitignored; only the `.example` is committed.
Same for `.env` vs `.env.example`.

## When making changes

1. Read the relevant module's existing spec file first — it documents the contract.
2. Add/extend the spec before changing implementation.
3. Run `yarn lint && yarn test` before declaring done. Run `yarn test:e2e` if your
   change touches reconciliation, Docker source, or webhook wiring.
4. Update [README.md](README.md) and `.env.example` if env vars / labels /
   user-visible behaviour changed.
5. If a sidecar contract changes, update the sidecar repo too (it's a submodule —
   commit there first, then bump the operator's pointer).

## Out of scope for this repo

- Kubernetes integration (use upstream
  [external-dns](https://github.com/kubernetes-sigs/external-dns) — same wire
  contract, so any sidecar works there too).
- Non-Docker sources.
- IPv6 DDNS (only IPv4 is supported for the `"DDNS"` literal; AAAA records
  themselves are supported via rfc2136).
