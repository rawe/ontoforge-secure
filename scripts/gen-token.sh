#!/usr/bin/env bash
# Generate a random static Bearer token for the API facade (32 bytes, hex).
# Prints a ready-to-paste .env line; pass --raw for the bare token.
set -euo pipefail
token=$(openssl rand -hex 32)
if [ "${1:-}" = "--raw" ]; then
  printf '%s\n' "$token"
else
  printf 'ONTOFORGE_API_TOKEN=%s\n' "$token"
fi
