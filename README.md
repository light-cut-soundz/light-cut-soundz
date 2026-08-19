# LightCutSoundz

Trim, fade, normalize and filter your audio, then export it — locally, no subscription, no cloud.

![CI](https://github.com/light-cut-soundz/light-cut-soundz/actions/workflows/ci.yml/badge.svg) ![license](https://img.shields.io/badge/license-MIT-blue) ![platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS-lightgrey)

**Website** — <https://light-cut-soundz.github.io/light-cut-soundz/>

---

## Features

- **Precise trim** — cut by timestamp, to the second; non-destructive, applied on the in-memory buffer
- **Fade in / fade out** — linear ramp over the first or last N seconds, configurable to a tenth of a second
- **Normalization** — peak normalization: every sample is divided by the maximum absolute value to reach 0 dBFS
- **Speed change** — speed up or slow down by resampling; 0.5× halves the duration (pitch shifts with it)
- **DSP filters** — biquad IIR low-pass, high-pass and band-pass, from the RBJ Audio Cookbook, Q = 0.707
- **Real-time preview** — hear filters, fades, speed and normalization while the track plays
- **Multi-format export** — WAV natively, plus MP3, FLAC and OGG when FFmpeg is available
- **Import** — MP3, FLAC, WAV, OGG, AAC, M4A

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
| Linux — other distributions | `.AppImage` in `~/.local/bin`, registered in your applications menu |

Re-run the exact same command to upgrade to the latest release.

> Apple Silicon only (M1/M2/M3/M4), macOS 10.13 or later.

### Manual install

**macOS — Homebrew**

```bash
brew install --cask light-cut-soundz/tap/light-cut-soundz
```

**Linux — Debian / Ubuntu**

Download the `.deb` from the [latest release](https://github.com/light-cut-soundz/light-cut-soundz/releases/latest), then:

```bash
sudo apt install ./LightCutSoundz_*_amd64.deb
```

**Linux — other distributions**

Download the `.AppImage` from the [latest release](https://github.com/light-cut-soundz/light-cut-soundz/releases/latest), then:

```bash
chmod +x LightCutSoundz_*_amd64.AppImage
./LightCutSoundz_*_amd64.AppImage
```

---

## Requirements

- **WAV export** works out of the box.
- **MP3 / FLAC / OGG export** requires [`ffmpeg`](https://ffmpeg.org) on your `PATH`.

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
sudo apt remove light-cut-sound-z
```

**Linux — AppImage**

```bash
rm ~/.local/bin/lightcutsoundz.AppImage
rm ~/.local/share/applications/lightcutsoundz.desktop
rm ~/.local/share/icons/hicolor/512x512/apps/lightcutsoundz.png
update-desktop-database ~/.local/share/applications
```

---

## Development

### Prerequisites

- [Rust](https://rustup.rs) 1.70+
- [Node.js](https://nodejs.org) 20+

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
| `npm run tauri build` | Produce release bundles (deb / AppImage / dmg) |
| `npm run lint` | ESLint over `src/` |
| `npm run test` | Vitest unit tests |
| `npm run coverage` | Tests with coverage report |
| `cargo test` | Rust unit tests (from `src-tauri/`) |

---

## CI / CD

- **CI** (`ci.yml`) runs on every push and pull request: lint, unit tests and the Rust test suite.
- **Release** is triggered by pushing a `v*.*.*` tag: `ship-impl.yml` builds the app archive on macOS and the `.deb` + `.AppImage` + `.rpm` on Linux, attaches them to the GitHub release, and bumps the cask in [light-cut-soundz/homebrew-tap](https://github.com/light-cut-soundz/homebrew-tap).

---

## License

MIT — see [LICENSE](LICENSE).
