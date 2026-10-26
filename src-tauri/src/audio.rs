use crate::error::coded;
use crate::job::Job;
use crate::tags::Tags;
use anyhow::{bail, Context, Result};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Sidecar name used by `externalBin` in tauri.conf.json. Deliberately prefixed
/// so the Linux packages don't ship a file at `/usr/bin/ffmpeg`, which the
/// distribution's own ffmpeg package already owns.
const SIDECAR_NAME: &str = "lightcutsoundz-ffmpeg";

/// Upper bound on the up-front reservation: a corrupt header may claim any
/// frame count, and it must not turn into a giant allocation.
const MAX_RESERVED_FRAMES: u64 = 1 << 26;

/// Stream resets tolerated in one file (chained Ogg streams, mostly).
const MAX_STREAM_RESETS: usize = 16;

#[derive(Clone, Debug)]
pub struct AudioBuffer {
    pub samples: Vec<Vec<f32>>,
    pub sample_rate: u32,
}

impl AudioBuffer {
    /// Channel count is derived from the buffer itself, never stored separately:
    /// a stored count can disagree with `samples` and turn every indexed access
    /// into an out-of-bounds panic.
    pub fn channels(&self) -> usize {
        self.samples.len()
    }

    /// Shortest channel, so `0..num_frames()` is always in bounds for every channel.
    pub fn num_frames(&self) -> usize {
        self.samples.iter().map(|ch| ch.len()).min().unwrap_or(0)
    }

    pub fn duration_secs(&self) -> f64 {
        self.num_frames() as f64 / self.sample_rate as f64
    }
}

/// First decodable track of the stream, with a decoder for it.
fn open_track(
    format: &dyn FormatReader,
) -> Result<(
    u32,
    symphonia::core::codecs::CodecParameters,
    Box<dyn Decoder>,
)> {
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| coded("unsupported_format", &[], "No audio track found"))?;
    let params = track.codec_params.clone();
    let decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|_| coded("unsupported_format", &[], "Unsupported codec"))?;
    Ok((track.id, params, decoder))
}

fn is_eof(e: &SymError) -> bool {
    matches!(e, SymError::IoError(io) if io.kind() == std::io::ErrorKind::UnexpectedEof)
}

pub fn decode(path: &str) -> Result<AudioBuffer> {
    let file = std::fs::File::open(path).map_err(|e| {
        coded(
            "cannot_open",
            &[("path", path.to_string())],
            format!("Cannot open '{path}': {e}"),
        )
    })?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| coded("unsupported_format", &[], "Unsupported audio format"))?;

    let mut format = probed.format;
    let (mut track_id, codec_params, mut decoder) = open_track(format.as_ref())?;

    // Layout is taken from the decoded frames, not from the container metadata:
    // codec parameters may omit the channel count or the sample rate entirely.
    let mut channel_samples: Vec<Vec<f32>> = Vec::new();
    let mut sample_rate = codec_params.sample_rate.unwrap_or(0);
    let reserve = codec_params.n_frames.unwrap_or(0).min(MAX_RESERVED_FRAMES) as usize;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut resets = 0usize;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(e) if is_eof(&e) => break,
            Err(SymError::ResetRequired) => {
                // The track list changed (chained streams): decoders must be
                // recreated for the new stream rather than reused.
                resets += 1;
                if resets > MAX_STREAM_RESETS {
                    bail!("Too many stream resets");
                }
                (track_id, _, decoder) = open_track(format.as_ref())?;
                continue;
            }
            Err(e) => return Err(e).context("Cannot read the audio stream"),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let n_ch = spec.channels.count();
                let frames = decoded.frames();
                if n_ch == 0 || frames == 0 {
                    continue;
                }
                if sample_rate == 0 {
                    sample_rate = spec.rate;
                }
                if channel_samples.is_empty() {
                    channel_samples = (0..n_ch).map(|_| Vec::with_capacity(reserve)).collect();
                } else if channel_samples.len() != n_ch {
                    bail!(
                        "Channel count changed mid-stream ({} then {n_ch})",
                        channel_samples.len()
                    );
                }

                // One sample buffer for the whole file, regrown only when a
                // packet is bigger than any seen so far.
                let needed = frames * n_ch;
                let too_small = match &sample_buf {
                    Some(b) => b.capacity() < needed,
                    None => true,
                };
                if too_small {
                    sample_buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
                }
                let sb = sample_buf.as_mut().expect("allocated above");
                sb.copy_planar_ref(decoded);
                let planar = sb.samples();
                for (c, ch) in channel_samples.iter_mut().enumerate() {
                    ch.extend_from_slice(&planar[c * frames..(c + 1) * frames]);
                }
            }
            Err(e) if is_eof(&e) => break,
            Err(SymError::ResetRequired) => decoder.reset(),
            // A corrupt packet is skipped; anything else (a read error on a
            // network drive, say) must not silently truncate the audio.
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e).context("Cannot decode the audio stream"),
        }
    }

    if channel_samples.is_empty() || channel_samples.iter().all(|ch| ch.is_empty()) {
        return Err(coded("empty_audio", &[], "Decoded audio is empty"));
    }
    if sample_rate == 0 {
        bail!("Unknown sample rate");
    }

    Ok(AudioBuffer {
        samples: channel_samples,
        sample_rate,
    })
}

/// Hidden sibling of the destination that the output is written to first. It
/// replaces the destination in one `rename` once complete, so a failed export
/// never leaves a truncated file — and never destroys the file it overwrites.
struct PartFile {
    path: PathBuf,
    committed: bool,
}

impl PartFile {
    fn new(output: &str) -> Result<Self> {
        let out = Path::new(output);
        let name = out
            .file_name()
            .and_then(|n| n.to_str())
            .with_context(|| format!("'{output}' is not a file path"))?;
        let dir = match out.parent() {
            Some(d) if !d.as_os_str().is_empty() => d,
            _ => Path::new("."),
        };
        Ok(Self {
            path: dir.join(format!(".{name}.{}.part", std::process::id())),
            committed: false,
        })
    }

    fn commit(mut self, output: &str) -> Result<()> {
        std::fs::rename(&self.path, output).map_err(|e| {
            coded(
                "cannot_write",
                &[("path", output.to_string())],
                format!("Cannot write '{output}': {e}"),
            )
        })?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn cannot_write(path: &Path, e: impl std::fmt::Display) -> anyhow::Error {
    let p = path.to_string_lossy().to_string();
    coded(
        "cannot_write",
        &[("path", p.clone())],
        format!("Cannot write '{p}': {e}"),
    )
}

/// Frames between two cancellation checks and progress reports while writing.
const WRITE_BLOCK_FRAMES: usize = 1 << 16;

/// Sample format of a WAV export.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WavDepth {
    /// 32-bit float: lossless, and keeps levels above full scale.
    #[default]
    Float32,
    /// 24-bit integer, what studios exchange.
    Pcm24,
    /// 16-bit integer with triangular dither, what a CD or an old sampler takes.
    Pcm16,
}

impl WavDepth {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "float32" => Ok(WavDepth::Float32),
            "pcm24" => Ok(WavDepth::Pcm24),
            "pcm16" => Ok(WavDepth::Pcm16),
            other => Err(coded(
                "wav_depth",
                &[("value", other.to_string())],
                format!("Unknown WAV bit depth '{other}'"),
            )),
        }
    }

    fn bits(self) -> u16 {
        match self {
            WavDepth::Float32 => 32,
            WavDepth::Pcm24 => 24,
            WavDepth::Pcm16 => 16,
        }
    }
}

/// Triangular-PDF dither: the difference of two uniform noises, ±1 LSB, which
/// turns the rounding error of a 16-bit conversion into steady, signal-
/// independent hiss instead of distortion that follows the music. Seeded, so an
/// export is reproducible.
struct Dither(u64);

impl Dither {
    fn next_unit(&mut self) -> f32 {
        // xorshift64*: plenty for noise.
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let r = self.0.wrapping_mul(0x2545_F491_4F6C_DD1D);
        (r >> 40) as f32 / (1u64 << 24) as f32
    }

    fn lsb(&mut self) -> f32 {
        self.next_unit() - self.next_unit()
    }
}

/// `x` (nominally −1…1) as an integer of `bits` bits, clipped at full scale.
fn quantize(x: f32, bits: u16, noise_lsb: f32) -> i32 {
    let max = ((1i64 << (bits - 1)) - 1) as f32;
    (x * max + noise_lsb).round().clamp(-max - 1.0, max) as i32
}

/// Writes every frame, converting each sample with `convert(channel, x)`.
fn write_samples<S: hound::Sample>(
    buf: &AudioBuffer,
    path: &Path,
    spec: WavSpec,
    job: &Job,
    mut convert: impl FnMut(usize, f32) -> S,
) -> Result<()> {
    let mut writer = WavWriter::create(path, spec).map_err(|e| cannot_write(path, e))?;
    let frames = buf.num_frames();
    for f in 0..frames {
        if f % WRITE_BLOCK_FRAMES == 0 {
            job.check()?;
            job.progress(f as f32 / frames as f32);
        }
        for (c, ch) in buf.samples.iter().enumerate() {
            writer.write_sample(convert(c, ch[f]))?;
        }
    }
    writer.finalize()?;
    Ok(())
}

fn write_wav_file(buf: &AudioBuffer, path: &Path, depth: WavDepth, job: &Job) -> Result<()> {
    let spec = WavSpec {
        channels: buf.channels() as u16,
        sample_rate: buf.sample_rate,
        bits_per_sample: depth.bits(),
        sample_format: match depth {
            WavDepth::Float32 => SampleFormat::Float,
            _ => SampleFormat::Int,
        },
    };
    // One generator per channel, so the dither is not the same noise on both.
    let mut dithers: Vec<Dither> = (0..buf.channels())
        .map(|c| Dither(0x9E37_79B9_7F4A_7C15 ^ ((c as u64 + 1) << 32)))
        .collect();

    match depth {
        WavDepth::Float32 => write_samples(buf, path, spec, job, |_, x| x),
        WavDepth::Pcm24 => write_samples(buf, path, spec, job, |_, x| quantize(x, 24, 0.0)),
        WavDepth::Pcm16 => write_samples(buf, path, spec, job, |c, x| {
            quantize(x, 16, dithers[c].lsb()) as i16
        }),
    }
}

pub fn encode_wav(buf: &AudioBuffer, path: &str, depth: WavDepth, job: &Job) -> Result<()> {
    if buf.channels() == 0 {
        bail!("Cannot write a WAV with no channels");
    }
    let part = PartFile::new(path)?;
    write_wav_file(buf, &part.path, depth, job)?;
    job.check()?;
    part.commit(path)
}

/// Where the bundled ffmpeg sits relative to the running executable.
fn locate_sidecar(exe: &Path) -> Option<PathBuf> {
    // Tauri drops the sidecar next to the executable: Contents/MacOS on
    // macOS, the install prefix on Linux.
    let dir = exe.parent()?;
    let beside = dir.join(SIDECAR_NAME);
    if beside.exists() {
        return Some(beside);
    }
    let resources = dir.parent()?.join("Resources").join(SIDECAR_NAME);
    resources.exists().then_some(resources)
}

/// Name of the environment variable that points the app at another ffmpeg.
const FFMPEG_ENV: &str = "LIGHTCUTSOUNDZ_FFMPEG";

/// Which ffmpeg to run: the one named by `override_path`, else the bundled
/// sidecar next to `exe`, else whatever `ffmpeg` the `PATH` offers.
fn resolve_ffmpeg(override_path: Option<String>, exe: Option<&Path>) -> String {
    if let Some(path) = override_path.filter(|p| !p.trim().is_empty()) {
        return path;
    }
    exe.and_then(locate_sidecar)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "ffmpeg".to_string())
}

fn find_ffmpeg() -> String {
    resolve_ffmpeg(
        std::env::var(FFMPEG_ENV).ok(),
        std::env::current_exe().ok().as_deref(),
    )
}

/// The container and encoder settings for an export format. They are always
/// passed explicitly: the output name is whatever the user typed, and ffmpeg
/// would otherwise guess the container from its extension.
pub fn ffmpeg_target(format: &str) -> Result<(&'static str, &'static [&'static str])> {
    Ok(match format {
        "mp3" => ("mp3", &["-c:a", "libmp3lame", "-q:a", "2"]),
        "flac" => ("flac", &["-c:a", "flac"]),
        "ogg" => ("ogg", &["-c:a", "libvorbis", "-q:a", "5"]),
        "m4a" => ("ipod", &["-c:a", "aac", "-b:a", "192k"]),
        other => {
            return Err(coded(
                "unknown_format",
                &[("format", other.to_string())],
                format!("Unknown format: {other}"),
            ))
        }
    })
}

/// Streams the buffer to ffmpeg as raw interleaved little-endian f32, so no
/// intermediate file (gigabytes per hour of audio, often on a RAM-backed
/// /tmp) is ever written.
fn write_pcm(mut sink: impl Write, buf: &AudioBuffer, job: &Job) -> std::io::Result<()> {
    const BLOCK_FRAMES: usize = 4096;
    let frames = buf.num_frames();
    let mut bytes = Vec::with_capacity(BLOCK_FRAMES * buf.channels() * 4);
    let mut pos = 0;
    while pos < frames {
        // A cancelled export stops feeding ffmpeg; the caller then discards
        // whatever it managed to encode.
        if job.check().is_err() {
            break;
        }
        job.progress(pos as f32 / frames as f32);
        let end = (pos + BLOCK_FRAMES).min(frames);
        bytes.clear();
        for f in pos..end {
            for ch in buf.samples.iter() {
                bytes.extend_from_slice(&ch[f].to_le_bytes());
            }
        }
        sink.write_all(&bytes)?;
        pos = end;
    }
    Ok(())
}

pub fn encode_via_ffmpeg(
    buf: &AudioBuffer,
    output_path: &str,
    format: &str,
    tags: &Tags,
    job: &Job,
) -> Result<()> {
    encode_with(&find_ffmpeg(), buf, output_path, format, tags, job)
}

/// Containers that can carry a cover picture with ffmpeg's muxers (the Ogg one
/// cannot).
fn muxer_takes_cover(muxer: &str) -> bool {
    matches!(muxer, "mp3" | "flac" | "ipod")
}

/// The ffmpeg command line, after the program name.
fn ffmpeg_args(
    buf: &AudioBuffer,
    muxer: &str,
    codec: &[&str],
    tags: &Tags,
    cover: Option<&Path>,
    output: &Path,
) -> Vec<String> {
    let mut args: Vec<String> = ["-y", "-v", "error", "-f", "f32le"]
        .iter()
        .map(|a| a.to_string())
        .collect();
    args.extend(["-ar".into(), buf.sample_rate.to_string()]);
    args.extend(["-ac".into(), buf.channels().to_string()]);
    args.extend(["-i".into(), "pipe:0".into()]);
    if let Some(cover) = cover {
        args.extend(["-i".into(), format!("file:{}", cover.to_string_lossy())]);
        args.extend(["-map", "0:a", "-map", "1:v", "-c:v", "copy"].map(String::from));
        args.extend(["-disposition:v:0", "attached_pic"].map(String::from));
    }
    for (key, value) in &tags.pairs {
        args.extend(["-metadata".into(), format!("{key}={value}")]);
    }
    if muxer == "mp3" {
        // ID3v2.3 is the version every player reads; ffmpeg's default is 2.4.
        args.extend(["-id3v2_version", "3"].map(String::from));
    }
    args.extend(codec.iter().map(|a| a.to_string()));
    args.extend(["-f".into(), muxer.into()]);
    // `file:` keeps ffmpeg from reading the path as a URL (`http:`, `pipe:`…).
    args.push(format!("file:{}", output.to_string_lossy()));
    args
}

/// The cover picture, written next to the output for ffmpeg to read (it is a
/// second input, and stdin is taken by the audio). Removed on drop.
struct CoverFile(PathBuf);

impl CoverFile {
    fn write(output: &str, cover: &crate::tags::Cover) -> Option<Self> {
        let part = PartFile::new(output).ok()?;
        let mut name = part.path.file_name()?.to_os_string();
        name.push(format!(".cover.{}", cover.ext));
        let path = part.path.with_file_name(name);
        std::fs::write(&path, &cover.data).ok()?;
        Some(CoverFile(path))
    }
}

impl Drop for CoverFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn encode_with(
    ffmpeg_bin: &str,
    buf: &AudioBuffer,
    output_path: &str,
    format: &str,
    tags: &Tags,
    job: &Job,
) -> Result<()> {
    let (muxer, codec) = ffmpeg_target(format)?;
    if buf.channels() == 0 {
        bail!("Cannot encode a buffer with no channels");
    }
    let part = PartFile::new(output_path)?;
    // A cover that cannot be staged is dropped: the audio matters more.
    let cover = tags
        .cover
        .as_ref()
        .filter(|_| muxer_takes_cover(muxer))
        .and_then(|c| CoverFile::write(output_path, c));
    let args = ffmpeg_args(
        buf,
        muxer,
        codec,
        tags,
        cover.as_ref().map(|c| c.0.as_path()),
        &part.path,
    );

    let mut child = Command::new(ffmpeg_bin)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            coded(
                "ffmpeg_missing",
                &[],
                format!("ffmpeg not found — install ffmpeg to export MP3/FLAC/OGG/M4A ({e})"),
            )
        })?;

    let stdin = child.stdin.take().expect("stdin was piped");
    let output = std::thread::scope(|s| {
        // A write error means ffmpeg stopped reading; its exit status and
        // stderr below say why, so the error itself is not interesting.
        s.spawn(move || write_pcm(stdin, buf, job));
        child.wait_with_output()
    })
    .context("Cannot wait for ffmpeg")?;

    job.check()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last_line = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("(no output)");
        return Err(coded(
            "ffmpeg_failed",
            &[
                ("format", format.to_string()),
                ("detail", last_line.to_string()),
            ],
            format!("ffmpeg failed to encode to {format}: {last_line}"),
        ));
    }
    part.commit(output_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CmdError;
    use crate::job::Job;
    use crate::tags::Tags;

    fn tmp_wav_path(dir: &tempfile::TempDir, name: &str) -> String {
        dir.path().join(name).to_str().unwrap().to_string()
    }

    fn code_of(e: anyhow::Error) -> String {
        CmdError::from(e).code
    }

    fn tone(frames: usize, channels: usize, sr: u32) -> AudioBuffer {
        AudioBuffer {
            samples: (0..channels)
                .map(|c| {
                    (0..frames)
                        .map(|i| {
                            0.4 * (2.0
                                * std::f32::consts::PI
                                * (220.0 + 110.0 * c as f32)
                                * i as f32
                                / sr as f32)
                                .sin()
                        })
                        .collect()
                })
                .collect(),
            sample_rate: sr,
        }
    }

    fn system_ffmpeg() -> bool {
        Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    fn leftovers(dir: &tempfile::TempDir) -> Vec<String> {
        std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".part"))
            .collect()
    }

    #[test]
    fn channels_follows_samples() {
        let buf = AudioBuffer {
            samples: vec![vec![0.0; 4], vec![0.0; 4]],
            sample_rate: 48000,
        };
        assert_eq!(buf.channels(), 2);
    }

    #[test]
    fn num_frames_uses_shortest_channel() {
        let buf = AudioBuffer {
            samples: vec![vec![0.0; 10], vec![0.0; 4]],
            sample_rate: 48000,
        };
        assert_eq!(buf.num_frames(), 4);
    }

    #[test]
    fn num_frames_of_empty_buffer_is_zero() {
        let buf = AudioBuffer {
            samples: vec![],
            sample_rate: 48000,
        };
        assert_eq!(buf.num_frames(), 0);
        assert_eq!(buf.channels(), 0);
        assert_eq!(buf.duration_secs(), 0.0);
    }

    #[test]
    fn duration_matches_frames_and_rate() {
        let buf = AudioBuffer {
            samples: vec![vec![0.0; 22050]],
            sample_rate: 44100,
        };
        assert!((buf.duration_secs() - 0.5).abs() < 1e-9);
    }

    #[test]
    fn wav_round_trip_preserves_layout_and_samples() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "rt.wav");
        let original = AudioBuffer {
            samples: vec![
                (0..500).map(|i| (i as f32 / 500.0) - 0.5).collect(),
                (0..500).map(|i| 0.5 - (i as f32 / 500.0)).collect(),
            ],
            sample_rate: 44100,
        };

        encode_wav(&original, &path, WavDepth::Float32, &Job::detached()).unwrap();
        let decoded = decode(&path).unwrap();

        assert_eq!(decoded.channels(), 2);
        assert_eq!(decoded.sample_rate, 44100);
        assert_eq!(decoded.num_frames(), 500);
        for ch in 0..2 {
            for f in 0..500 {
                assert!((decoded.samples[ch][f] - original.samples[ch][f]).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn wav_round_trip_mono() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "mono.wav");
        let original = AudioBuffer {
            samples: vec![vec![0.25f32; 128]],
            sample_rate: 8000,
        };
        encode_wav(&original, &path, WavDepth::Float32, &Job::detached()).unwrap();
        let decoded = decode(&path).unwrap();
        assert_eq!(decoded.channels(), 1);
        assert_eq!(decoded.sample_rate, 8000);
        assert_eq!(decoded.num_frames(), 128);
    }

    #[test]
    fn a_long_file_spanning_many_packets_decodes_completely() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "long.wav");
        let original = tone(200_000, 2, 44100);
        encode_wav(&original, &path, WavDepth::Float32, &Job::detached()).unwrap();
        let decoded = decode(&path).unwrap();
        assert_eq!(decoded.num_frames(), 200_000);
        assert_eq!(decoded.samples[1][199_999], original.samples[1][199_999]);
    }

    #[test]
    fn encode_wav_rejects_empty_buffer() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "empty.wav");
        let buf = AudioBuffer {
            samples: vec![],
            sample_rate: 44100,
        };
        assert!(encode_wav(&buf, &path, WavDepth::Float32, &Job::detached()).is_err());
    }

    #[test]
    fn encode_wav_truncates_to_shortest_channel() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "ragged.wav");
        let buf = AudioBuffer {
            samples: vec![vec![0.1f32; 10], vec![0.2f32; 3]],
            sample_rate: 44100,
        };
        encode_wav(&buf, &path, WavDepth::Float32, &Job::detached()).unwrap();
        let decoded = decode(&path).unwrap();
        assert_eq!(decoded.num_frames(), 3);
    }

    #[test]
    fn encode_wav_reports_unwritable_path() {
        let buf = AudioBuffer {
            samples: vec![vec![0.0f32; 4]],
            sample_rate: 44100,
        };
        let err = encode_wav(
            &buf,
            "/nonexistent-dir-lcs/out.wav",
            WavDepth::Float32,
            &Job::detached(),
        )
        .unwrap_err();
        assert_eq!(code_of(err), "cannot_write");
    }

    #[test]
    fn encode_wav_leaves_no_temporary_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "clean.wav");
        encode_wav(
            &tone(100, 1, 8000),
            &path,
            WavDepth::Float32,
            &Job::detached(),
        )
        .unwrap();
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn a_failed_export_keeps_the_file_it_would_have_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "keep.mp3");
        std::fs::write(&path, b"precious").unwrap();

        let err = encode_with(
            "/nonexistent-dir-lcs/ffmpeg",
            &tone(64, 1, 8000),
            &path,
            "mp3",
            &Tags::default(),
            &Job::detached(),
        )
        .unwrap_err();

        assert_eq!(code_of(err), "ffmpeg_missing");
        assert_eq!(std::fs::read(&path).unwrap(), b"precious");
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn an_output_without_a_file_name_is_rejected() {
        assert!(PartFile::new("/").is_err());
    }

    #[test]
    fn a_relative_output_is_staged_in_the_current_directory() {
        let part = PartFile::new("out.wav").unwrap();
        assert_eq!(part.path.parent().unwrap(), Path::new("."));
    }

    #[test]
    fn committing_to_a_missing_directory_is_a_write_error() {
        let dir = tempfile::tempdir().unwrap();
        let part = PartFile::new(&tmp_wav_path(&dir, "x.wav")).unwrap();
        std::fs::write(&part.path, b"data").unwrap();
        let err = part.commit("/nonexistent-dir-lcs/x.wav").unwrap_err();
        assert_eq!(code_of(err), "cannot_write");
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn decode_rejects_missing_file() {
        let err = decode("/nonexistent-dir-lcs/nope.wav").unwrap_err();
        assert_eq!(code_of(err), "cannot_open");
    }

    #[test]
    fn decode_rejects_non_audio_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "junk.wav");
        std::fs::write(&path, b"definitely not a wav file").unwrap();
        assert_eq!(code_of(decode(&path).unwrap_err()), "unsupported_format");
    }

    #[test]
    fn decode_rejects_a_wav_without_samples() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "silence.wav");
        let spec = WavSpec {
            channels: 1,
            sample_rate: 8000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        WavWriter::create(&path, spec).unwrap().finalize().unwrap();
        assert_eq!(code_of(decode(&path).unwrap_err()), "empty_audio");
    }

    // ── ffmpeg ──────────────────────────────────────────────────────────

    #[test]
    fn the_sidecar_is_found_next_to_the_executable() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::write(bin.join(SIDECAR_NAME), b"").unwrap();
        assert_eq!(
            locate_sidecar(&bin.join("app")),
            Some(bin.join(SIDECAR_NAME))
        );
    }

    #[test]
    fn the_sidecar_is_found_in_the_macos_resources_folder() {
        let dir = tempfile::tempdir().unwrap();
        let macos = dir.path().join("MacOS");
        let resources = dir.path().join("Resources");
        std::fs::create_dir(&macos).unwrap();
        std::fs::create_dir(&resources).unwrap();
        std::fs::write(resources.join(SIDECAR_NAME), b"").unwrap();
        assert_eq!(
            locate_sidecar(&macos.join("app")),
            Some(resources.join(SIDECAR_NAME))
        );
    }

    #[test]
    fn no_sidecar_means_no_path() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(locate_sidecar(&dir.path().join("app")), None);
        assert_eq!(locate_sidecar(Path::new("/")), None);
    }

    #[test]
    fn without_a_sidecar_the_path_lookup_is_used() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_ffmpeg(None, Some(&dir.path().join("app"))),
            "ffmpeg"
        );
        assert_eq!(resolve_ffmpeg(None, None), "ffmpeg");
    }

    #[test]
    fn the_bundled_sidecar_beats_the_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SIDECAR_NAME), b"").unwrap();
        let found = resolve_ffmpeg(None, Some(&dir.path().join("app")));
        assert_eq!(found, dir.path().join(SIDECAR_NAME).to_string_lossy());
    }

    #[test]
    fn the_environment_override_beats_everything() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SIDECAR_NAME), b"").unwrap();
        let found = resolve_ffmpeg(Some("/opt/ff/ffmpeg".into()), Some(&dir.path().join("app")));
        assert_eq!(found, "/opt/ff/ffmpeg");
    }

    #[test]
    fn a_blank_override_is_ignored() {
        assert_eq!(resolve_ffmpeg(Some("  ".into()), None), "ffmpeg");
        assert_eq!(resolve_ffmpeg(Some(String::new()), None), "ffmpeg");
    }

    #[test]
    fn every_export_format_fixes_its_container_and_encoder() {
        for (format, muxer, encoder) in [
            ("mp3", "mp3", "libmp3lame"),
            ("flac", "flac", "flac"),
            ("ogg", "ogg", "libvorbis"),
            ("m4a", "ipod", "aac"),
        ] {
            let (m, args) = ffmpeg_target(format).unwrap();
            assert_eq!(m, muxer);
            assert!(args.contains(&encoder), "{format}");
        }
    }

    #[test]
    fn an_unknown_export_format_is_refused() {
        let err = ffmpeg_target("xyz").unwrap_err();
        assert_eq!(code_of(err), "unknown_format");
    }

    #[test]
    fn a_missing_ffmpeg_binary_is_reported_as_such() {
        let dir = tempfile::tempdir().unwrap();
        let out = tmp_wav_path(&dir, "out.mp3");
        let err = encode_with(
            "/nonexistent-dir-lcs/ffmpeg",
            &tone(64, 1, 8000),
            &out,
            "mp3",
            &Tags::default(),
            &Job::detached(),
        )
        .unwrap_err();
        assert_eq!(code_of(err), "ffmpeg_missing");
    }

    #[test]
    fn an_empty_buffer_is_not_sent_to_ffmpeg() {
        let dir = tempfile::tempdir().unwrap();
        let out = tmp_wav_path(&dir, "out.mp3");
        let buf = AudioBuffer {
            samples: vec![],
            sample_rate: 44100,
        };
        assert!(encode_with(
            "ffmpeg",
            &buf,
            &out,
            "mp3",
            &Tags::default(),
            &Job::detached()
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn an_ffmpeg_failure_reports_its_last_stderr_line() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake-ffmpeg");
        std::fs::write(
            &fake,
            "#!/bin/sh\ncat >/dev/null\necho first >&2\necho boom >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let out = tmp_wav_path(&dir, "out.mp3");

        let err = encode_with(
            fake.to_str().unwrap(),
            &tone(64, 1, 8000),
            &out,
            "mp3",
            &Tags::default(),
            &Job::detached(),
        )
        .unwrap_err();

        let e = CmdError::from(err);
        assert_eq!(e.code, "ffmpeg_failed");
        assert_eq!(e.params["detail"], "boom");
        assert!(!Path::new(&out).exists());
        assert!(leftovers(&dir).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn an_ffmpeg_that_quits_before_reading_everything_is_a_failure_not_a_hang() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake-ffmpeg");
        std::fs::write(&fake, "#!/bin/sh\necho early >&2\nexit 3\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let out = tmp_wav_path(&dir, "out.mp3");

        let err = encode_with(
            fake.to_str().unwrap(),
            &tone(500_000, 2, 44100),
            &out,
            "mp3",
            &Tags::default(),
            &Job::detached(),
        )
        .unwrap_err();

        assert_eq!(code_of(err), "ffmpeg_failed");
    }

    #[test]
    fn real_ffmpeg_writes_every_format_whatever_the_file_name() {
        if !system_ffmpeg() {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let src = tone(44_100, 2, 44100);
        for format in ["mp3", "flac", "ogg", "m4a"] {
            // No extension at all: the container must come from `format`.
            let out = tmp_wav_path(&dir, &format!("noext-{format}"));
            encode_via_ffmpeg(&src, &out, format, &Tags::default(), &Job::detached()).unwrap();
            let mut hint_path = out.clone();
            hint_path.push_str(&format!(".{format}"));
            std::fs::rename(&out, &hint_path).unwrap();

            let back = decode(&hint_path).unwrap();
            assert_eq!(back.channels(), 2, "{format}");
            assert_eq!(back.sample_rate, 44100, "{format}");
            let secs = back.duration_secs();
            assert!((secs - 1.0).abs() < 0.1, "{format}: {secs}s");
        }
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn real_ffmpeg_replaces_an_existing_file() {
        if !system_ffmpeg() {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let out = tmp_wav_path(&dir, "again.flac");
        std::fs::write(&out, b"old").unwrap();
        encode_via_ffmpeg(
            &tone(8000, 1, 8000),
            &out,
            "flac",
            &Tags::default(),
            &Job::detached(),
        )
        .unwrap();
        assert!(std::fs::metadata(&out).unwrap().len() > 3);
        assert_eq!(decode(&out).unwrap().channels(), 1);
    }

    #[test]
    fn a_cancelled_wav_export_leaves_nothing_behind() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "cancelled.wav");
        let job = Job::new(Arc::new(AtomicBool::new(true)), |_| {});

        let err = encode_wav(&tone(200_000, 1, 44100), &path, WavDepth::Float32, &job).unwrap_err();

        assert_eq!(code_of(err), "cancelled");
        assert!(!Path::new(&path).exists());
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn a_cancelled_wav_export_keeps_the_file_it_would_have_replaced() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "keep.wav");
        std::fs::write(&path, b"precious").unwrap();
        let job = Job::new(Arc::new(AtomicBool::new(true)), |_| {});

        assert!(encode_wav(&tone(1000, 1, 8000), &path, WavDepth::Float32, &job).is_err());

        assert_eq!(std::fs::read(&path).unwrap(), b"precious");
    }

    #[test]
    fn real_ffmpeg_export_can_be_cancelled_without_leaving_a_file() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        if !system_ffmpeg() {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let out = tmp_wav_path(&dir, "cancelled.mp3");
        let job = Job::new(Arc::new(AtomicBool::new(true)), |_| {});

        let err = encode_via_ffmpeg(
            &tone(100_000, 2, 44100),
            &out,
            "mp3",
            &Tags::default(),
            &job,
        )
        .unwrap_err();

        assert_eq!(code_of(err), "cancelled");
        assert!(!Path::new(&out).exists());
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn writing_reports_progress_up_to_the_last_block() {
        use std::sync::atomic::AtomicBool;
        use std::sync::{Arc, Mutex};
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let job = Job::new(Arc::new(AtomicBool::new(false)), move |f| {
            sink.lock().unwrap().push(f)
        });
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "progress.wav");

        encode_wav(
            &tone(WRITE_BLOCK_FRAMES * 3, 1, 8000),
            &path,
            WavDepth::Float32,
            &job,
        )
        .unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[0], 0.0);
        assert!(seen.windows(2).all(|w| w[0] < w[1]));
    }

    // ── WAV bit depth ───────────────────────────────────────────────────

    fn read_wav_spec(path: &str) -> WavSpec {
        hound::WavReader::open(path).unwrap().spec()
    }

    #[test]
    fn the_wav_depth_is_parsed_by_name() {
        assert_eq!(WavDepth::parse("float32").unwrap(), WavDepth::Float32);
        assert_eq!(WavDepth::parse("pcm24").unwrap(), WavDepth::Pcm24);
        assert_eq!(WavDepth::parse("pcm16").unwrap(), WavDepth::Pcm16);
        assert_eq!(WavDepth::default(), WavDepth::Float32);
        assert_eq!(code_of(WavDepth::parse("pcm8").unwrap_err()), "wav_depth");
    }

    #[test]
    fn each_depth_writes_its_own_sample_format() {
        let dir = tempfile::tempdir().unwrap();
        let src = tone(2000, 2, 44100);
        for (depth, bits, format) in [
            (WavDepth::Float32, 32, SampleFormat::Float),
            (WavDepth::Pcm24, 24, SampleFormat::Int),
            (WavDepth::Pcm16, 16, SampleFormat::Int),
        ] {
            let path = tmp_wav_path(&dir, &format!("{bits}.wav"));
            encode_wav(&src, &path, depth, &Job::detached()).unwrap();
            let spec = read_wav_spec(&path);
            assert_eq!(spec.bits_per_sample, bits);
            assert_eq!(spec.sample_format, format);
            assert_eq!(spec.channels, 2);
        }
    }

    #[test]
    fn narrower_files_are_smaller() {
        let dir = tempfile::tempdir().unwrap();
        let src = tone(10_000, 1, 44100);
        let size = |depth, name: &str| {
            let path = tmp_wav_path(&dir, name);
            encode_wav(&src, &path, depth, &Job::detached()).unwrap();
            std::fs::metadata(path).unwrap().len()
        };
        let (f32_, i24, i16_) = (
            size(WavDepth::Float32, "a.wav"),
            size(WavDepth::Pcm24, "b.wav"),
            size(WavDepth::Pcm16, "c.wav"),
        );
        assert!(f32_ > i24 && i24 > i16_, "{f32_} {i24} {i16_}");
    }

    #[test]
    fn pcm24_is_accurate_to_a_24_bit_step() {
        let dir = tempfile::tempdir().unwrap();
        let src = tone(5000, 1, 44100);
        let path = tmp_wav_path(&dir, "i24.wav");
        encode_wav(&src, &path, WavDepth::Pcm24, &Job::detached()).unwrap();
        let back = decode(&path).unwrap();
        let worst = src.samples[0]
            .iter()
            .zip(&back.samples[0])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 2.0 / 8_388_607.0, "{worst}");
    }

    #[test]
    fn pcm16_stays_within_a_few_16_bit_steps_of_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let src = tone(5000, 1, 44100);
        let path = tmp_wav_path(&dir, "i16.wav");
        encode_wav(&src, &path, WavDepth::Pcm16, &Job::detached()).unwrap();
        let back = decode(&path).unwrap();
        let worst = src.samples[0]
            .iter()
            .zip(&back.samples[0])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        // Rounding is half a step, the dither up to one more.
        assert!(worst <= 2.0 / 32_767.0, "{worst}");
        assert!(worst > 0.0, "a 16-bit file cannot be bit-exact");
    }

    #[test]
    fn dither_decorrelates_the_error_from_the_signal() {
        // A constant 0.3 LSB: plain rounding would give a constant 0 (all the
        // error, 100 % correlated); dithered, the average comes back to 0.3.
        let dir = tempfile::tempdir().unwrap();
        let level = 0.3 / 32_767.0;
        let src = AudioBuffer {
            samples: vec![vec![level; 20_000]],
            sample_rate: 8000,
        };
        let path = tmp_wav_path(&dir, "dc.wav");
        encode_wav(&src, &path, WavDepth::Pcm16, &Job::detached()).unwrap();
        let back = decode(&path).unwrap();
        let mean = back.samples[0].iter().sum::<f32>() / back.samples[0].len() as f32 * 32_767.0;
        assert!((mean - 0.3).abs() < 0.05, "mean {mean}");
        let distinct: std::collections::HashSet<i32> = back.samples[0]
            .iter()
            .map(|s| (s * 32_767.0).round() as i32)
            .collect();
        assert!(distinct.len() >= 2);
    }

    #[test]
    fn dither_is_reproducible_and_differs_between_channels() {
        let dir = tempfile::tempdir().unwrap();
        let src = AudioBuffer {
            samples: vec![vec![0.3 / 32_767.0; 4000]; 2],
            sample_rate: 8000,
        };
        let write = |name: &str| {
            let path = tmp_wav_path(&dir, name);
            encode_wav(&src, &path, WavDepth::Pcm16, &Job::detached()).unwrap();
            std::fs::read(path).unwrap()
        };
        assert_eq!(write("one.wav"), write("two.wav"));
        let back = decode(&tmp_wav_path(&dir, "one.wav")).unwrap();
        assert_ne!(back.samples[0], back.samples[1]);
    }

    #[test]
    fn levels_beyond_full_scale_clip_instead_of_wrapping() {
        let dir = tempfile::tempdir().unwrap();
        let src = AudioBuffer {
            samples: vec![vec![1.6, -1.6, 0.5]],
            sample_rate: 8000,
        };
        for depth in [WavDepth::Pcm24, WavDepth::Pcm16] {
            let path = tmp_wav_path(&dir, "clip.wav");
            encode_wav(&src, &path, depth, &Job::detached()).unwrap();
            let back = decode(&path).unwrap();
            assert!(back.samples[0][0] > 0.99, "{depth:?} {:?}", back.samples[0]);
            assert!(back.samples[0][1] < -0.99, "{depth:?}");
            assert!((back.samples[0][2] - 0.5).abs() < 0.01, "{depth:?}");
        }
    }

    #[test]
    fn quantize_covers_the_whole_range_without_overflow() {
        assert_eq!(quantize(1.0, 16, 0.0), 32767);
        assert_eq!(quantize(-1.0, 16, 0.0), -32767);
        assert_eq!(quantize(-5.0, 16, 0.0), -32768);
        assert_eq!(quantize(5.0, 24, 0.0), 8_388_607);
        assert_eq!(quantize(f32::NAN, 16, 0.0), 0);
    }

    // ── ffmpeg command line, tags and cover ─────────────────────────────

    fn args_for(tags: &Tags, cover: Option<&Path>, muxer: &str) -> Vec<String> {
        let buf = tone(10, 2, 44100);
        ffmpeg_args(
            &buf,
            muxer,
            &["-c:a", "x"],
            tags,
            cover,
            Path::new("/o/.out.part"),
        )
    }

    #[test]
    fn the_command_line_describes_the_raw_input_and_the_fixed_output() {
        let args = args_for(&Tags::default(), None, "flac");
        let joined = args.join(" ");
        assert!(joined.starts_with("-y -v error -f f32le -ar 44100 -ac 2 -i pipe:0"));
        assert!(joined.ends_with("-c:a x -f flac file:/o/.out.part"));
        assert!(!joined.contains("-metadata"));
        assert!(!joined.contains("attached_pic"));
    }

    #[test]
    fn tags_become_metadata_options_whose_values_stay_one_argument() {
        let tags = Tags {
            pairs: vec![("title", "A; b = c \"d\"".into()), ("artist", "Me".into())],
            cover: None,
        };
        let args = args_for(&tags, None, "ogg");
        let at = args.iter().position(|a| a == "-metadata").unwrap();
        assert_eq!(args[at + 1], "title=A; b = c \"d\"");
        assert_eq!(args[at + 3], "artist=Me");
    }

    #[test]
    fn a_cover_is_a_second_input_attached_as_a_picture() {
        let args = args_for(&Tags::default(), Some(Path::new("/o/.c.jpg")), "mp3");
        let joined = args.join(" ");
        assert!(joined.contains("-i file:/o/.c.jpg -map 0:a -map 1:v -c:v copy"));
        assert!(joined.contains("-disposition:v:0 attached_pic"));
    }

    #[test]
    fn only_mp3_asks_for_id3v23() {
        assert!(args_for(&Tags::default(), None, "mp3")
            .join(" ")
            .contains("-id3v2_version 3"));
        assert!(!args_for(&Tags::default(), None, "flac")
            .join(" ")
            .contains("id3v2"));
    }

    #[test]
    fn ogg_cannot_carry_a_cover() {
        assert!(muxer_takes_cover("mp3") && muxer_takes_cover("flac") && muxer_takes_cover("ipod"));
        assert!(!muxer_takes_cover("ogg"));
    }

    #[test]
    fn a_cover_file_is_staged_beside_the_output_and_cleaned_up() {
        let dir = tempfile::tempdir().unwrap();
        let out = tmp_wav_path(&dir, "song.mp3");
        let cover = crate::tags::Cover {
            data: b"png bytes".to_vec(),
            ext: "png",
        };
        let staged = CoverFile::write(&out, &cover).unwrap();
        let path = staged.0.clone();
        assert!(path.starts_with(dir.path()));
        assert_eq!(path.extension().unwrap(), "png");
        assert_eq!(std::fs::read(&path).unwrap(), b"png bytes");
        drop(staged);
        assert!(!path.exists());
    }

    #[test]
    fn an_unwritable_cover_location_just_drops_the_cover() {
        let cover = crate::tags::Cover {
            data: vec![1],
            ext: "jpg",
        };
        assert!(CoverFile::write("/nonexistent-dir-lcs/song.mp3", &cover).is_none());
    }

    /// A tagged MP3 with a cover, made by the system ffmpeg.
    fn tagged_source(dir: &tempfile::TempDir) -> String {
        let cover = tmp_wav_path(dir, "cover.png");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=32x32",
                "-frames:v",
                "1",
            ])
            .arg(&cover)
            .status()
            .unwrap();
        assert!(status.success());
        let src = tmp_wav_path(dir, "source.mp3");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
            ])
            .args(["-i", &cover, "-map", "0:a", "-map", "1:v", "-c:v", "copy"])
            .args(["-disposition:v:0", "attached_pic", "-id3v2_version", "3"])
            .args([
                "-metadata",
                "title=Round Trip",
                "-metadata",
                "artist=The Tests",
            ])
            .args([
                "-metadata",
                "album=Suite",
                "-metadata",
                "date=2024",
                "-metadata",
                "genre=Test",
            ])
            .arg(&src)
            .status()
            .unwrap();
        assert!(status.success());
        src
    }

    #[test]
    fn real_tags_and_cover_survive_a_conversion() {
        if !system_ffmpeg() {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let src = tagged_source(&dir);
        let tags = crate::tags::read(&src);
        assert!(
            tags.pairs.contains(&("title", "Round Trip".to_string())),
            "{tags:?}"
        );
        assert!(tags.cover.is_some(), "the fixture must carry a cover");
        let audio = decode(&src).unwrap();

        for (format, ext, covers) in [
            ("mp3", "mp3", true),
            ("flac", "flac", true),
            ("m4a", "m4a", true),
            ("ogg", "ogg", false),
        ] {
            let out = tmp_wav_path(&dir, &format!("out.{ext}"));
            encode_via_ffmpeg(&audio, &out, format, &tags, &Job::detached()).unwrap();

            let back = crate::tags::read(&out);
            for (key, value) in [
                ("title", "Round Trip"),
                ("artist", "The Tests"),
                ("album", "Suite"),
            ] {
                assert!(
                    back.pairs.contains(&(key, value.to_string())),
                    "{format}: {key} lost: {back:?}"
                );
            }
            assert_eq!(back.cover.is_some(), covers, "{format}: cover");
        }
        assert!(leftovers(&dir).is_empty());
        // The staged cover files are gone too.
        let stray: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".cover."))
            .collect();
        assert!(stray.is_empty());
    }

    #[test]
    fn a_wav_export_still_works_for_a_tagged_source() {
        if !system_ffmpeg() {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let src = tagged_source(&dir);
        let out = tmp_wav_path(&dir, "out.wav");
        encode_wav(
            &decode(&src).unwrap(),
            &out,
            WavDepth::Pcm16,
            &Job::detached(),
        )
        .unwrap();
        assert_eq!(decode(&out).unwrap().channels(), 1);
    }

    #[test]
    fn write_pcm_interleaves_little_endian_floats() {
        let buf = AudioBuffer {
            samples: vec![vec![1.0, 2.0], vec![3.0, 4.0]],
            sample_rate: 8000,
        };
        let mut out = Vec::new();
        write_pcm(&mut out, &buf, &Job::detached()).unwrap();
        let floats: Vec<f32> = out
            .chunks(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        assert_eq!(floats, vec![1.0, 3.0, 2.0, 4.0]);
    }

    #[test]
    fn write_pcm_handles_more_than_one_block() {
        let buf = tone(10_000, 1, 8000);
        let mut out = Vec::new();
        write_pcm(&mut out, &buf, &Job::detached()).unwrap();
        assert_eq!(out.len(), 10_000 * 4);
    }
}
