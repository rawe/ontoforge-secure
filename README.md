# OntoForge Auth Gateway

[OntoForge](https://github.com/rawe/ontoforge) has no authentication of its
own. This project shows the simplest way to add it without changing OntoForge:
a [Caddy](https://caddyserver.com) reverse proxy in front of the unchanged
OntoForge images. Users log in with HTTP Basic Auth in the browser, API and
MCP clients send a Bearer token, and OntoForge itself is never reachable
directly.

It is a proof of concept. It runs locally with Docker Compose and documents
how the same setup is deployed to Kubernetes.

```text
Internet
  │
  ├─ https://ontoforge.example.com       HTTP Basic Auth (browser login dialog)
  │     /        ─► OntoForge UI
  │     /api/*   ─► OntoForge server
  │
  └─ https://api.ontoforge.example.com   Bearer token (API and MCP clients)
        /*       ─► OntoForge server
```

## Repository layout

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Caddy, OntoForge server, OntoForge UI, PostgreSQL |
| `caddy/Caddyfile` | The gateway configuration, shared by compose and Kubernetes |
| `.env.example` | Stack configuration template (hosts, TLS, credentials, version) |
| `env/` | OntoForge feature settings (embeddings, AI) |
| `scripts/` | Password hash, token generator, smoke test |
| `mcp.example.json` | MCP client configuration for Claude Code, pointing at the API facade |
| `k8s/` | Kubernetes reference manifests |
| `docs/` | Documentation, see below |

## Getting started

Prerequisites: Docker with Compose v2.24 or newer, ports 80 and 443 free.

```bash
cp .env.example .env
docker compose up -d
```

That is a working stack with local testing credentials:

| | URL | Credentials |
|---|---|---|
| UI | https://ontoforge.localhost | user `admin`, password `ontoforge` |
| API | https://api.ontoforge.localhost | header `Authorization: Bearer local-testing-token-replace-me` |

The browser warns about the certificate once (Caddy signs it with its own
local CA) and then shows the login dialog.

Optional: to enable semantic search and AI features, place your provider
settings in `env/ontoforge.local.env`. See
[docs/configuration.md](docs/configuration.md).

Run `scripts/smoke-test.sh` for a quick check that both facades work
([docs/testing.md](docs/testing.md)).

## Using it with an MCP client

`mcp.example.json` configures Claude Code with OntoForge's two MCP servers
through the API facade. The token is read from the environment, so the file
holds no secret. Claude Code runs on Node, which must trust Caddy's local CA
for the local hosts, hence the second variable.

```bash
mkdir -p .certs && docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .certs/caddy-root.crt
export ONTOFORGE_API_TOKEN=local-testing-token-replace-me
export NODE_EXTRA_CA_CERTS="$PWD/.certs/caddy-root.crt"
claude --mcp-config mcp.example.json
```

Then ask Claude to call `ensure_ontology` on the modeling server; that creates
the `poc` ontology the file points at. The runtime server additionally needs
a lens named `all` in that ontology. Ontology, lens and host are overridable
with `ONTOFORGE_ONTOLOGY`, `ONTOFORGE_LENS` and `ONTOFORGE_API_URL`; against
a real deployment drop the CA variable and set the URL to the public API
host.

## Documentation

- [docs/gateway.md](docs/gateway.md): read to understand or change the Caddyfile, route by route.
- [docs/configuration.md](docs/configuration.md): read to change hosts, credentials, versions or OntoForge features.
- [docs/testing.md](docs/testing.md): read to verify the gateway, locally or by hand against a cluster.
- [docs/kubernetes.md](docs/kubernetes.md): read to deploy the same setup in a cluster.
