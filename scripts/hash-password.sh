#!/usr/bin/env bash
# Produce the bcrypt hash for the Basic Auth password of the frontend facade.
# Prints a ready-to-paste .env line. The plaintext never touches the repo.
#
#   scripts/hash-password.sh                # prompts for the password
#   scripts/hash-password.sh 'my-password'  # non-interactive
#
# The hash is emitted with every `$` doubled (`$$`) — that is the escape form
# docker compose expects in .env. Kubernetes Secrets take the raw hash
# (single `$`); use `--raw` for that.
set -euo pipefail

raw=0
if [ "${1:-}" = "--raw" ]; then raw=1; shift; fi

if [ $# -ge 1 ]; then
  password="$1"
else
  read -r -s -p "Basic Auth password: " password; echo >&2
fi

hash=$(docker run --rm caddy:2.11 caddy hash-password --plaintext "$password")

if [ $raw -eq 1 ]; then
  printf '%s\n' "$hash"
else
  printf 'BASIC_AUTH_HASH=%s\n' "$(printf '%s' "$hash" | sed 's/\$/$$/g')"
fi
