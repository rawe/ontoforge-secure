#!/usr/bin/env bash
# End-to-end check of the auth gateway against the running compose stack.
#
#   scripts/smoke-test.sh [basic-auth-password]   (default: ontoforge, the .env.example password)
#
# Reads BASIC_AUTH_USER, ONTOFORGE_API_TOKEN, FRONTEND_HOST and API_HOST from
# .env. Every check prints PASS/FAIL; exit code is non-zero on any FAIL.
set -uo pipefail
cd "$(dirname "$0")/.."

PASSWORD="${1:-ontoforge}"

# Read .env without sourcing it (the bcrypt hash contains `$$`).
envval() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-; }
USER="$(envval BASIC_AUTH_USER)"; USER="${USER:-admin}"
TOKEN="$(envval ONTOFORGE_API_TOKEN)"
[ -n "$TOKEN" ] || { echo "ONTOFORGE_API_TOKEN missing in .env" >&2; exit 2; }
FRONT_HOST="$(envval FRONTEND_HOST)"; FRONT_HOST="${FRONT_HOST:-ontoforge.localhost}"
API_HOST="$(envval API_HOST)"; API_HOST="${API_HOST:-api.ontoforge.localhost}"
FRONT="http://$FRONT_HOST"; API="http://$API_HOST"

# Pin both hostnames to the local gateway so the test does not depend on DNS.
CURL=(curl -sS -o /dev/null --max-time 15
      --resolve "$FRONT_HOST:80:127.0.0.1" --resolve "$API_HOST:80:127.0.0.1")

fails=0
check() { # <expected-status> <label> <curl args...>
  local want="$1" label="$2"; shift 2
  local got; got=$("${CURL[@]}" -w '%{http_code}' "$@")
  if [ "$got" = "$want" ]; then printf 'PASS  %-58s %s\n' "$label" "$got"
  else printf 'FAIL  %-58s got %s, want %s\n' "$label" "$got" "$want"; fails=$((fails+1)); fi
}

echo "== Frontend facade: $FRONT (Basic Auth as '$USER')"
check 401 "GET /               without credentials"        "$FRONT/"
check 401 "GET /api/ontologies without credentials"        "$FRONT/api/ontologies"
check 401 "GET /               wrong password"             -u "$USER:definitely-wrong" "$FRONT/"
check 200 "GET /               with credentials (SPA)"     -u "$USER:$PASSWORD" "$FRONT/"
check 200 "GET /api/ontologies with credentials (API)"     -u "$USER:$PASSWORD" "$FRONT/api/ontologies"
check 404 "GET /mcp/...        with credentials (blocked)" -u "$USER:$PASSWORD" "$FRONT/mcp/ontologies/x/model"
check 401 "GET /api/ontologies bearer token is NOT accepted here" -H "Authorization: Bearer $TOKEN" "$FRONT/api/ontologies"

echo "== API facade: $API (Bearer token)"
check 401 "GET /api/ontologies without token"              "$API/api/ontologies"
check 401 "GET /api/ontologies wrong token"                -H "Authorization: Bearer nope" "$API/api/ontologies"
check 401 "GET /api/ontologies basic auth is NOT accepted here" -u "$USER:$PASSWORD" "$API/api/ontologies"
check 200 "GET /api/ontologies with token"                 -H "Authorization: Bearer $TOKEN" "$API/api/ontologies"
check 200 "GET /docs           with token (OpenAPI UI)"    -H "Authorization: Bearer $TOKEN" "$API/docs"

echo "== Host header routing (the layer in front must pass Host through)"
check 404 "GET / with an unknown Host header"              -H "Host: unknown.example" "http://127.0.0.1/"

echo "== Isolation"
for p in 8000 3000 5432; do
  if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$p/" 2>/dev/null; then
    printf 'FAIL  %-58s\n' "port $p reachable on the host (must not be published)"; fails=$((fails+1))
  else printf 'PASS  %-58s\n' "port $p not published on the host"; fi
done

echo
if [ $fails -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; exit 1; fi
