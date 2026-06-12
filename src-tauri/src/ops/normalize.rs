use crate::audio::AudioBuffer;
use anyhow::{bail, Result};

pub fn normalize(buf: &mut AudioBuffer) -> Result<()> {
    let peak = buf
        .samples
        .iter()
        .flat_map(|ch| ch.iter())
        .map(|s| s.abs())
        .fold(0.0f32, f32::max);

    if peak < 1e-8 {
        bail!("Audio is silent, cannot normalize");
    }
    for ch in buf.samples.iter_mut() {
        for s in ch.iter_mut() {
            *s /= peak;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioBuffer;

    #[test]
    fn normalize_peak_becomes_one() {
        let mut buf = AudioBuffer {
            samples: vec![vec![0.0, 0.25, 0.5, -0.5, 0.1]],
            sample_rate: 44100,
            channels: 1,
        };
        normalize(&mut buf).unwrap();
        let peak = buf.samples[0]
            .iter()
            .map(|s| s.abs())
            .fold(0.0f32, f32::max);
        assert!((peak - 1.0).abs() < 1e-6);
    }

    #[test]
    fn normalize_silent_errors() {
        let mut buf = AudioBuffer {
            samples: vec![vec![0.0; 100]],
            sample_rate: 44100,
            channels: 1,
        };
        assert!(normalize(&mut buf).is_err());
    }

    #[test]
    fn normalize_multichannel() {
        let mut buf = AudioBuffer {
            samples: vec![vec![0.25; 10], vec![0.1; 10]],
            sample_rate: 44100,
            channels: 2,
        };
        normalize(&mut buf).unwrap();
        let peak = buf
            .samples
            .iter()
            .flat_map(|ch| ch.iter())
            .map(|s| s.abs())
            .fold(0.0f32, f32::max);
        assert!((peak - 1.0).abs() < 1e-6);
    }
}
