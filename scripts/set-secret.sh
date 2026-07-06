#!/usr/bin/env bash
#
# Add or update ONE secret in .env.age entirely in memory — the plaintext value
# never touches disk (no temp file, no .env). Prompts for the value (hidden),
# merges it into the decrypted contents held in a shell variable / pipe, and
# re-encrypts for every recipient in .age.public-keys.
#
# Usage: scripts/set-secret.sh KEY        (or: mise run secrets:set -- KEY)
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

printf 'Value for %s (hidden): ' "$KEY" >&2
IFS= read -rs VALUE
echo >&2
[ -n "$VALUE" ] || {
  echo "ERROR: empty value" >&2
  exit 1
}

# Decrypt existing secrets into a variable (memory), drop any prior line for KEY,
# append the new pair, and pipe straight back into age. No plaintext file exists.
existing=""
if [ -f .env.age ]; then existing="$(age --decrypt -i "$IDENTITY" .env.age)"; fi
{
  printf '%s\n' "$existing" | grep -vE "^${KEY}=" || true
  printf '%s=%s\n' "$KEY" "$VALUE"
} | grep -vE '^[[:space:]]*$' | age --encrypt -R "$PUBLIC_KEYS" -o .env.age -

echo "Set $KEY in .env.age (encrypted for $(grep -cE '^age1' "$PUBLIC_KEYS") recipients). Commit .env.age." >&2
