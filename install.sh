#!/usr/bin/env bash
# LightCutSoundz — one-line installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/light-cut-soundz/light-cut-soundz/main/install.sh | bash
#
#   macOS (Apple Silicon) → Homebrew cask (light-cut-soundz/tap/light-cut-soundz)
#   Linux + apt           → .deb package
#   Linux + dnf / zypper  → .rpm package
#   Linux (other)         → .AppImage in ~/.local/bin, registered in the applications menu
#
# x86_64 and ARM64 on Linux. Every download is checked against the SHA256SUMS
# published with the release before it is installed.
#
# Re-run the same command to upgrade an existing install.
set -eo pipefail

REPO="light-cut-soundz/light-cut-soundz"
TAP="light-cut-soundz/tap"
CASK="light-cut-soundz"
APP_NAME="LightCutSoundz"
APP_SLUG="lightcutsoundz"
APP_COMMENT="Minimal audio editor"
CATEGORIES="AudioVideo;Audio;"
ICON_URL="https://raw.githubusercontent.com/$REPO/main/src-tauri/icons/icon.png"
ICON_SIZE="512x512"
RUNTIME_DEPS=""

# Everything downloaded lands here and is removed however the script ends.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# fetch <url> [output] — writes to <output>, or to stdout when omitted
fetch() {
  if command -v curl >/dev/null 2>&1; then
    if [ $# -ge 2 ]; then curl -fsSL "$1" -o "$2"; else curl -fsSL "$1"; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ $# -ge 2 ]; then wget -qO "$2" "$1"; else wget -qO- "$1"; fi
  else
    die "curl or wget is required"
  fi
}

# latest_asset <regex> — download URL of the first asset of the latest release
# whose URL ends with something matching <regex>
latest_asset() {
  fetch "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o "\"browser_download_url\": *\"[^\"]*$1\"" \
    | head -1 \
    | sed 's/.*"\(https[^"]*\)"/\1/'
}

# sha256 <file>
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "sha256sum or shasum is required to verify the download"; fi
}

# verify <file> <asset-url> — the release lists the hash of each installable file
# in SHA256SUMS, next to the files themselves.
verify() {
  sums="$TMP_DIR/SHA256SUMS"
  fetch "$(dirname "$2")/SHA256SUMS" "$sums" \
    || die "This release publishes no SHA256SUMS — refusing to install an unverified download."
  want="$(grep -E "^[0-9a-f]{64} [ *]$(basename "$1")\$" "$sums" | cut -d' ' -f1 | head -1)"
  [ -n "$want" ] || die "No checksum listed for $(basename "$1") — refusing to install it."
  [ "$want" = "$(sha256 "$1")" ] || die "Checksum mismatch for $(basename "$1") — the download is corrupt or has been tampered with."
  log "Checksum verified."
}

# The CPU, as the release names it.
case "$(uname -m)" in
  x86_64|amd64)  DEB_ARCH="amd64"; RPM_ARCH="x86_64";  APPIMAGE_ARCH="amd64" ;;
  aarch64|arm64) DEB_ARCH="arm64"; RPM_ARCH="aarch64"; APPIMAGE_ARCH="aarch64" ;;
  *) die "Unsupported CPU: $(uname -m). Builds exist for x86_64 and ARM64 only — see https://github.com/$REPO/releases" ;;
esac

install_runtime_deps() {
  [ -n "$RUNTIME_DEPS" ] || return 0
  missing=""
  for dep in $RUNTIME_DEPS; do
    command -v "$dep" >/dev/null 2>&1 || missing="$missing $dep"
  done
  [ -n "$missing" ] || return 0
  log "Installing runtime dependencies:$missing"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y $missing
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y $missing
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm $missing
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y $missing
  else
    log "No supported package manager found — install these manually:$missing"
  fi
}

install_macos() {
  # Rosetta makes `uname -m` lie; this flag does not.
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ] \
    || die "The Homebrew cask is built for Apple Silicon only; there is no Intel Mac build."
  command -v brew >/dev/null 2>&1 \
    || die "Homebrew is required on macOS. Install it from https://brew.sh"
  brew tap "$TAP"
  if brew list --cask "$CASK" >/dev/null 2>&1; then
    log "Upgrading $APP_NAME via Homebrew…"
    brew upgrade --cask "$TAP/$CASK"
  else
    log "Installing $APP_NAME via Homebrew…"
    brew install --cask "$TAP/$CASK"
  fi
  log "Done. Launch $APP_NAME from Spotlight or your Applications folder."
}

# download_asset <regex> <description> — downloads and verifies, prints the path
download_asset() {
  url="$(latest_asset "$1")"
  [ -n "$url" ] || die "No $2 for your CPU in the latest release — see https://github.com/$REPO/releases"
  file="$TMP_DIR/$(basename "$url")"
  log "Downloading $(basename "$url")…" >&2
  fetch "$url" "$file"
  verify "$file" "$url" >&2
  printf '%s' "$file"
}

install_deb() {
  file="$(download_asset "_${DEB_ARCH}\\.deb" ".deb package")"
  log "Installing the .deb package (sudo required)…"
  sudo apt-get install -y "$file"
  log "Done. Launch $APP_NAME from your applications menu."
}

install_rpm() {
  file="$(download_asset "\\.${RPM_ARCH}\\.rpm" ".rpm package")"
  log "Installing the .rpm package (sudo required)…"
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "$file"
  else
    sudo zypper --non-interactive --no-gpg-checks install "$file"
  fi
  log "Done. Launch $APP_NAME from your applications menu."
}

install_appimage() {
  file="$(download_asset "_${APPIMAGE_ARCH}\\.AppImage" ".AppImage")"

  bin_dir="$HOME/.local/bin"
  desktop_dir="$HOME/.local/share/applications"
  icon_dir="$HOME/.local/share/icons/hicolor/$ICON_SIZE/apps"
  mkdir -p "$bin_dir" "$desktop_dir" "$icon_dir"

  target="$bin_dir/$APP_SLUG.AppImage"
  cp "$file" "$target"
  chmod +x "$target"

  # AppImages are mounted through FUSE 2, which many distributions no longer ship.
  if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    log "Note: libfuse2 is not installed, and the AppImage needs it to start."
    log "      Install it (package libfuse2, or fuse-libs on Fedora), or launch with --appimage-extract-and-run."
  fi

  fetch "$ICON_URL" "$icon_dir/$APP_SLUG.png" 2>/dev/null || true

  cat > "$desktop_dir/$APP_SLUG.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=$APP_COMMENT
Exec=$target
Icon=$APP_SLUG
Terminal=false
Categories=$CATEGORIES
StartupWMClass=$APP_SLUG
EOF

  update-desktop-database "$desktop_dir" 2>/dev/null || true

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) log "Note: $bin_dir is not in your PATH — add it to your shell profile to launch from a terminal." ;;
  esac
  log "Done. Installed to $target — launch $APP_NAME from your applications menu."
}

echo "$APP_NAME installer"

case "$(uname -s)" in
  Darwin)
    install_macos
    ;;
  Linux)
    install_runtime_deps
    if command -v apt-get >/dev/null 2>&1; then
      install_deb
    elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
      install_rpm
    else
      install_appimage
    fi
    ;;
  *)
    die "Unsupported platform: $(uname -s). Download manually from https://github.com/$REPO/releases"
    ;;
esac
