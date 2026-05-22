# CLAUDE.md

Guidance for Claude Code (and other AI assistants) when working in this repository.

> This file is public. Keep it free of secrets, hostnames, internal URLs, and personal
> context. Anything internal belongs in `CLAUDE.local.md` (gitignored).

## Project overview

Fork of [timk153/docker-external-dns](https://github.com/timk153/docker-external-dns) that
adds:

- **MikroTik RouterOS** provider (alongside CloudFlare)
- **Per-entry provider routing** via a `providers` label
- **Docker Swarm** discovery (`DOCKER_SWARM_MODE=true`)

The service reads DNS labels from Docker containers (or Swarm services), reconciles them
against the configured providers on a CRON tick, and tags managed records with an
ownership comment (`${PROJECT_LABEL}:${INSTANCE_ID}`) so it never touches records it
doesn't own.

See [README.md](README.md) for the full user-facing guide.

## Tech stack

- **Runtime:** Node.js ≥ 22.11
- **Package manager:** Yarn 1.22.x (classic — do not upgrade to Berry)
- **Framework:** NestJS 11 (TypeScript)
- **Test runner:** Jest (unit + e2e)
- **Lint/format:** ESLint (airbnb-typescript) + Prettier
- **Container:** Dockerfile in repo root

## Repository layout

```
src/
├── app.module.ts              Composition root
├── app.service.ts             Top-level reconciliation orchestrator
├── app.configuration.ts       Joi-validated env config
├── app.functions.ts           Pure helpers (diffing, routing)
├── cloud-flare/               CloudFlare provider impl
├── mikrotik/                  MikroTik RouterOS provider impl
├── docker/                    Docker / Swarm source — label parsing
├── providers/                 Provider interface + registry
├── ddns/                      DDNS (public IP) service
├── cron/                      CRON scheduler
├── dto/, validators/, errors/, providers/, @types/
└── main.ts                    Nest bootstrap
test/                          e2e specs (jest-e2e.json)
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
yarn test:e2e                  # e2e tests (runInBand)
```

CI variants (`test:ci`, `test:e2e:ci`) tolerate non-zero exits — don't use them locally
for verification.

## Architecture notes

- **Provider abstraction** — every provider implements `DnsProvider` in
  [src/providers/dns-provider.interface.ts](src/providers/dns-provider.interface.ts).
  Adding a new provider means: implementing that interface, registering in
  [provider-registry.service.ts](src/providers/provider-registry.service.ts), wiring config
  in [app.configuration.ts](src/app.configuration.ts), and updating
  [app.module.ts](src/app.module.ts).
- **Per-entry routing** — each discovered DNS entry carries a `providers` field. The
  reconciler fans out entries to the providers named in that field. Empty/missing means
  "all enabled providers."
- **Ownership tagging** — managed records carry `${PROJECT_LABEL}:${INSTANCE_ID}` as a
  comment. Reconciliation only diffs records matching that tag — unrelated records are
  never touched.
- **Swarm mode** — `DockerService.getSources()` switches between container and service
  enumeration based on `DOCKER_SWARM_MODE`. In Swarm mode, labels must be set via
  `deploy.labels`, and `PRESERVE_STOPPED` is irrelevant (services are always listed).

## Conventions

- **Tests are mandatory** for new behaviour — TDD-style. Unit spec next to the file;
  e2e spec under `test/` if it crosses module boundaries.
- **Don't mock what you can fake.** Provider integration code prefers real interfaces
  with deterministic fakes over jest.mock spaghetti.
- **No comments explaining WHAT.** Only WHY, and only when the WHY isn't obvious.
- **Joi schemas are the source of truth** for env config — update them when adding
  variables, and update the README table.
- **Don't introduce new top-level deps** without a clear need; this is a small,
  focused service.

## When making changes

1. Read the relevant module's existing spec file first — it documents the contract.
2. Add/extend the spec before changing implementation.
3. Run `yarn lint && yarn test` before declaring done. Run `yarn test:e2e` if your
   change touches reconciliation, Docker source, or provider wiring.
4. Update [README.md](README.md) if you changed env vars, labels, or user-visible
   behaviour.

## Out of scope for this repo

- Kubernetes integration (use upstream
  [external-dns](https://github.com/kubernetes-sigs/external-dns))
- Non-Docker sources
- IPv6 DDNS (only IPv4 is supported today)

## Internal context

Anything site-specific (deployment targets, secrets paths, internal hostnames, CI runner
names, who uses this where) lives in `CLAUDE.local.md` — not here.
