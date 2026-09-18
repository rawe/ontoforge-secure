# Kubernetes

`k8s/` holds reference manifests that reproduce the compose setup. They build
with kustomize and validate against the Kubernetes 1.31 schemas; apply them
to a real cluster as a starting point, not as a finished deployment.

## The rule that makes it secure

Caddy is the only Service that may be reachable from outside. OntoForge
server, OntoForge UI and PostgreSQL are `ClusterIP` only. Do not add an
Ingress, NodePort or LoadBalancer for any of them; that would bypass the
gateway. The NetworkPolicies in `k8s/networkpolicy.yaml` enforce this inside
the cluster as well (they need a CNI that supports NetworkPolicy).

## What maps to what

| Compose | Kubernetes | Notes |
|---|---|---|
| `caddy` service, ports 80/443 | `Deployment caddy`, `Service caddy` (LoadBalancer) | one replica, see TLS below |
| `caddy/Caddyfile` bind mount | `ConfigMap caddy-config`, generated from the same file | one source of truth |
| gateway values in `.env` | `env:` on the Caddy container (`FRONTEND_HOST`, `API_HOST`, `CADDY_TLS_MODE`, `ACME_EMAIL`) | |
| gateway credentials in `.env` | `Secret caddy-auth` (`BASIC_AUTH_USER`, `BASIC_AUTH_HASH`, `ONTOFORGE_API_TOKEN`) | raw hash, no `$$` escaping |
| `caddy-data` volume | `PersistentVolumeClaim caddy-data` at `/data` | certificates, ACME account |
| `env/ontoforge.env` + `env/ontoforge.local.env` | `Secret ontoforge-server-env`, loaded with `envFrom` | see below |
| `POSTGRES_PASSWORD` in `.env` | `Secret ontoforge-db` | used by PostgreSQL and the server |
| `ontoforge-server` | `Deployment` + `Service` ClusterIP :8000 | `DB_*` and `PUBLIC_URL` set in the manifest |
| `ontoforge-ui` | `Deployment` + `Service` ClusterIP :80 | `BACKEND_URL=http://ontoforge-server:8000` |
| `postgres` | `StatefulSet` + headless Service | a managed PostgreSQL with pgvector is preferable; then drop `postgres.yaml` and change `DB_URI` |
| `internal: true` network | three `NetworkPolicy` objects | |
| healthcheck on `:8080/healthz` | readiness and liveness probes | port stays out of the Service |

## Secrets

Create them before applying; nothing in `k8s/` contains a secret.
`k8s/secrets.example.yaml` shows the expected shape.

```bash
kubectl create namespace ontoforge

# Gateway credentials
kubectl -n ontoforge create secret generic caddy-auth \
  --from-literal=BASIC_AUTH_USER=admin \
  --from-literal=BASIC_AUTH_HASH="$(scripts/hash-password.sh --raw)" \
  --from-literal=ONTOFORGE_API_TOKEN="$(scripts/gen-token.sh --raw)"

# Database password
kubectl -n ontoforge create secret generic ontoforge-db \
  --from-literal=POSTGRES_PASSWORD='...'

# OntoForge feature settings: the same env files as in compose.
# Later files win, exactly like compose. Commented lines are ignored.
kubectl -n ontoforge create secret generic ontoforge-server-env \
  --from-env-file=env/ontoforge.env \
  --from-env-file=env/ontoforge.local.env
```

The last command is where the embedding and AI provider configuration enters
the cluster.

## Apply

```bash
kubectl kustomize --load-restrictor LoadRestrictionsNone k8s/ | kubectl apply -f -
```

The flag lets kustomize read `caddy/Caddyfile` from outside the `k8s/`
directory. Before applying, set the two hostnames and `ACME_EMAIL` in
`k8s/caddy.yaml`, and `PUBLIC_URL` in `k8s/ontoforge-server.yaml` to the API
host.

## TLS

The reference uses `CADDY_TLS_MODE=acme`: Caddy obtains public certificates
itself. That needs DNS for both hosts pointing at the LoadBalancer and ports
80 and 443 open to the internet for the ACME challenge. Certificates live on
the `caddy-data` volume, which is `ReadWriteOnce`, so Caddy runs as one
replica.

If an Ingress controller already terminates TLS:

1. `CADDY_TLS_MODE=off`, `FRONTEND_HOST=http://ontoforge.example.com`,
   `API_HOST=http://api.ontoforge.example.com`.
2. Change `Service caddy` to `ClusterIP`.
3. Add an Ingress that routes both hosts to `caddy:80`.

Caddy is stateless in that mode and can run with several replicas.

## Day-to-day

| Task | Steps |
|---|---|
| New Basic Auth password | `scripts/hash-password.sh --raw`, update `caddy-auth`, restart the Caddy pod |
| New API token | `scripts/gen-token.sh --raw`, update `caddy-auth`, restart the Caddy pod, inform clients |
| Change provider settings | edit the env files, recreate `ontoforge-server-env`, restart the server pod |
| Upgrade OntoForge | bump both image tags together |
| Upgrade Caddy | any newer `caddy:2.x`; the Caddyfile uses core directives only |
