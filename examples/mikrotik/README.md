# Example: MikroTik (via the `ddo-mikrotik` sidecar)

Minimal end-to-end example: the operator watches a busybox container that
declares one A-record label, and the [`ddo-mikrotik`](https://github.com/mrkhachaturov/ddo-mikrotik)
sidecar creates that row in MikroTik `/ip/dns/static` via the native RouterOS
binary API.

The operator side now needs only one variable: `WEBHOOK_MIKROTIK_URL`. All
RouterOS-specific configuration lives on the sidecar's service block.

## Run

```bash
cp .env.example .env
$EDITOR .env                  # fill in MIKROTIK_*, TEST_RECORD_NAME, TEST_RECORD_VALUE
docker compose up --build
```

Wait one reconcile cycle (~30s), then verify against the router itself:

```bash
dig @<router-ip> "${TEST_RECORD_NAME}"
```

(MikroTik must have `/ip dns set allow-remote-requests=yes` for `dig` from
another host to work; otherwise check the entry directly via WinBox →
IP → DNS → Static.)

## Cleanup

```bash
docker compose down
```

## Set up a dedicated RouterOS user

**Do not give the operator the `admin` user, and do not use one of the
default `read` / `write` / `full` groups.** The default groups also allow
telnet/ssh/winbox/web logins — extra attack surface a service account
doesn't need.

The sidecar speaks the **native binary API** on port 8728 (cleartext) or
8729 (api-ssl). The required policies are `read`, `write`, and `api` —
**not** `rest-api`, which is for the HTTPS REST endpoint the sidecar does
not use.

Create a custom group with the **minimum** three policies, then a user
inside it:

### Via WinBox / WebFig

1. **System → Users → Groups → New**
   - Name: `external-dns`
   - Policies (check exactly these three, nothing else):
     - read   — required; `write` alone cannot read config
     - write  — create/update/delete DNS static records
     - api    — access the native binary API on port 8728/8729
   - Leave `local`, `telnet`, `ssh`, `ftp`, `winbox`, `web`, `rest-api`,
     `policy`, `test`, `sniff`, `sensitive`, `password`, `romon`, `reboot`
     unchecked. → OK

2. **System → Users → Users → New**
   - Name: `external-dns`
   - Group: `external-dns`
   - Password: strong, random — store it in your secret manager
   - Allowed Address (optional but recommended): the IP/CIDR your sidecar
     container will connect from → OK

3. **Confirm the API service is enabled.** `IP → Services` → make sure
   `api` (TCP 8728) is enabled. If you set `MIKROTIK_USE_TLS=true`, enable
   `api-ssl` (TCP 8729) instead.

### Via CLI

```routeros
/user group add name=external-dns policy=read,write,api
/user add name=external-dns group=external-dns password=<strong-password>
/ip service enable api
```

### Why these three policies and nothing else

From the official [RouterOS User docs](https://help.mikrotik.com/docs/spaces/ROS/pages/40992788/User):

> `write` — policy that grants write access to the router's configuration,
> except for user management. **This policy does not allow to read the
> configuration, so make sure to enable read policy as well.**

> `api` — grants rights to access the router via the legacy binary API on
> ports 8728/8729.

`rest-api` is a **different** policy for the HTTPS REST endpoint; the
sidecar uses the native binary API exclusively, so leave `rest-api` off.
`web` is for the WebFig GUI, not for the API.

### Caveat — no subtree scoping

RouterOS policies are not scoped to subtrees. `read`+`write` grants
read/write across the **entire** RouterOS config, not just `/ip/dns/static`.
There is no `dns`-only policy. Mitigations:

- The sidecar code only touches `/ip/dns/static`, so the blast radius is
  bounded by container behaviour, not by what the user theoretically could do.
- The sidecar only modifies rows whose `comment` matches the payload's
  `labels.owner` (`docker-dns-operator:<INSTANCE_ID>`). Existing static
  entries with empty or different comments are never touched.
- Restrict the user's login source via the **Allowed Address** field
  (Step 2 above) so the credentials are useless even if exfiltrated to
  another host.
- Keep the password in 1Password / Vault, never plaintext.

## Notes

- **Zones.** MikroTik is not zone-aware natively. Set `MIKROTIK_ZONES` on
  the sidecar to control which FQDNs the external-dns DomainFilter
  advertises and which inbound writes the sidecar accepts. Leave empty to
  accept any name.
- **TLS.** RouterOS ships a self-signed cert. `MIKROTIK_USE_TLS=true` +
  `MIKROTIK_SKIP_TLS_VERIFY=true` accepts it; flip `SKIP_TLS_VERIFY` to
  `false` only if you've imported a publicly-trusted cert.
