# Testing

`scripts/smoke-test.sh` verifies the running stack from the outside, the way
a user and an API client would see it.

```bash
scripts/smoke-test.sh [basic-auth-password]   # default: ontoforge
```

It reads the user, token and hosts from `.env` and prints one PASS or FAIL
line per check. The exit code is non-zero if any check fails.

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
| Gateway | any request with an unknown `Host` header | 404 |
| Host | ports 8000, 3000 and 5432 | not reachable |

## When to run it

- After `docker compose up` to confirm the stack works.
- After every change to `caddy/Caddyfile` or `.env`.
- Against a cluster: run the same requests by hand with curl against the
  public `https://` hosts. The unknown-Host check then tells you whether the
  Ingress passes the `Host` header through.

## Checking by hand

```bash
# Frontend facade: expect 401, then 200
curl -o /dev/null -w '%{http_code}\n' http://ontoforge.localhost/
curl -o /dev/null -w '%{http_code}\n' -u admin:ontoforge http://ontoforge.localhost/api/ontologies

# API facade: expect 401, then 200
curl -o /dev/null -w '%{http_code}\n' http://api.ontoforge.localhost/api/ontologies
curl -o /dev/null -w '%{http_code}\n' \
     -H 'Authorization: Bearer local-testing-token-replace-me' http://api.ontoforge.localhost/api/ontologies

# Unknown hostname: expect 404
curl -o /dev/null -w '%{http_code}\n' -H 'Host: unknown.example' http://127.0.0.1/
```

`*.localhost` names resolve to the loopback address on macOS, on Linux with
systemd-resolved, and in browsers; on other systems add
`--resolve api.ontoforge.localhost:80:127.0.0.1` (the smoke test always
does).
