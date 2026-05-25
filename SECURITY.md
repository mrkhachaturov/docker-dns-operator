# Security Policy

## Supported versions

Only the latest minor release line is supported. Older tags receive fixes
on a best-effort basis if the fix is trivial; otherwise users should
upgrade. The Docker image tag `:latest` always tracks the most recent
release.

| Version  | Supported          |
| -------- | ------------------ |
| `0.1.x`  | :white_check_mark: |
| `< 0.1`  | :x:                |

The same policy applies to the sidecars shipped alongside the operator:

- [`ddo-cloudflare`](https://github.com/mrkhachaturov/ddo-cloudflare)
- [`ddo-mikrotik`](https://github.com/mrkhachaturov/ddo-mikrotik)
- [`ddo-rfc2136`](https://github.com/mrkhachaturov/ddo-rfc2136)

## Reporting a vulnerability

**Please do not open public GitHub issues for security problems.**

Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/mrkhachaturov/docker-dns-operator/security/advisories/new).

If GitHub's reporting flow isn't available to you, email
`mr.kha4a2rov@protonmail.com` with a clear subject line such as
`[SECURITY] docker-dns-operator: <short summary>`.

Please include:

- A description of the issue and the impact you've observed.
- Steps to reproduce — minimal config, label payload, or compose snippet
  is ideal.
- Affected version(s) of the operator and any sidecar.
- Any proposed fix or mitigation if you have one in mind.

You should expect an initial response within **5 business days**. Most
non-trivial fixes ship in the next patch release; coordinated disclosure
timing can be agreed case-by-case.

## Scope

In scope:

- The operator (`docker-dns-operator`) and any of the three sidecars in
  this organisation.
- The webhook v1 wire contract between operator and sidecar, where the
  vulnerability is in our implementation rather than in the upstream
  [external-dns webhook provider v1](https://github.com/kubernetes-sigs/external-dns)
  spec.
- The published container images on `ghcr.io/mrkhachaturov/*`.

Out of scope:

- Vulnerabilities in upstream dependencies — please report those to the
  respective project. Dependabot watches `npm`, `docker`, `github-actions`
  and `gitsubmodule` ecosystems in every repo of this stack and will open
  PRs automatically.
- Misconfiguration in user-supplied DNS provider credentials, RouterOS
  firewall rules, Kerberos keytabs, etc.
- Denial-of-service from operator running with `EXECUTION_FREQUENCY_SECONDS`
  set absurdly low — that's a knob, not a vulnerability.
