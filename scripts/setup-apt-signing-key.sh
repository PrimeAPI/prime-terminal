#!/usr/bin/env bash
# One-time setup: creates the key that signs the APT repository and stores it as the
# GitHub secret APT_SIGNING_KEY. A backup of the private key is written to
# ~/prime-terminal-apt-signing-key.asc – keep it safe (password manager) and do not share it.
set -euo pipefail

repo=${1:-PrimeAPI/prime-terminal}
backup="$HOME/prime-terminal-apt-signing-key.asc"
if [ -e "$backup" ]; then
  echo "$backup already exists – not creating a new key." >&2
  exit 1
fi

GNUPGHOME=$(mktemp -d)
export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT

gpg --batch --quiet --passphrase '' --quick-gen-key "Prime Terminal Releases <primeapi@primeapi.de>" rsa4096 sign never
(umask 077; gpg --batch --armor --export-secret-keys > "$backup")
gh secret set APT_SIGNING_KEY --repo "$repo" < "$backup"

echo "Key fingerprint: $(gpg --batch --list-keys --with-colons | awk -F: '/^fpr/ { print $10; exit }')"
echo "Secret APT_SIGNING_KEY set for $repo. Backup: $backup"
