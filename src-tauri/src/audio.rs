use anyhow::{bail, Context, Result};
use hound::{SampleFormat, WavSpec, WavWriter};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub struct AudioBuffer {
    pub samples: Vec<Vec<f32>>,
    pub sample_rate: u32,
    pub channels: usize,
}

impl AudioBuffer {
    pub fn num_frames(&self) -> usize {
        self.samples.first().map(|ch| ch.len()).unwrap_or(0)
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

    let sample_rate = codec_params.sample_rate.context("Unknown sample rate")?;
    let channels = codec_params.channels.map(|c| c.count()).unwrap_or(2);

    let dec_opts = DecoderOptions::default();
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &dec_opts)
        .context("Unsupported codec")?;

    let mut channel_samples: Vec<Vec<f32>> = vec![Vec::new(); channels];

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
                let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                sample_buf.copy_interleaved_ref(decoded);
                let samples = sample_buf.samples();
                let n_ch = spec.channels.count();
                for (i, s) in samples.iter().enumerate() {
                    channel_samples[i % n_ch].push(*s);
                }
            }
            Err(symphonia::core::errors::Error::IoError(_)) => break,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        }
    }

    if channel_samples.iter().all(|ch| ch.is_empty()) {
        bail!("Decoded audio is empty");
    }

    Ok(AudioBuffer {
        samples: channel_samples,
        sample_rate,
        channels,
    })
}

pub fn encode_wav(buf: &AudioBuffer, path: &str) -> Result<()> {
    let spec = WavSpec {
        channels: buf.channels as u16,
        sample_rate: buf.sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut writer =
        WavWriter::create(path, spec).with_context(|| format!("Cannot create WAV '{path}'"))?;

    let frames = buf.num_frames();
    for f in 0..frames {
        for ch in 0..buf.channels {
            writer.write_sample(buf.samples[ch][f])?;
        }
    }
    writer.finalize()?;
    Ok(())
}

fn find_ffmpeg() -> String {
    if let Ok(exe) = std::env::current_exe() {
        // macOS app bundle: Contents/MacOS/exe → Contents/MacOS/ffmpeg
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("ffmpeg");
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
        }
        // macOS app bundle: Contents/MacOS/exe → Contents/Resources/ffmpeg
        if let Some(resources) = exe
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("Resources").join("ffmpeg"))
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
    let tmp_path = tmp.path().to_str().unwrap().to_string();

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
