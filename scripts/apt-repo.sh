#!/usr/bin/env bash
# Turns a directory with the .deb into a signed flat APT repository (Packages, Release, InRelease).
# The files are attached to each GitHub release, so this works as a repository:
#   deb [signed-by=/usr/share/keyrings/prime-terminal.gpg] https://github.com/PrimeAPI/prime-terminal/releases/latest/download ./
#
# usage: APT_SIGNING_KEY="$(cat private-key.asc)" scripts/apt-repo.sh <dir>
set -euo pipefail

dir=${1:?usage: apt-repo.sh <dir with .deb>}
: "${APT_SIGNING_KEY:?APT_SIGNING_KEY (armored private key) is not set}"
cd "$dir"

export GNUPGHOME
GNUPGHOME=$(mktemp -d)
trap 'rm -rf "$GNUPGHOME"' EXIT
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import
key=$(gpg --batch --list-secret-keys --with-colons | awk -F: '/^fpr/ { print $10; exit }')

# file names relative to the repository URL (no "./" prefix)
rm -f Packages Packages.gz Release InRelease Release.gpg
apt-ftparchive packages . | sed 's#^Filename: \./#Filename: #' > Packages
gzip -9 -k -f Packages

apt-ftparchive \
  -o APT::FTPArchive::Release::Origin="Prime Terminal" \
  -o APT::FTPArchive::Release::Label="Prime Terminal" \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 \
  -o APT::FTPArchive::Release::Description="Prime Terminal packages" \
  release . > "$GNUPGHOME/Release"   # written outside, so it does not list itself
mv "$GNUPGHOME/Release" Release

gpg --batch --yes --local-user "$key" --clearsign --output InRelease Release
gpg --batch --yes --local-user "$key" --armor --detach-sign --output Release.gpg Release
gpg --batch --yes --export "$key" > prime-terminal.gpg

echo "APT repository files written to $dir: Packages Packages.gz Release InRelease Release.gpg prime-terminal.gpg"
