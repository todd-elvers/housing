#!/usr/bin/env bash
#
# Generate your personal age identity (private key) at ~/.age/key.txt and print
# the public key to add to .age.public-keys. Run once per machine.
#
set -euo pipefail

if ! command -v age-keygen &>/dev/null; then
  echo "age-keygen not found. Install age (mise install, or 'brew install age')." >&2
  exit 1
fi

IDENTITY="${HOME}/.age/key.txt"

if [ -f "$IDENTITY" ]; then
  echo "Age identity already exists at $IDENTITY"
  echo "Public key: $(age-keygen -y "$IDENTITY")"
  echo "Make sure that public key is in .age.public-keys (ask a maintainer to add it + re-encrypt)."
  exit 0
fi

mkdir -p "$(dirname "$IDENTITY")"
chmod 700 "$(dirname "$IDENTITY")"
age-keygen -o "$IDENTITY"
chmod 600 "$IDENTITY"

echo ""
echo "Key saved to $IDENTITY (keep it secret — never commit it)."
echo "Public key: $(age-keygen -y "$IDENTITY")"
echo "Send that public key to a maintainer to add to .age.public-keys, then have them run 'mise run secrets:edit'."
