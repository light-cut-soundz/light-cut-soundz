# LightCutSoundz

Trim, fade, normalize and filter your audio, then export it — locally, no subscription, no cloud.

![CI](https://github.com/light-cut-soundz/light-cut-soundz/actions/workflows/ci.yml/badge.svg) ![license](https://img.shields.io/badge/license-MIT-blue) ![platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS-lightgrey)

**Website** — <https://light-cut-soundz.github.io/light-cut-soundz/>

---

## Features

- **Precise trim** — cut by timestamp, to a hundredth of a second in the interface (to the sample in the engine); non-destructive: the source file is never modified. The whole file is decoded in memory, about 1.3 GB per hour of stereo 44.1 kHz audio, so very long recordings need the RAM to match
- **Fade in / fade out** — over the first or last N seconds, configurable to a tenth of a second; linear or equal-power (quarter-sine) curve. Two fades that overlap multiply
- **Normalization** — peak normalization, applied last: every sample is scaled so that the exported file peaks at −1 dBFS, whatever speed and filter were applied before
- **Speed change** — speed up or slow down by resampling; 0.5× halves the duration (pitch shifts with it)
- **DSP filters** — biquad IIR low-pass, high-pass and band-pass, from the RBJ Audio Cookbook. Low-pass and high-pass go from 12 to 48 dB/octave (Butterworth cascades), or take a custom Q on a single 12 dB/octave stage
- **Real-time preview** — hear filters, fades, speed and normalization while the track plays. The preview is decoded by the system WebView (GStreamer on Linux): if it cannot decode a format, the file still opens and exports
- **Multi-format export** — WAV (32-bit float, 24-bit, or 16-bit with dither), MP3 (VBR ≈ 190 kb/s), FLAC, OGG Vorbis and M4A (AAC). The encoder is a small LGPL, audio-only FFmpeg that ships with the app: nothing to install. Title, artist, album… and the cover picture are carried over to MP3, FLAC and M4A (tags only for OGG)
- **Safe export** — the file is written next to its destination and moved into place when complete, so a failed or cancelled export never destroys the file it would have replaced; progress and a Cancel button while it runs
- **Import** — MP3, FLAC, WAV, OGG, AAC, M4A, AIFF, CAF, MKA, WebM; also from the command line (`lightcutsoundz song.mp3`) and "Open with…" in your file manager

---

## Install

One command, identical on macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/light-cut-soundz/light-cut-soundz/main/install.sh | bash
```

| Platform | What it installs |
|----------|------------------|
| macOS | Homebrew cask `light-cut-soundz/tap/light-cut-soundz` |
| Linux — Debian / Ubuntu | `.deb` package |
| Linux — Fedora / openSUSE | `.rpm` package |
| Linux — other distributions | `.AppImage` in `~/.local/bin`, registered in your applications menu |

Re-run the exact same command to upgrade to the latest release. Every download is checked against the `SHA256SUMS` published with the release before it is installed.

> macOS: Apple Silicon only (M1/M2/M3/M4), macOS 11 or later. Linux: x86_64 and ARM64.

### Manual install

**macOS — Homebrew**

```bash
brew install --cask light-cut-soundz/tap/light-cut-soundz
```

**Linux — Debian / Ubuntu**

Download the `.deb` from the [latest release](https://github.com/light-cut-soundz/light-cut-soundz/releases/latest), then:

```bash
sudo apt install ./LightCutSoundz_*_amd64.deb   # arm64 on ARM
```

**Linux — Fedora / openSUSE**

```bash
sudo dnf install ./LightCutSoundz-*.x86_64.rpm  # aarch64 on ARM; zypper on openSUSE
```

**Linux — other distributions**

Download the `.AppImage` from the [latest release](https://github.com/light-cut-soundz/light-cut-soundz/releases/latest), then:

```bash
chmod +x LightCutSoundz_*_amd64.AppImage      # aarch64 on ARM
./LightCutSoundz_*_amd64.AppImage
```

AppImages need FUSE 2 (`libfuse2`, `fuse-libs` on Fedora); without it, run them with `--appimage-extract-and-run`.

---

## Requirements

Nothing to install: every export format works out of the box, and the packages pull in what the preview needs (`gstreamer1.0-plugins-good` for MP3 on Debian / Ubuntu; add `gstreamer1.0-libav` for AAC and M4A previews).

The bundled FFmpeg is a separate program; if it is ever missing, the app falls back to an `ffmpeg` on your `PATH`. To use another build, set `LIGHTCUTSOUNDZ_FFMPEG=/path/to/ffmpeg`.

---

## Uninstall

**macOS — Homebrew**

```bash
brew uninstall --cask light-cut-soundz
brew untap light-cut-soundz/tap
```

Add `--zap` to also remove settings, caches and application data:

```bash
brew uninstall --zap --cask light-cut-soundz
```

**Linux — Debian / Ubuntu**

```bash
sudo apt remove light-cut-soundz
```

**Linux — Fedora / openSUSE**

```bash
sudo dnf remove light-cut-soundz   # or: sudo zypper remove light-cut-soundz
```

**Linux — AppImage**

```bash
rm ~/.local/bin/lightcutsoundz.AppImage
rm ~/.local/share/applications/lightcutsoundz.desktop
rm ~/.local/share/icons/hicolor/512x512/apps/lightcutsoundz.png
update-desktop-database ~/.local/share/applications
```

**All platforms — one command**

```bash
curl -fsSL https://raw.githubusercontent.com/light-cut-soundz/light-cut-soundz/main/uninstall.sh | bash
```

Add `-s -- --purge` after `bash` to also delete the data the app's WebView keeps (the saved language).

---

## Development

### Prerequisites

- [Rust](https://rustup.rs) 1.88+
- [Node.js](https://nodejs.org) 22+ (LTS)
- On Linux, the [Tauri system dependencies](https://tauri.app/start/prerequisites/) (WebKitGTK 4.1, GTK 3…)
- The ffmpeg sidecar: the build refuses to start without `src-tauri/binaries/lightcutsoundz-ffmpeg-<target-triple>`. Build the real one with `scripts/build-ffmpeg.sh src-tauri/binaries/lightcutsoundz-ffmpeg-$(rustc -vV | sed -n 's/host: //p')` (about a minute; needs a C toolchain, `make`, `curl`, `xz` and `pkg-config`), or, to just run the tests, create an empty executable under that name.

### Setup

```bash
git clone https://github.com/light-cut-soundz/light-cut-soundz.git
cd light-cut-soundz
npm install
```

### Run in dev mode

```bash
npm run tauri dev
```

### Build the packaged app

```bash
npm run tauri build
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server only |
| `npm run tauri dev` | Run the app with hot reload |
| `npm run tauri build` | Produce release bundles (deb / rpm / AppImage on Linux, `.app` on macOS) |
| `npm run lint` | ESLint over `src/` |
| `npm run test` | Vitest unit tests |
| `npm run coverage` | Tests with coverage report |
| `cargo test` | Rust unit tests (from `src-tauri/`); the export tests use the `ffmpeg` on your `PATH` (or `LIGHTCUTSOUNDZ_FFMPEG`) and skip themselves without one |
| `scripts/build-ffmpeg.sh <out>` | Builds the bundled LGPL, audio-only ffmpeg from checksummed upstream sources |
| `scripts/third-party-licenses.sh` | Regenerates `THIRD_PARTY_LICENSES.html` after a `Cargo.lock` change (needs `cargo-about`) |

---

## Changelog

[CHANGELOG.md](CHANGELOG.md) (English) and [CHANGELOG.fr.md](CHANGELOG.fr.md) (French) follow Keep a Changelog; add changes under `## [Unreleased]` in **both**, and rename that heading to the version when releasing. The app embeds them (Help ▸ What's New), and the release workflow refuses a tag with no entry in both files: `scripts/release-notes.sh <version>` builds the release notes from them, which the in-app updater shows before you install an update.

---

## CI / CD

- **CI** (`ci.yml`) runs on every push and pull request: lint, unit tests with coverage, the Rust test suite, dependency audits (`cargo audit`, `npm audit`), a build of the bundled ffmpeg on each platform, and a check that the third-party licence list is current. Third-party actions are pinned to a commit; Dependabot proposes the updates.
- **Release** is triggered by pushing a `v*.*.*` tag (or by re-running an existing tag): `ship-impl.yml` checks out that tag, builds the ffmpeg sidecar from source, builds the app archive on macOS and the `.deb` + `.AppImage` + `.rpm` on Linux (x86_64 and ARM64), signs them, publishes `SHA256SUMS`, attaches everything to the GitHub release, and bumps the cask in [light-cut-soundz/homebrew-tap](https://github.com/light-cut-soundz/homebrew-tap).

---

## License

MIT — see [LICENSE](LICENSE).

The app bundles FFmpeg (LGPL 2.1+, built without GPL components), LAME, libogg and libvorbis, and links the Rust crates listed in `THIRD_PARTY_LICENSES.html`. Their licences, sources and the build recipe are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md); the same files are installed with the app.
