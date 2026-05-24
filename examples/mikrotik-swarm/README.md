# Example: MikroTik in Docker Swarm

Same outcome as [`examples/mikrotik/`](../mikrotik/), but the operator is
deployed via `docker stack deploy` and reads service-level labels instead of
container labels. Use this pattern when you want one operator instance to
manage DNS for an entire Swarm cluster.

## How it differs from the standalone example

| | Standalone (`examples/mikrotik/`) | Swarm (this folder) |
|---|---|---|
| Deploy command | `docker compose up` | `docker stack deploy -c docker-stack.yml ddo-mt` |
| Operator reads | Local containers via `listContainers` | Cluster services via `listServices` |
| Label lives on | Container — top-level `labels:` | Service spec — `deploy.labels:` |
| Detection | Falls back to container mode | Auto-detected (manager node → swarm) |
| Where it runs | Any host | Must be on a manager node (placement constraint) |

The operator switches modes automatically by calling `docker info` at
startup. No env var to set.

## Prerequisites

- A Swarm cluster (`docker swarm init` if you don't have one yet).
- The same RouterOS user setup as the standalone example — see
  [`../mikrotik/README.md`](../mikrotik/README.md) for the `external-dns`
  group + user recipe.

## Run

```bash
cp .env.example .env
$EDITOR .env                         # fill in MIKROTIK_*, TEST_RECORD_*

# docker stack deploy does NOT auto-load .env — export the vars first.
set -a; source .env; set +a
docker stack deploy -c docker-stack.yml ddo-mt
```

Watch for the auto-detect line on first reconcile:

```bash
docker service logs ddo-mt_docker-dns-operator | grep resolveSwarmMode
# DockerService, resolveSwarmMode: LocalNodeState=active ControlAvailable=true → swarm mode
```

Verify the record on the router:

```bash
curl -k -u "$MIKROTIK_USERNAME:$MIKROTIK_PASSWORD" \
  "${MIKROTIK_BASEURL}/rest/ip/dns/static" | grep "$TEST_RECORD_NAME"
```

## Cleanup

```bash
docker stack rm ddo-mt
```

Or to test the delete path while keeping the operator running, remove just
the target service:

```bash
docker service rm ddo-mt_target
```

On the next reconcile (~30s) the record is removed from the router. **Do
not** use `docker service scale ddo-mt_target=0` for cleanup tests — the
service spec (and its label) still exists at zero replicas, so the operator
considers the entry still desired.

## Why the operator lands on a manager

The compose file pins it with:

```yaml
deploy:
  placement:
    constraints:
      - node.role == manager
```

That's both a security boundary (only managers should mount the docker
socket of a swarm node) and a correctness boundary (only managers can call
`listServices`). On a worker, the operator would auto-detect "swarm-active
but not a manager" and fall back to container mode — reading only what's
local to that worker, which is rarely what you want for cluster-wide DNS.
