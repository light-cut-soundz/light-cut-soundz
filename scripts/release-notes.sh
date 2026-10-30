#!/usr/bin/env bash
# Release notes of one version, from both changelogs, in the form the app reads
# in the updater's `notes`: one block per language, introduced by a marker.
#
#   scripts/release-notes.sh 1.2.0 [changelog-dir]
#
# Fails if either changelog has no entry for the version, so a release cannot go
# out without its notes in both languages.
set -euo pipefail

VERSION=${1:?usage: release-notes.sh <version> [changelog-dir]}
VERSION=${VERSION#v}
DIR=${2:-$(dirname "$0")/..}

# The lines of the `## [VERSION]` entry, without its heading.
entry() {
  awk -v want="$VERSION" '
    /^## \[/ {
      if (inside) exit
      inside = index($0, "[" want "]") == 4
      next
    }
    inside { print }
  ' "$1"
}

for lang in en fr; do
  file="$DIR/CHANGELOG.md"
  [ "$lang" = fr ] && file="$DIR/CHANGELOG.fr.md"
  body=$(entry "$file")
  if [ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ]; then
    echo "error: no entry for $VERSION in $(basename "$file")" >&2
    exit 1
  fi
  printf '<!-- %s -->\n%s\n\n' "$lang" "$body"
done
