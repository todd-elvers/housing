#!/usr/bin/env bash
#
# Remove ONE secret from .env.age entirely in memory — no plaintext hits disk.
# Decrypts into a shell variable, drops the KEY line, re-encrypts via a pipe.
#
# Usage: scripts/unset-secret.sh KEY        (or: mise run secrets:unset -- KEY)
#
set -euo pipefail

IDENTITY="${HOME}/.age/key.txt"
PUBLIC_KEYS=".age.public-keys"
KEY="${1:-}"

[ -n "$KEY" ] || {
  echo "Usage: $0 KEY" >&2
  exit 1
}
[ -f "$PUBLIC_KEYS" ] || {
  echo "ERROR: $PUBLIC_KEYS not found (run from repo root)" >&2
  exit 1
}
[ -f "$IDENTITY" ] || {
  echo "ERROR: no age identity at $IDENTITY — run 'mise run secrets:keygen'" >&2
  exit 1
}
[ -f .env.age ] || {
  echo "ERROR: .env.age not found (nothing to remove)" >&2
  exit 1
}

existing="$(age --decrypt -i "$IDENTITY" .env.age)"
if ! printf '%s\n' "$existing" | grep -qE "^${KEY}="; then
  echo "$KEY not present in .env.age — nothing to do." >&2
  exit 0
fi

# Everything left after dropping the KEY line (may be empty if it was the last key).
remaining="$(printf '%s\n' "$existing" | grep -vE "^${KEY}=" | grep -vE '^[[:space:]]*$' || true)"
printf '%s\n' "$remaining" | age --encrypt -R "$PUBLIC_KEYS" -o .env.age -

echo "Removed $KEY from .env.age. Commit .env.age." >&2
