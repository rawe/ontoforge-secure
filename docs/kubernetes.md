# Kubernetes

`k8s/` holds reference manifests that reproduce the compose setup. They build
with kustomize and validate against the Kubernetes 1.31 schemas; apply them
to a real cluster as a starting point, not as a finished deployment.

## The two rules that make it secure

1. **Only the Ingress is public, and it routes only to Caddy.** OntoForge
   server, OntoForge UI and PostgreSQL are `ClusterIP` only. No second
   Ingress, NodePort or LoadBalancer for any of them; that would bypass the
   gateway. The NetworkPolicies in `k8s/networkpolicy.yaml` enforce this
   inside the cluster as well (they need a CNI that supports NetworkPolicy).
2. **The Ingress must pass the original `Host` header to Caddy.** Caddy
   picks the facade by hostname and answers 404 for anything else. All
   common controllers do this by default.

## TLS

Caddy does not terminate TLS. The Ingress does, with whatever the cluster
already uses (cert-manager, a wildcard certificate Secret, a cloud load
balancer). `k8s/ingress.yaml` shows the shape with a cert-manager
annotation; replace it with your mechanism. The HTTP-to-HTTPS redirect also
belongs to the Ingress. Caddy itself is stateless: no volume, two replicas
by default.

## What maps to what

| Compose | Kubernetes | Notes |
|---|---|---|
| nothing (no TLS locally) | `Ingress ontoforge` | TLS, both hostnames to `caddy:80` |
| `caddy` service, port 80 | `Deployment caddy`, `Service caddy` (ClusterIP) | stateless, 2 replicas |
| `caddy/Caddyfile` bind mount | `ConfigMap caddy-config`, generated from the same file | one source of truth |
| hosts in `.env` | `env:` on the Caddy container (`FRONTEND_HOST`, `API_HOST`) | bare hostnames |
| gateway credentials in `.env` | `Secret caddy-auth` (`BASIC_AUTH_USER`, `BASIC_AUTH_HASH`, `ONTOFORGE_API_TOKEN`) | raw hash, no `$$` escaping |
| `env/ontoforge.env` + `env/ontoforge.local.env` | `Secret ontoforge-server-env`, loaded with `envFrom` | see below |
| `POSTGRES_PASSWORD` in `.env` | `Secret ontoforge-db` | used by PostgreSQL and the server |
| `ontoforge-server` | `Deployment` + `Service` ClusterIP :8000 | `DB_*` and `PUBLIC_URL` set in the manifest |
| `ontoforge-ui` | `Deployment` + `Service` ClusterIP :80 | `BACKEND_URL=http://ontoforge-server:8000` |
| `postgres` | `StatefulSet` + headless Service | a managed PostgreSQL with pgvector is preferable; then drop `postgres.yaml` and change `DB_URI` |
| `internal: true` network | three `NetworkPolicy` objects | |
| healthcheck on `:8080/healthz` | readiness and liveness probes | port stays out of the Service |

## Before applying

| Where | What |
|---|---|
| `k8s/ingress.yaml` | `ingressClassName`, TLS mechanism, both hostnames |
| `k8s/caddy.yaml` | `FRONTEND_HOST`, `API_HOST` (same hostnames, no scheme) |
| `k8s/ontoforge-server.yaml` | `PUBLIC_URL` = `https://` plus the API hostname |
| Secrets | see next section |

## Secrets

Nothing in `k8s/` contains a secret. `k8s/secrets.example.yaml` shows the
expected shape.

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
directory.

## Day-to-day

| Task | Steps |
|---|---|
| New Basic Auth password | `scripts/hash-password.sh --raw`, update `caddy-auth`, restart the Caddy pods |
| New API token | `scripts/gen-token.sh --raw`, update `caddy-auth`, restart the Caddy pods, inform clients |
| Change provider settings | edit the env files, recreate `ontoforge-server-env`, restart the server pod |
| Upgrade OntoForge | bump both image tags together |
| Upgrade Caddy | any newer `caddy:2.x`; the Caddyfile uses core directives only |
