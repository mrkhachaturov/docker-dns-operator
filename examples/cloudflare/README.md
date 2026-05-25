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

## Swarm mode

The same setup works on a Docker Swarm manager — labels live under
`deploy.labels:` (service spec) and the operator auto-detects swarm via
`docker info`. Swarm doesn't build images, so build them first.

```bash
docker swarm init                                   # if not already a swarm node
cp .env.example .env
$EDITOR .env
docker compose -f docker-compose.yml build          # produces both :dev images locally
set -a; source .env; set +a                         # `docker stack deploy` doesn't read .env
docker stack deploy -c docker-stack.yml ddo-cf
```

Tear down:

```bash
docker stack rm ddo-cf
```

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
