# Changelog

All notable changes to LightCutSoundz. French version: [CHANGELOG.fr.md](CHANGELOG.fr.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). Each release needs an entry in **both** files: the app shows the one in the user's language, and the release notes shown before an update are built from them.

## [Unreleased]

## [1.2.0] - 2026-10-28

### Added
- Cuts: drag on the timeline to mark the parts to remove, as many as you like; resize or move them, or edit their times. The seek bar, the preview and the export all skip them. The keys I and O mark a cut at the playhead.
- A seek bar under the player, and a live frequency visualisation while a file plays.
- Undo and Redo buttons, and the Open and Export buttons, in the header.
- The light and dark themes now follow View ▸ Theme everywhere, whatever the system's.
- The recent files list on the home screen follows the one in the File menu when it is cleared.

### Changed
- The editor has the layout of LightCutVidz: the settings in a sidebar on the right, the seek bar under the player, the waveform below as the timeline.
- Cuts replace the trim range, and the sidebar explains how to make them.
- The export options are in a dialog opened by the Export button, instead of a bar at the bottom.
- The filter type and the fade curve are chosen with buttons, and the speed with the same slider and presets as LightCutVidz (0.25x to 4x).
- Buttons, labels and menus take the look of LightCutVidz; the Theme and Language menus show radio buttons.

## [1.1.0] - 2026-10-26

### Added
- Export progress, and a Cancel button while an export runs.
- WAV export as 32-bit float, 24-bit, or 16-bit with dither; M4A (AAC) export.
- Title, artist, album… and the cover picture are kept when exporting to MP3, FLAC and M4A (tags only for OGG).
- Equal-power fade curve; low-pass and high-pass from 12 to 48 dB/octave, with an adjustable Q on a single stage.
- Opening files from the command line and with "Open with…"; AIFF, CAF, MKA and WebM import.
- Settings are checked before exporting, with the faulty field flagged and the reason shown in the language of the interface.
- This changelog, in the app (Help ▸ What's New) and before an update is installed.
- Third-party licences are shipped with the app.

### Changed
- Normalisation is applied last, so the exported file really peaks at −1 dBFS whatever speed or filter was applied.
- The preview now matches the export: same normalisation target, overlapping fades multiply, same filter shape.
- Updates are announced and installed only when you choose to, never during an export.
- The bundled FFmpeg is a small LGPL, audio-only build (about 3 MB instead of 80 MB), built from checksummed sources.
- Exports are written to a temporary file and moved into place: a failed or cancelled export no longer destroys the file it would have replaced.
- Faster loading and exporting: the file is decoded once, work no longer blocks the interface, the waveform is cached while playing.
- MP3 exports use a higher quality (VBR ≈ 190 kb/s).

### Fixed
- Files in hidden folders, `/tmp` or network mounts could not be opened.
- A format the system cannot preview no longer prevents opening and exporting the file.
- Exporting without typing a file extension no longer fails; the extension of the chosen format is added.
- Playback stopping at the end of the trim, and fades, no longer depend on the window being visible.
- Several smaller issues: empty trim exports, silent regions with normalisation, filter values such as `NaN`, space bar on buttons, error messages in English, and more.

### Security
- Only files you picked, dropped or launched the app with can be read or written; a content security policy is enabled.
- Release downloads are verified with SHA-256 before `install.sh` installs them, and the release workflows pin their actions.

## [1.0.0] - 2026-08-19

### Added
- First release: trim, fade in/out, peak normalisation, speed change, low-pass / high-pass / band-pass filters.
- Real-time preview, waveform with draggable trim handles.
- Export to WAV, MP3, FLAC and OGG.
- English and French interface, automatic updates, installers for macOS (Homebrew) and Linux (`.deb`, AppImage).
