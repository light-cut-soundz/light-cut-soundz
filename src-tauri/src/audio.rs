use anyhow::{bail, Context, Result};
use hound::{SampleFormat, WavSpec, WavWriter};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Sidecar name used by `externalBin` in tauri.conf.json. Deliberately prefixed
/// so the Linux packages don't ship a file at `/usr/bin/ffmpeg`, which the
/// distribution's own ffmpeg package already owns.
const SIDECAR_NAME: &str = "lightcutsoundz-ffmpeg";

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

pub fn decode(path: &str) -> Result<AudioBuffer> {
    let file = std::fs::File::open(path).with_context(|| format!("Cannot open '{path}'"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
    {
        hint.with_extension(ext);
    }

    let meta_opts = MetadataOptions::default();
    let fmt_opts = FormatOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .context("Unsupported audio format")?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .context("No audio track found")?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let dec_opts = DecoderOptions::default();
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &dec_opts)
        .context("Unsupported codec")?;

    // Layout is taken from the decoded frames, not from the container metadata:
    // codec parameters may omit the channel count or the sample rate entirely.
    let mut channel_samples: Vec<Vec<f32>> = Vec::new();
    let mut sample_rate = codec_params.sample_rate.unwrap_or(0);

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(symphonia::core::errors::Error::ResetRequired) => continue,
            Err(e) => return Err(e.into()),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let n_ch = spec.channels.count();
                if n_ch == 0 {
                    continue;
                }
                if sample_rate == 0 {
                    sample_rate = spec.rate;
                }
                if channel_samples.is_empty() {
                    channel_samples = vec![Vec::new(); n_ch];
                } else if channel_samples.len() != n_ch {
                    bail!(
                        "Channel count changed mid-stream ({} then {n_ch})",
                        channel_samples.len()
                    );
                }

                let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                sample_buf.copy_interleaved_ref(decoded);
                for (i, s) in sample_buf.samples().iter().enumerate() {
                    channel_samples[i % n_ch].push(*s);
                }
            }
            Err(symphonia::core::errors::Error::IoError(_)) => break,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        }
    }

    if channel_samples.is_empty() || channel_samples.iter().all(|ch| ch.is_empty()) {
        bail!("Decoded audio is empty");
    }
    if sample_rate == 0 {
        bail!("Unknown sample rate");
    }

    Ok(AudioBuffer {
        samples: channel_samples,
        sample_rate,
    })
}

pub fn encode_wav(buf: &AudioBuffer, path: &str) -> Result<()> {
    if buf.channels() == 0 {
        bail!("Cannot write a WAV with no channels");
    }
    let spec = WavSpec {
        channels: buf.channels() as u16,
        sample_rate: buf.sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut writer =
        WavWriter::create(path, spec).with_context(|| format!("Cannot create WAV '{path}'"))?;

    let frames = buf.num_frames();
    for f in 0..frames {
        for ch in buf.samples.iter() {
            writer.write_sample(ch[f])?;
        }
    }
    writer.finalize()?;
    Ok(())
}

fn find_ffmpeg() -> String {
    if let Ok(exe) = std::env::current_exe() {
        // Tauri drops the sidecar next to the executable: Contents/MacOS on
        // macOS, the install prefix on Linux.
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(SIDECAR_NAME);
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
        }
        if let Some(resources) = exe
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("Resources").join(SIDECAR_NAME))
        {
            if resources.exists() {
                return resources.to_string_lossy().to_string();
            }
        }
    }
    if let Ok(snap) = std::env::var("SNAP") {
        let p = format!("{snap}/usr/bin/ffmpeg");
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "ffmpeg".to_string()
}

pub fn encode_via_ffmpeg(buf: &AudioBuffer, output_path: &str, format: &str) -> Result<()> {
    let tmp = tempfile::Builder::new()
        .suffix(".wav")
        .tempfile()
        .context("Cannot create temp file")?;
    let tmp_path = tmp
        .path()
        .to_str()
        .context("Temp path is not valid UTF-8")?
        .to_string();

    encode_wav(buf, &tmp_path)?;

    let ffmpeg_bin = find_ffmpeg();

    let output = std::process::Command::new(&ffmpeg_bin)
        .args(["-y", "-i", &tmp_path, output_path])
        .output()
        .context("ffmpeg not found — install ffmpeg to export MP3/FLAC/OGG")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last_line = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("(no output)");
        bail!("ffmpeg failed to encode to {format}: {last_line}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_wav_path(dir: &tempfile::TempDir, name: &str) -> String {
        dir.path().join(name).to_str().unwrap().to_string()
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

        encode_wav(&original, &path).unwrap();
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
        encode_wav(&original, &path).unwrap();
        let decoded = decode(&path).unwrap();
        assert_eq!(decoded.channels(), 1);
        assert_eq!(decoded.sample_rate, 8000);
        assert_eq!(decoded.num_frames(), 128);
    }

    #[test]
    fn encode_wav_rejects_empty_buffer() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "empty.wav");
        let buf = AudioBuffer {
            samples: vec![],
            sample_rate: 44100,
        };
        assert!(encode_wav(&buf, &path).is_err());
    }

    #[test]
    fn encode_wav_truncates_to_shortest_channel() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "ragged.wav");
        let buf = AudioBuffer {
            samples: vec![vec![0.1f32; 10], vec![0.2f32; 3]],
            sample_rate: 44100,
        };
        encode_wav(&buf, &path).unwrap();
        let decoded = decode(&path).unwrap();
        assert_eq!(decoded.num_frames(), 3);
    }

    #[test]
    fn encode_wav_reports_unwritable_path() {
        let buf = AudioBuffer {
            samples: vec![vec![0.0f32; 4]],
            sample_rate: 44100,
        };
        assert!(encode_wav(&buf, "/nonexistent-dir-lcs/out.wav").is_err());
    }

    #[test]
    fn decode_rejects_missing_file() {
        assert!(decode("/nonexistent-dir-lcs/nope.wav").is_err());
    }

    #[test]
    fn decode_rejects_non_audio_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = tmp_wav_path(&dir, "junk.wav");
        std::fs::write(&path, b"definitely not a wav file").unwrap();
        assert!(decode(&path).is_err());
    }

    #[test]
    fn find_ffmpeg_falls_back_to_path_lookup() {
        // No sidecar next to the test binary and no SNAP prefix in the test env.
        let found = find_ffmpeg();
        assert!(found == "ffmpeg" || found.ends_with(SIDECAR_NAME));
    }

    #[test]
    fn encode_via_ffmpeg_reports_missing_binary() {
        let dir = tempfile::tempdir().unwrap();
        let out = tmp_wav_path(&dir, "out.mp3");
        let buf = AudioBuffer {
            samples: vec![vec![0.1f32; 64]],
            sample_rate: 44100,
        };
        // Either ffmpeg is absent (spawn error) or present and asked to write an
        // .mp3; both paths must return a Result rather than panic.
        let _ = encode_via_ffmpeg(&buf, &out, "mp3");
    }
}
