#!/usr/bin/env bash
# Builds the ffmpeg that LightCutSoundz bundles as a sidecar: LGPL only (no
# --enable-gpl, no x264/x265), audio only, with nothing but what the exports use
# — raw float PCM in, MP3 / FLAC / Ogg Vorbis / M4A (AAC) out, plus the JPEG and
# PNG readers needed to copy a cover picture into the output untouched. A few
# megabytes instead of the ~80 MB of a general-purpose static build.
#
# Usage: scripts/build-ffmpeg.sh <output-file> [work-dir]
#
# Needs a C toolchain, make, curl, xz and pkg-config. Every source tarball is
# checked against the SHA-256 pinned below before anything is built.
set -euo pipefail

OUT=${1:?usage: build-ffmpeg.sh <output-file> [work-dir]}
WORK=${2:-$(mktemp -d)}
# The build changes directory: both paths must survive that.
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)

FFMPEG_VERSION=7.1.1
LAME_VERSION=3.100
OGG_VERSION=1.3.5
VORBIS_VERSION=1.3.7
ZLIB_VERSION=1.3.1

ZLIB_URL="https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"
OGG_URL="https://downloads.xiph.org/releases/ogg/libogg-${OGG_VERSION}.tar.xz"
VORBIS_URL="https://downloads.xiph.org/releases/vorbis/libvorbis-${VORBIS_VERSION}.tar.xz"

ZLIB_SHA256=38ef96b8dfe510d42707d9c781877914792541133e1870841463bfa73f883e32
FFMPEG_SHA256=733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1
LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
OGG_SHA256=c4d91be36fc8e54deae7575241e03f4211eb102afb3fc0775fbbc1b740016705
VORBIS_SHA256=b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() { # url sha256 -> extracted directory name on stdout
  local url=$1 want=$2 file="$WORK/dl/$(basename "$1")"
  mkdir -p "$WORK/dl" "$WORK/src"
  [ -f "$file" ] || curl -fsSL --retry 3 -o "$file" "$url"
  local got
  got=$(sha256_of "$file")
  if [ "$got" != "$want" ]; then
    echo "checksum mismatch for $url: expected $want, got $got" >&2
    exit 1
  fi
  tar -xf "$file" -C "$WORK/src"
}

JOBS=$( (nproc || sysctl -n hw.ncpu) 2>/dev/null || echo 2)
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export CFLAGS="-O2 -fPIC"

echo "== zlib ${ZLIB_VERSION}"
fetch "$ZLIB_URL" "$ZLIB_SHA256"
(cd "$WORK/src/zlib-${ZLIB_VERSION}" &&
  ./configure --prefix="$PREFIX" --static >/dev/null &&
  make -j"$JOBS" >/dev/null && make install >/dev/null)

echo "== libmp3lame ${LAME_VERSION}"
fetch "$LAME_URL" "$LAME_SHA256"
(cd "$WORK/src/lame-${LAME_VERSION}" &&
  ./configure --prefix="$PREFIX" --disable-shared --enable-static \
    --disable-frontend --disable-decoder --disable-nasm >/dev/null &&
  make -j"$JOBS" >/dev/null && make install >/dev/null)

echo "== libogg ${OGG_VERSION}"
fetch "$OGG_URL" "$OGG_SHA256"
(cd "$WORK/src/libogg-${OGG_VERSION}" &&
  ./configure --prefix="$PREFIX" --disable-shared --enable-static >/dev/null &&
  make -j"$JOBS" >/dev/null && make install >/dev/null)

echo "== libvorbis ${VORBIS_VERSION}"
fetch "$VORBIS_URL" "$VORBIS_SHA256"
# libvorbis 1.3.7's configure passes `-force_cpusubtype_ALL` on macOS, which the
# current linker rejects ("ld: unknown options"). It is a no-op there anyway.
(cd "$WORK/src/libvorbis-${VORBIS_VERSION}" &&
  sed 's/-force_cpusubtype_ALL//g' configure > configure.fixed && mv configure.fixed configure &&
  chmod +x configure &&
  ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-oggtest >/dev/null &&
  make -j"$JOBS" >/dev/null && make install >/dev/null)

echo "== ffmpeg ${FFMPEG_VERSION}"
fetch "$FFMPEG_URL" "$FFMPEG_SHA256"
cd "$WORK/src/ffmpeg-${FFMPEG_VERSION}"
./configure \
  --prefix="$PREFIX/ffmpeg" \
  --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include" \
  --extra-ldflags="-L$PREFIX/lib" \
  --disable-everything --disable-autodetect --disable-network \
  --disable-doc --disable-debug --disable-ffplay --disable-ffprobe \
  --disable-x86asm --enable-small \
  --enable-ffmpeg --enable-swresample \
  --enable-zlib --enable-libmp3lame --enable-libvorbis \
  --enable-protocol=file,pipe \
  --enable-demuxer=pcm_f32le,image2,image_jpeg_pipe,image_png_pipe \
  --enable-decoder=pcm_f32le,mjpeg,png \
  --enable-muxer=mp3,flac,ogg,ipod \
  --enable-encoder=libmp3lame,flac,libvorbis,aac \
  --enable-parser=aac,flac,mpegaudio,vorbis,mjpeg,png \
  --enable-filter=aresample,aformat,anull >/dev/null
make -j"$JOBS" >/dev/null
strip ffmpeg

# The whole point of this build: refuse to ship anything but an LGPL one.
if ./ffmpeg -hide_banner -version | grep -Eq -- '--enable-(gpl|nonfree|version3)|x264|x265'; then
  echo "this ffmpeg is not LGPL-only" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
cp ffmpeg "$OUT"
chmod +x "$OUT"
echo "built $OUT ($(wc -c <"$OUT") bytes)"
