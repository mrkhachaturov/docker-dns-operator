# Example: RFC2136 / Active Directory

End-to-end example: operator + the ddo-rfc2136 sidecar + a busybox container
whose label creates an A-record in your AD DNS zone via GSS-TSIG.

## Prerequisites

- An AD service account with **DNS-write permission** on the zone you'll
  write to. Grant it via DNS Manager → Zone → Security, or via PowerShell.
- Network access from your dev host to the DCs on Kerberos (UDP/TCP 88) and
  DNS (UDP/TCP 53).
- One of:
  - The service-account password (for password mode), **or**
  - A keytab generated on the DC via
    [`scripts/New-ADKeytab.ps1`](../../sidecars/ddo-rfc2136/scripts/New-ADKeytab.ps1)
    in the sidecar repo (for keytab mode).

## Run

```bash
cp .env.example .env
$EDITOR .env                       # fill in RFC2136_*, one auth secret, TEST_RECORD_*

cp krb5.conf.example krb5.conf
$EDITOR krb5.conf                  # replace CORP.EXAMPLE.COM and dc01/02 with yours

docker compose up --build
```

Expected log lines:

- `ddo-rfc2136 | kerberos ready`
- `ddo-rfc2136 | listening on :9090`
- `docker-dns-operator | [rfc2136] initialised — hosts=dc01,dc02 zones=corp.example.com`

After one reconcile cycle (~30s), verify:

```bash
dig @<your-dc> "${TEST_RECORD_NAME}"
```

## Authentication modes

The sidecar supports four mutually-exclusive secret sources. Pick **one** and
leave the others unset:

| Variable | When to use |
|----------|-------------|
| `RFC2136_AD_PASSWORD` | Simplest. Password as env string. |
| `RFC2136_AD_PASSWORD_FILE` | Same, but read from a file (Docker secret pattern). |
| `RFC2136_KEYTAB_BASE64` | Keytab as base64 string. Use for secret stores that can't attach files (1Password Connect via Terraform, etc.). |
| `RFC2136_KEYTAB_FILE` | Keytab mounted at a path (Docker secret / volume). |

Setting more than one is rejected at sidecar startup so misconfiguration
fails fast.

## Pitfalls worth knowing

- **`RFC2136_HOSTS` must be FQDNs, not IPs.** The host you contact becomes
  the SPN target for GSS-TSIG. An IP gives `KDC_ERR_S_PRINCIPAL_UNKNOWN` on
  every cycle.
- **The keytab is bound to the password current at generation time.** If
  the SA password changes in AD, the kvno increments and the keytab stops
  working. Same applies to `RFC2136_AD_PASSWORD` — bump the secret when the
  password rotates.
- **The service account should be set "password never expires"** unless
  you've wired up a rotation pipeline that also updates the operator's
  secret.
- **AXFR-disabled environments.** If AD denies zone transfers to your SA,
  set `RFC2136_AXFR_ENABLED=false` on the operator — writes still work via
  UPDATE prerequisites; only drift detection is degraded.

## Cleanup

```bash
docker compose down
```

The A-record is removed automatically because the busybox container is gone
and the operator does a delete-orphan pass on shutdown's-next reconcile.
