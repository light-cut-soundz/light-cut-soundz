use crate::audio::AudioBuffer;
use anyhow::{bail, Result};

/// −1 dBFS. Leaving a decibel of headroom keeps the inter-sample peaks that
/// MP3 and OGG encoders introduce below full scale.
pub const TARGET_PEAK: f32 = 0.891_250_9;

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
    let gain = TARGET_PEAK / peak;
    for ch in buf.samples.iter_mut() {
        for s in ch.iter_mut() {
            *s *= gain;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioBuffer;

    fn peak_of(buf: &AudioBuffer) -> f32 {
        buf.samples
            .iter()
            .flat_map(|ch| ch.iter())
            .map(|s| s.abs())
            .fold(0.0f32, f32::max)
    }

    #[test]
    fn normalize_reaches_the_target_peak() {
        let mut buf = AudioBuffer {
            samples: vec![vec![0.0, 0.25, 0.5, -0.5, 0.1]],
            sample_rate: 44100,
        };
        normalize(&mut buf).unwrap();
        assert!((peak_of(&buf) - TARGET_PEAK).abs() < 1e-6);
    }

    #[test]
    fn normalize_leaves_headroom_below_full_scale() {
        let mut buf = AudioBuffer {
            samples: vec![vec![0.9, -0.95, 0.3]],
            sample_rate: 44100,
        };
        normalize(&mut buf).unwrap();
        assert!(peak_of(&buf) < 1.0);
    }

    #[test]
    fn normalize_attenuates_signals_already_at_full_scale() {
        let mut buf = AudioBuffer {
            samples: vec![vec![1.0, -1.0, 0.5]],
            sample_rate: 44100,
        };
        normalize(&mut buf).unwrap();
        assert!((peak_of(&buf) - TARGET_PEAK).abs() < 1e-6);
    }

    #[test]
    fn normalize_silent_errors() {
        let mut buf = AudioBuffer {
            samples: vec![vec![0.0; 100]],
            sample_rate: 44100,
        };
        assert!(normalize(&mut buf).is_err());
    }

    #[test]
    fn normalize_empty_errors() {
        let mut buf = AudioBuffer {
            samples: vec![],
            sample_rate: 44100,
        };
        assert!(normalize(&mut buf).is_err());
    }

    #[test]
    fn normalize_multichannel() {
        let mut buf = AudioBuffer {
            samples: vec![vec![0.25; 10], vec![0.1; 10]],
            sample_rate: 44100,
        };
        normalize(&mut buf).unwrap();
        assert!((peak_of(&buf) - TARGET_PEAK).abs() < 1e-6);
    }

    #[test]
    fn normalize_preserves_the_channel_balance() {
        let mut buf = AudioBuffer {
            samples: vec![vec![0.4; 4], vec![0.2; 4]],
            sample_rate: 44100,
        };
        normalize(&mut buf).unwrap();
        let ratio = buf.samples[0][0] / buf.samples[1][0];
        assert!((ratio - 2.0).abs() < 1e-5);
    }

    #[test]
    fn normalize_preserves_sign() {
        let mut buf = AudioBuffer {
            samples: vec![vec![0.5, -0.25]],
            sample_rate: 44100,
        };
        normalize(&mut buf).unwrap();
        assert!(buf.samples[0][0] > 0.0);
        assert!(buf.samples[0][1] < 0.0);
    }
}
