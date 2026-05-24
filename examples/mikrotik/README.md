# Example: MikroTik

Minimal end-to-end example: the operator watches a busybox container that
declares one A-record label, and creates that record in MikroTik
`/ip/dns/static`.

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

Create a custom group with the **minimum** three policies, then a user
inside it:

### Via WinBox / WebFig

1. **System → Users → Groups → New**
   - Name: `external-dns`
   - Policies (check exactly these three, nothing else):
     - ✅ `read`   — required; `write` alone cannot read config
     - ✅ `write`  — create/update/delete DNS static records
     - ✅ `rest-api` — access the `/rest/...` HTTP(S) endpoint
   - Leave `local`, `telnet`, `ssh`, `ftp`, `winbox`, `web`, `api`,
     `policy`, `test`, `sniff`, `sensitive`, `password`, `romon`, `reboot`
     unchecked. → OK

2. **System → Users → Users → New**
   - Name: `external-dns`
   - Group: `external-dns`
   - Password: strong, random — store it in your secret manager
   - Allowed Address (optional but recommended): the IP/CIDR your operator
     container will connect from → OK

3. **Confirm the REST service is enabled.** `IP → Services` → make sure
   `www-ssl` (HTTPS, port 443) is enabled. The REST API rides on this
   service; the user-level `rest-api` policy is necessary but not
   sufficient if the service itself is off.

### Via CLI

```routeros
/user group add name=external-dns policy=read,write,rest-api
/user add name=external-dns group=external-dns password=<strong-password>
/ip service enable www-ssl
```

### Why these three policies and nothing else

From the official [RouterOS User docs](https://help.mikrotik.com/docs/spaces/ROS/pages/40992788/User):

> `write` — policy that grants write access to the router's configuration,
> except for user management. **This policy does not allow to read the
> configuration, so make sure to enable read policy as well.**

> `rest-api` — grants rights to access the router via REST API.

`api` is a **different** policy for the legacy binary API on ports
8728/8729; our operator uses HTTPS REST only, so leave `api` off. `web` is
for the WebFig GUI, not for REST.

### Caveat — no subtree scoping

RouterOS policies are not scoped to subtrees. `read`+`write` grants
read/write across the **entire** RouterOS config, not just `/ip/dns/static`.
There is no `dns`-only policy. Mitigations:

- The operator's code only touches `/rest/ip/dns/static`, so the blast
  radius is bounded by container behaviour, not by what the user
  theoretically could do.
- The operator only modifies records whose comment matches
  `docker-dns-operator:mikrotik-example`. Existing static entries are
  never touched.
- Restrict the user's login source via the **Allowed Address** field
  (Step 2 above) so the credentials are useless even if exfiltrated to
  another host.
- Keep the password in 1Password / Vault, never plaintext.

## Notes

- **No zones.** MikroTik is not zone-aware — it accepts any name. The
  operator's ownership-tag in the record `comment` is the only thing
  scoping it.
- **TLS.** RouterOS ships a self-signed cert. `MIKROTIK_SKIP_TLS_VERIFY=true`
  in `.env.example` accepts it; flip to `false` only if you've imported a
  publicly-trusted cert.
