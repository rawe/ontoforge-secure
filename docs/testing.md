# Testing

`scripts/smoke-test.sh` verifies the running stack from the outside, the way
a user and an API client would see it.

```bash
scripts/smoke-test.sh [basic-auth-password]   # default: ontoforge
```

It reads the user, token and hosts from `.env`, exports Caddy's local root
CA to `.certs/caddy-root.crt` so TLS is verified rather than skipped, and
prints one PASS or FAIL line per check. The exit code is non-zero if any
check fails.

## What is checked

| Facade | Request | Expected |
|---|---|---|
| Frontend | `/` and `/api/ontologies` without credentials | 401 |
| Frontend | `/` with a wrong password | 401 |
| Frontend | `/` and `/api/ontologies` with credentials | 200 |
| Frontend | `/mcp/...` with credentials | 404 |
| Frontend | `/api/ontologies` with the Bearer token | 401 |
| API | `/api/ontologies` without token, wrong token, or Basic Auth | 401 |
| API | `/api/ontologies` and `/docs` with the token | 200 |
| Host | ports 8000, 3000 and 5432 | not reachable |

## When to run it

- After `docker compose up` to confirm the stack works.
- After every change to `caddy/Caddyfile` or `.env`.
- Against a cluster: set `FRONTEND_HOST` and `API_HOST` in `.env` to the
  public hosts and remove the `--resolve` and `--cacert` options from the
  script, or run the same requests by hand with curl.

## Checking by hand

```bash
# Frontend facade: expect 401, then 200
curl -k --resolve ontoforge.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://ontoforge.localhost/
curl -k --resolve ontoforge.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' -u admin:ontoforge https://ontoforge.localhost/api/ontologies

# API facade: expect 401, then 200
curl -k --resolve api.ontoforge.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://api.ontoforge.localhost/api/ontologies
curl -k --resolve api.ontoforge.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' \
     -H 'Authorization: Bearer local-testing-token-replace-me' https://api.ontoforge.localhost/api/ontologies
```

`--resolve` is needed because `curl` does not map `*.localhost` to
`127.0.0.1` the way browsers do. `-k` skips certificate verification for the
local CA; use `--cacert .certs/caddy-root.crt` instead once the smoke test
has exported it.
