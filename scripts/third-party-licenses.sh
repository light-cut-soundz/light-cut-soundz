#!/usr/bin/env bash
# Regenerates THIRD_PARTY_LICENSES.html: the licence of every Rust crate that
# ends up in the app. Run it after changing Cargo.lock; CI fails if the committed
# file is stale.
#
# Needs cargo-about (`cargo install cargo-about --locked --features cli`).
set -euo pipefail

OUT=${1:-THIRD_PARTY_LICENSES.html}
cd "$(dirname "$0")/.."
cargo about generate --locked --workspace -c about.toml about.hbs -o "$OUT"
# Licence texts carry CRLF line ends; keep the file LF so a checkout compares equal.
tr -d '\r' < "$OUT" > "$OUT.lf" && mv "$OUT.lf" "$OUT"
echo "wrote $OUT ($(wc -c <"$OUT") bytes)"
