use crate::audio::AudioBuffer;
use anyhow::{bail, Result};
use std::f64::consts::{FRAC_1_SQRT_2, PI};

#[derive(Clone)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn process(&mut self, x: f32) -> f32 {
        let x = x as f64;
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y as f32
    }

    fn low_pass(sample_rate: u32, cutoff_hz: f64) -> Result<Self> {
        let sr = sample_rate as f64;
        if cutoff_hz <= 0.0 || cutoff_hz >= sr / 2.0 {
            bail!(
                "Low-pass cutoff {cutoff_hz}Hz out of range (0, {})",
                sr / 2.0
            );
        }
        let q = FRAC_1_SQRT_2;
        let w0 = 2.0 * PI * cutoff_hz / sr;
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let b0 = (1.0 - cos_w0) / 2.0;
        let b1 = 1.0 - cos_w0;
        let b2 = (1.0 - cos_w0) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha;
        Ok(Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        })
    }

    fn high_pass(sample_rate: u32, cutoff_hz: f64) -> Result<Self> {
        let sr = sample_rate as f64;
        if cutoff_hz <= 0.0 || cutoff_hz >= sr / 2.0 {
            bail!(
                "High-pass cutoff {cutoff_hz}Hz out of range (0, {})",
                sr / 2.0
            );
        }
        let q = FRAC_1_SQRT_2;
        let w0 = 2.0 * PI * cutoff_hz / sr;
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let b0 = (1.0 + cos_w0) / 2.0;
        let b1 = -(1.0 + cos_w0);
        let b2 = (1.0 + cos_w0) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha;
        Ok(Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        })
    }

    fn band_pass(sample_rate: u32, center_hz: f64, bandwidth_hz: f64) -> Result<Self> {
        let sr = sample_rate as f64;
        if center_hz <= 0.0 || center_hz >= sr / 2.0 {
            bail!("Band-pass center {center_hz}Hz out of range");
        }
        if bandwidth_hz <= 0.0 {
            bail!("Band-pass bandwidth must be positive");
        }
        let q = center_hz / bandwidth_hz;
        let w0 = 2.0 * PI * center_hz / sr;
        let alpha = w0.sin() / (2.0 * q);
        let b0 = alpha;
        let b1 = 0.0;
        let b2 = -alpha;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * w0.cos();
        let a2 = 1.0 - alpha;
        Ok(Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        })
    }
}

#[allow(clippy::enum_variant_names)]
pub enum FilterSpec {
    LowPass { cutoff_hz: f64 },
    HighPass { cutoff_hz: f64 },
    BandPass { center_hz: f64, bandwidth_hz: f64 },
}

impl FilterSpec {
    pub fn parse(s: &str) -> Result<Self> {
        let parts: Vec<&str> = s.splitn(3, ':').collect();
        match parts.as_slice() {
            ["lowpass", hz] => Ok(Self::LowPass { cutoff_hz: hz.parse()? }),
            ["highpass", hz] => Ok(Self::HighPass { cutoff_hz: hz.parse()? }),
            ["bandpass", center, bw] => Ok(Self::BandPass {
                center_hz: center.parse()?,
                bandwidth_hz: bw.parse()?,
            }),
            _ => bail!("Invalid filter spec '{s}'. Use: lowpass:<hz> | highpass:<hz> | bandpass:<hz>:<bw_hz>"),
        }
    }
}

pub fn apply_filter(buf: &mut AudioBuffer, spec: &FilterSpec) -> Result<()> {
    let mut filters: Vec<Biquad> = (0..buf.channels())
        .map(|_| match spec {
            FilterSpec::LowPass { cutoff_hz } => Biquad::low_pass(buf.sample_rate, *cutoff_hz),
            FilterSpec::HighPass { cutoff_hz } => Biquad::high_pass(buf.sample_rate, *cutoff_hz),
            FilterSpec::BandPass {
                center_hz,
                bandwidth_hz,
            } => Biquad::band_pass(buf.sample_rate, *center_hz, *bandwidth_hz),
        })
        .collect::<Result<Vec<_>>>()?;

    let frames = buf.num_frames();
    for f in 0..frames {
        for (ch, filt) in filters.iter_mut().enumerate() {
            buf.samples[ch][f] = filt.process(buf.samples[ch][f]);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioBuffer;

    const SR: u32 = 44100;

    fn sine(freq: f64, frames: usize, channels: usize) -> AudioBuffer {
        let ch: Vec<f32> = (0..frames)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / SR as f64).sin() as f32)
            .collect();
        AudioBuffer {
            samples: vec![ch; channels],
            sample_rate: SR,
        }
    }

    /// Peak of the second half, once the biquad has settled.
    fn settled_peak(buf: &AudioBuffer, ch: usize) -> f32 {
        let n = buf.samples[ch].len();
        buf.samples[ch][n / 2..]
            .iter()
            .map(|s| s.abs())
            .fold(0.0f32, f32::max)
    }

    #[test]
    fn parse_lowpass() {
        let spec = FilterSpec::parse("lowpass:4000").unwrap();
        assert!(
            matches!(spec, FilterSpec::LowPass { cutoff_hz } if (cutoff_hz - 4000.0).abs() < 1e-6)
        );
    }

    #[test]
    fn parse_highpass() {
        let spec = FilterSpec::parse("highpass:2000").unwrap();
        assert!(
            matches!(spec, FilterSpec::HighPass { cutoff_hz } if (cutoff_hz - 2000.0).abs() < 1e-6)
        );
    }

    #[test]
    fn parse_bandpass() {
        let spec = FilterSpec::parse("bandpass:1000:200").unwrap();
        assert!(
            matches!(spec, FilterSpec::BandPass { center_hz, bandwidth_hz }
            if (center_hz - 1000.0).abs() < 1e-6 && (bandwidth_hz - 200.0).abs() < 1e-6)
        );
    }

    #[test]
    fn parse_invalid_type() {
        assert!(FilterSpec::parse("notch:1000").is_err());
    }

    #[test]
    fn parse_missing_hz() {
        assert!(FilterSpec::parse("lowpass").is_err());
        assert!(FilterSpec::parse("lowpass:abc").is_err());
    }

    #[test]
    fn parse_bandpass_missing_bandwidth() {
        assert!(FilterSpec::parse("bandpass:1000").is_err());
        assert!(FilterSpec::parse("bandpass:1000:abc").is_err());
    }

    #[test]
    fn parse_empty_spec() {
        assert!(FilterSpec::parse("").is_err());
    }

    // ── Range checks ────────────────────────────────────────────────────

    #[test]
    fn lowpass_beyond_nyquist_errors() {
        let mut buf = sine(1000.0, 100, 1);
        let spec = FilterSpec::LowPass { cutoff_hz: 30000.0 };
        assert!(apply_filter(&mut buf, &spec).is_err());
    }

    #[test]
    fn lowpass_at_or_below_zero_errors() {
        let mut buf = sine(1000.0, 100, 1);
        assert!(apply_filter(&mut buf, &FilterSpec::LowPass { cutoff_hz: 0.0 }).is_err());
        assert!(apply_filter(&mut buf, &FilterSpec::LowPass { cutoff_hz: -50.0 }).is_err());
    }

    #[test]
    fn highpass_out_of_range_errors() {
        let mut buf = sine(1000.0, 100, 1);
        assert!(apply_filter(&mut buf, &FilterSpec::HighPass { cutoff_hz: 30000.0 }).is_err());
        assert!(apply_filter(&mut buf, &FilterSpec::HighPass { cutoff_hz: 0.0 }).is_err());
    }

    #[test]
    fn bandpass_out_of_range_errors() {
        let mut buf = sine(1000.0, 100, 1);
        let bad_center = FilterSpec::BandPass {
            center_hz: 30000.0,
            bandwidth_hz: 100.0,
        };
        let bad_bw = FilterSpec::BandPass {
            center_hz: 1000.0,
            bandwidth_hz: 0.0,
        };
        assert!(apply_filter(&mut buf, &bad_center).is_err());
        assert!(apply_filter(&mut buf, &bad_bw).is_err());
    }

    // ── Frequency response ──────────────────────────────────────────────

    #[test]
    fn lowpass_attenuates_signal_above_cutoff() {
        let mut buf = sine(1000.0, SR as usize, 1);
        apply_filter(&mut buf, &FilterSpec::LowPass { cutoff_hz: 100.0 }).unwrap();
        let peak = settled_peak(&buf, 0);
        assert!(
            peak < 0.01,
            "Expected near-zero after 100Hz low-pass on 1kHz signal, got {peak}"
        );
    }

    #[test]
    fn lowpass_passes_signal_below_cutoff() {
        let mut buf = sine(100.0, SR as usize, 1);
        apply_filter(&mut buf, &FilterSpec::LowPass { cutoff_hz: 5000.0 }).unwrap();
        let peak = settled_peak(&buf, 0);
        assert!(peak > 0.9, "Expected the passband intact, got {peak}");
    }

    #[test]
    fn highpass_attenuates_signal_below_cutoff() {
        let mut buf = sine(100.0, SR as usize, 1);
        apply_filter(&mut buf, &FilterSpec::HighPass { cutoff_hz: 2000.0 }).unwrap();
        let peak = settled_peak(&buf, 0);
        assert!(
            peak < 0.02,
            "Expected near-zero after 2kHz high-pass on 100Hz signal, got {peak}"
        );
    }

    #[test]
    fn highpass_passes_signal_above_cutoff() {
        let mut buf = sine(5000.0, SR as usize, 1);
        apply_filter(&mut buf, &FilterSpec::HighPass { cutoff_hz: 500.0 }).unwrap();
        let peak = settled_peak(&buf, 0);
        assert!(peak > 0.9, "Expected the passband intact, got {peak}");
    }

    #[test]
    fn bandpass_passes_its_centre_frequency() {
        let mut buf = sine(1000.0, SR as usize, 1);
        apply_filter(
            &mut buf,
            &FilterSpec::BandPass {
                center_hz: 1000.0,
                bandwidth_hz: 200.0,
            },
        )
        .unwrap();
        let peak = settled_peak(&buf, 0);
        assert!(
            peak > 0.9,
            "Expected the centre frequency intact, got {peak}"
        );
    }

    #[test]
    fn bandpass_rejects_frequencies_outside_the_band() {
        let mut buf = sine(8000.0, SR as usize, 1);
        apply_filter(
            &mut buf,
            &FilterSpec::BandPass {
                center_hz: 1000.0,
                bandwidth_hz: 200.0,
            },
        )
        .unwrap();
        let peak = settled_peak(&buf, 0);
        assert!(
            peak < 0.05,
            "Expected rejection outside the band, got {peak}"
        );
    }

    // ── Buffer handling ─────────────────────────────────────────────────

    #[test]
    fn filter_state_is_independent_per_channel() {
        let mut buf = sine(1000.0, SR as usize, 2);
        apply_filter(&mut buf, &FilterSpec::LowPass { cutoff_hz: 5000.0 }).unwrap();
        assert_eq!(buf.channels(), 2);
        for f in 0..buf.num_frames() {
            assert_eq!(buf.samples[0][f], buf.samples[1][f]);
        }
    }

    #[test]
    fn filtering_an_empty_buffer_is_a_no_op() {
        let mut buf = AudioBuffer {
            samples: vec![],
            sample_rate: SR,
        };
        apply_filter(&mut buf, &FilterSpec::LowPass { cutoff_hz: 1000.0 }).unwrap();
        assert_eq!(buf.num_frames(), 0);
    }

    #[test]
    fn filtering_preserves_the_frame_count() {
        let mut buf = sine(1000.0, 4410, 1);
        apply_filter(&mut buf, &FilterSpec::LowPass { cutoff_hz: 2000.0 }).unwrap();
        assert_eq!(buf.num_frames(), 4410);
    }
}
