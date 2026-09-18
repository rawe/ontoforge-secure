# The gateway

`caddy/Caddyfile` is the whole gateway. It defines two public sites and one
internal health listener. Every `{$NAME}` in the file is an environment
variable, so the same file serves compose and Kubernetes.

## Frontend facade

Site address: `FRONTEND_HOST` (default `https://ontoforge.example.com`).

| Step | Directive | Effect |
|---|---|---|
| 1 | `basic_auth` | Every request needs valid HTTP Basic credentials. The browser asks once, then attaches them to every request to this host. The password exists only as a bcrypt hash (`BASIC_AUTH_HASH`). |
| 2 | `handle /mcp/*` | Answers 404. MCP is not published on this host. |
| 3 | `handle /api/*` | Proxies to the OntoForge server (`SERVER_UPSTREAM`). |
| 4 | `handle` | Everything else goes to the OntoForge UI (`UI_UPSTREAM`). |

Because the SPA calls its backend with relative URLs (`/api/...`), those calls
carry the browser's Basic Auth credentials automatically. The SPA has no
login logic, no session and no token.

Two headers are adjusted on the way through:

- `Authorization` is removed before proxying. The OntoForge services do not
  use it.
- `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials` are
  removed from `/api/*` responses. The UI is same-origin behind the gateway
  and needs no CORS; the server would otherwise reflect any origin.

Why `/mcp/*` is refused here explicitly: the UI image's nginx forwards
`/mcp/` to the server itself. Without step 2 the catch-all in step 4 would
publish MCP under Basic Auth.

## API facade

Site address: `API_HOST` (default `https://api.ontoforge.example.com`).

| Step | Directive | Effect |
|---|---|---|
| 1 | `@authorized header Authorization "Bearer {$ONTOFORGE_API_TOKEN}"` | Matches only the exact expected header. |
| 2 | `handle @authorized` | Proxies the whole request to the OntoForge server, `Authorization` removed. |
| 3 | `handle` | Everything else: `401` with `WWW-Authenticate: Bearer`. Nothing is proxied. |

The complete server surface is available here: REST under `/api`, the
OpenAPI UI under `/docs`, MCP under `/mcp`. This is the only place MCP is
published; an MCP client connects to
`https://api.ontoforge.example.com/mcp/ontologies/<ontology>/model` with the
same `Authorization: Bearer` header. CORS headers are left as the server sends them, so a browser-based
client with its own token can use this host.

## Health listener

`:8080` answers `/healthz` with 200 and needs no credentials. Compose's
healthcheck and the Kubernetes probes use it. The port is never published.

## TLS

The `tls_*` snippets at the top of the file are selected by `CADDY_TLS_MODE`:

| Mode | Certificates | Use |
|---|---|---|
| `internal` | Caddy's own local CA | local testing |
| `acme` | Let's Encrypt via ACME | Caddy is the public entry point |
| `off` | none, plain HTTP | an Ingress or load balancer in front of Caddy terminates TLS |

In `off` mode the site addresses must use `http://`. Port 80 redirects to
HTTPS in the other two modes.

## Environment variables read by the Caddyfile

| Variable | Default | Meaning |
|---|---|---|
| `FRONTEND_HOST` | `https://ontoforge.example.com` | Site address of the frontend facade, scheme included |
| `API_HOST` | `https://api.ontoforge.example.com` | Site address of the API facade, scheme included |
| `CADDY_TLS_MODE` | `internal` | `internal`, `acme` or `off` |
| `ACME_EMAIL` | `admin@example.com` | Contact for the ACME account (`acme` mode only) |
| `BASIC_AUTH_USER` | `admin` | Basic Auth user name |
| `BASIC_AUTH_HASH` | none, required | bcrypt hash of the Basic Auth password |
| `ONTOFORGE_API_TOKEN` | none, required | Static Bearer token |
| `SERVER_UPSTREAM` | `ontoforge-server:8000` | Where the OntoForge server is reachable |
| `UI_UPSTREAM` | `ontoforge-ui:80` | Where the OntoForge UI is reachable |

## Limits

- Basic Auth has no logout. Browsers keep the credentials until the window
  closes. A new password hash invalidates everyone.
- One static token serves all API clients. Rotating it cuts off all of them.
- No rate limiting or brute-force protection is configured. Add it in front
  of Caddy or with Caddy's rate-limit module.
- Multiple Basic Auth users are possible (one `user hash` line each in the
  Caddyfile); per-user tokens are not. For real user management the next
  step is Caddy's `forward_auth` to an identity provider, still without
  touching OntoForge.
- The Caddy admin API is off. Configuration changes need a restart.
