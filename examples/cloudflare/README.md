# Example: Cloudflare

Minimal end-to-end example: the operator and the [ddo-cloudflare](https://github.com/mrkhachaturov/ddo-cloudflare) sidecar
together watch a busybox container that declares one A-record label, and
create that record in Cloudflare.

## Run

```bash
cp .env.example .env
$EDITOR .env                  # fill in CF_API_TOKEN, TEST_RECORD_NAME, TEST_RECORD_VALUE
docker compose up --build
```

Wait one reconcile cycle (~30s), then verify:

```bash
dig @1.1.1.1 "${TEST_RECORD_NAME}"
```

Should return `TEST_RECORD_VALUE`.

## Cleanup

```bash
docker compose down
```

The record is removed automatically because the busybox container is gone.

## How it works

The busybox container carries a label:

```
docker-dns-operator:cloudflare-example=[{"type":"A","name":"...","address":"...","providers":["cf"]}]
```

The operator container reads container labels via `/var/run/docker.sock`, sees
the entry targeted at `cf`, and forwards the desired state to the ddo-cloudflare
sidecar over HTTP. The sidecar holds the API token and talks to Cloudflare.

Every managed record is tagged with the comment
`docker-dns-operator:cloudflare-example` so the operator only ever modifies
records it created — your existing Cloudflare records are never touched.
