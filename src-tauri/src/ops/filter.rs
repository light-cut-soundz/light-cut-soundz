use crate::audio::AudioBuffer;
use crate::error::coded;
use anyhow::Result;
use std::f64::consts::PI;

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

/// Rejects a frequency outside (0, Nyquist). Written as a positive test so
/// that NaN, which fails every comparison, is rejected too.
fn check_freq(kind: &'static str, hz: f64, sample_rate: u32) -> Result<()> {
    let nyquist = sample_rate as f64 / 2.0;
    if hz > 0.0 && hz < nyquist {
        return Ok(());
    }
    Err(coded(
        "filter_range",
        &[
            ("kind", kind.to_string()),
            ("hz", format!("{hz}")),
            ("max", format!("{nyquist}")),
        ],
        format!("{kind} frequency {hz}Hz out of range (0, {nyquist})"),
    ))
}

/// Q must be a positive, finite number; NaN fails the positive test.
fn check_q(q: f64) -> Result<()> {
    if q > 0.0 && q.is_finite() {
        return Ok(());
    }
    Err(coded(
        "filter_q",
        &[("value", format!("{q}"))],
        format!("Invalid Q {q}: it must be a positive number"),
    ))
}

impl Biquad {
    fn process(&mut self, x: f32) -> f32 {
        let x = x as f64;
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y as f32
    }

    fn low_pass(sample_rate: u32, cutoff_hz: f64, q: f64) -> Result<Self> {
        check_freq("Low-pass", cutoff_hz, sample_rate)?;
        check_q(q)?;
        let sr = sample_rate as f64;
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

    fn high_pass(sample_rate: u32, cutoff_hz: f64, q: f64) -> Result<Self> {
        check_freq("High-pass", cutoff_hz, sample_rate)?;
        check_q(q)?;
        let sr = sample_rate as f64;
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
        check_freq("Band-pass", center_hz, sample_rate)?;
        if !(bandwidth_hz > 0.0 && bandwidth_hz.is_finite()) {
            return Err(coded(
                "filter_bandwidth",
                &[("hz", format!("{bandwidth_hz}"))],
                "Band-pass bandwidth must be positive",
            ));
        }
        let sr = sample_rate as f64;
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

/// Steepness of a low-pass or high-pass, a multiple of the 12 dB/octave of one
/// biquad. Several biquads in series sharpen the cut; each takes the Q that
/// keeps the whole response maximally flat (Butterworth).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slope(u8);

impl Slope {
    pub const DEFAULT: Slope = Slope(1);

    fn from_db_per_octave(db: f64) -> Result<Self> {
        match db {
            12.0 => Ok(Slope(1)),
            24.0 => Ok(Slope(2)),
            36.0 => Ok(Slope(3)),
            48.0 => Ok(Slope(4)),
            other => Err(coded(
                "filter_slope",
                &[("value", format!("{other}"))],
                format!("Slope {other} dB/octave is not one of 12, 24, 36 or 48"),
            )),
        }
    }

    /// Butterworth Q of stage `k` (1-based) of an `n`-stage cascade.
    fn butterworth_q(self, k: u8) -> f64 {
        let n = f64::from(self.0);
        1.0 / (2.0 * (PI * (2.0 * f64::from(k) - 1.0) / (4.0 * n)).cos())
    }
}

#[allow(clippy::enum_variant_names)]
#[derive(Debug, PartialEq)]
pub enum FilterSpec {
    /// `q` is the resonance of a single 12 dB/octave stage; steeper slopes have
    /// their Qs fixed by the Butterworth design.
    LowPass {
        cutoff_hz: f64,
        slope: Slope,
        q: Option<f64>,
    },
    HighPass {
        cutoff_hz: f64,
        slope: Slope,
        q: Option<f64>,
    },
    BandPass {
        center_hz: f64,
        bandwidth_hz: f64,
    },
}

/// A finite number of Hz. `str::parse` also accepts "NaN" and "inf", which
/// would sail through range checks and fill the audio with NaN.
fn parse_hz(raw: &str) -> Result<f64> {
    match raw.trim().parse::<f64>() {
        Ok(v) if v.is_finite() => Ok(v),
        _ => Err(coded(
            "filter_value",
            &[("value", raw.to_string())],
            format!("Invalid frequency '{raw}'"),
        )),
    }
}

fn parse_q(raw: &str) -> Result<f64> {
    let q = raw.trim().parse::<f64>().unwrap_or(f64::NAN);
    check_q(q).map_err(|_| {
        coded(
            "filter_q",
            &[("value", raw.to_string())],
            format!("Invalid Q '{raw}': it must be a positive number"),
        )
    })?;
    Ok(q)
}

/// `<hz>[:<slope dB/oct>[:<q>]]` after the type name.
fn parse_pass(rest: &[&str]) -> Result<(f64, Slope, Option<f64>)> {
    let hz = parse_hz(rest[0])?;
    let slope = match rest.get(1) {
        Some(raw) => Slope::from_db_per_octave(raw.trim().parse().unwrap_or(f64::NAN))?,
        None => Slope::DEFAULT,
    };
    let q = rest.get(2).map(|raw| parse_q(raw)).transpose()?;
    if q.is_some() && slope != Slope::DEFAULT {
        return Err(coded(
            "filter_q_slope",
            &[],
            "Q can only be set on a 12 dB/octave filter",
        ));
    }
    Ok((hz, slope, q))
}

impl FilterSpec {
    pub fn parse(s: &str) -> Result<Self> {
        let parts: Vec<&str> = s.split(':').collect();
        let bad = || {
            coded(
                "filter_spec",
                &[("spec", s.to_string())],
                format!("Invalid filter spec '{s}'. Use: lowpass|highpass:<hz>[:<slope>[:<q>]] | bandpass:<hz>:<bw_hz>"),
            )
        };
        match parts.as_slice() {
            ["lowpass", rest @ ..] if (1..=3).contains(&rest.len()) => {
                let (cutoff_hz, slope, q) = parse_pass(rest)?;
                Ok(Self::LowPass {
                    cutoff_hz,
                    slope,
                    q,
                })
            }
            ["highpass", rest @ ..] if (1..=3).contains(&rest.len()) => {
                let (cutoff_hz, slope, q) = parse_pass(rest)?;
                Ok(Self::HighPass {
                    cutoff_hz,
                    slope,
                    q,
                })
            }
            ["bandpass", center, bw] => Ok(Self::BandPass {
                center_hz: parse_hz(center)?,
                bandwidth_hz: parse_hz(bw)?,
            }),
            _ => Err(bad()),
        }
    }

    /// The biquads this filter is made of, for a given sample rate.
    fn stages(&self, sample_rate: u32) -> Result<Vec<Biquad>> {
        match *self {
            FilterSpec::LowPass {
                cutoff_hz,
                slope,
                q,
            } => (1..=slope.0)
                .map(|k| {
                    let stage_q = q.unwrap_or_else(|| slope.butterworth_q(k));
                    Biquad::low_pass(sample_rate, cutoff_hz, stage_q)
                })
                .collect(),
            FilterSpec::HighPass {
                cutoff_hz,
                slope,
                q,
            } => (1..=slope.0)
                .map(|k| {
                    let stage_q = q.unwrap_or_else(|| slope.butterworth_q(k));
                    Biquad::high_pass(sample_rate, cutoff_hz, stage_q)
                })
                .collect(),
            FilterSpec::BandPass {
                center_hz,
                bandwidth_hz,
            } => Ok(vec![Biquad::band_pass(
                sample_rate,
                center_hz,
                bandwidth_hz,
            )?]),
        }
    }
}

pub fn apply_filter(buf: &mut AudioBuffer, spec: &FilterSpec) -> Result<()> {
    // One independent cascade per channel.
    let mut cascades: Vec<Vec<Biquad>> = (0..buf.channels())
        .map(|_| spec.stages(buf.sample_rate))
        .collect::<Result<_>>()?;

    // Channel by channel, stage by stage: one contiguous run per biquad, no
    // per-sample indexing.
    let frames = buf.num_frames();
    for (ch, cascade) in buf.samples.iter_mut().zip(cascades.iter_mut()) {
        for stage in cascade.iter_mut() {
            for s in ch[..frames].iter_mut() {
                *s = stage.process(*s);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioBuffer;

    const SR: u32 = 44100;

    fn low(hz: f64) -> FilterSpec {
        FilterSpec::LowPass {
            cutoff_hz: hz,
            slope: Slope::DEFAULT,
            q: None,
        }
    }

    fn high(hz: f64) -> FilterSpec {
        FilterSpec::HighPass {
            cutoff_hz: hz,
            slope: Slope::DEFAULT,
            q: None,
        }
    }

    fn slope(db: f64) -> Slope {
        Slope::from_db_per_octave(db).unwrap()
    }

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
        assert_eq!(spec, low(4000.0));
    }

    #[test]
    fn parse_highpass() {
        let spec = FilterSpec::parse("highpass:2000").unwrap();
        assert_eq!(spec, high(2000.0));
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
    fn parse_rejects_nan_and_infinity() {
        for spec in [
            "lowpass:NaN",
            "highpass:inf",
            "lowpass:-inf",
            "bandpass:1000:inf",
            "bandpass:NaN:100",
            "bandpass:1000:NaN",
        ] {
            assert!(FilterSpec::parse(spec).is_err(), "{spec}");
        }
    }

    #[test]
    fn parse_errors_name_the_offending_value() {
        let e = crate::error::CmdError::from(FilterSpec::parse("lowpass:").err().unwrap());
        assert_eq!(e.code, "filter_value");
        assert_eq!(e.params["value"], "");
        let e = crate::error::CmdError::from(FilterSpec::parse("lowpass:abc").err().unwrap());
        assert_eq!(e.params["value"], "abc");
    }

    #[test]
    fn parse_error_for_an_unknown_type_is_a_spec_error() {
        let e = crate::error::CmdError::from(FilterSpec::parse("notch:100").err().unwrap());
        assert_eq!(e.code, "filter_spec");
    }

    #[test]
    fn parse_empty_spec() {
        assert!(FilterSpec::parse("").is_err());
    }

    // ── Range checks ────────────────────────────────────────────────────

    #[test]
    fn lowpass_beyond_nyquist_errors() {
        let mut buf = sine(1000.0, 100, 1);
        let spec = low(30000.0);
        assert!(apply_filter(&mut buf, &spec).is_err());
    }

    #[test]
    fn lowpass_at_or_below_zero_errors() {
        let mut buf = sine(1000.0, 100, 1);
        assert!(apply_filter(&mut buf, &low(0.0)).is_err());
        assert!(apply_filter(&mut buf, &low(-50.0)).is_err());
    }

    #[test]
    fn highpass_out_of_range_errors() {
        let mut buf = sine(1000.0, 100, 1);
        assert!(apply_filter(&mut buf, &high(30000.0)).is_err());
        assert!(apply_filter(&mut buf, &high(0.0)).is_err());
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

    #[test]
    fn nan_parameters_built_by_hand_are_still_rejected() {
        let mut buf = sine(1000.0, 100, 1);
        assert!(apply_filter(&mut buf, &low(f64::NAN)).is_err());
        let nan_q = FilterSpec::LowPass {
            cutoff_hz: 1000.0,
            slope: Slope::DEFAULT,
            q: Some(f64::NAN),
        };
        assert!(apply_filter(&mut buf, &nan_q).is_err());
        let nan_bw = FilterSpec::BandPass {
            center_hz: 1000.0,
            bandwidth_hz: f64::NAN,
        };
        assert!(apply_filter(&mut buf, &nan_bw).is_err());
        let inf_bw = FilterSpec::BandPass {
            center_hz: 1000.0,
            bandwidth_hz: f64::INFINITY,
        };
        assert!(apply_filter(&mut buf, &inf_bw).is_err());
        assert!(buf.samples[0].iter().all(|s| s.is_finite()));
    }

    #[test]
    fn a_range_error_reports_the_nyquist_limit() {
        let mut buf = sine(1000.0, 100, 1);
        let e = apply_filter(&mut buf, &low(30000.0)).unwrap_err();
        let e = crate::error::CmdError::from(e);
        assert_eq!(e.code, "filter_range");
        assert_eq!(e.params["max"], "22050");
    }

    #[test]
    fn a_bad_bandwidth_has_its_own_error() {
        let mut buf = sine(1000.0, 100, 1);
        let bad = FilterSpec::BandPass {
            center_hz: 1000.0,
            bandwidth_hz: 0.0,
        };
        let e = crate::error::CmdError::from(apply_filter(&mut buf, &bad).unwrap_err());
        assert_eq!(e.code, "filter_bandwidth");
    }

    // ── Frequency response ──────────────────────────────────────────────

    #[test]
    fn lowpass_attenuates_signal_above_cutoff() {
        let mut buf = sine(1000.0, SR as usize, 1);
        apply_filter(&mut buf, &low(100.0)).unwrap();
        let peak = settled_peak(&buf, 0);
        assert!(
            peak < 0.01,
            "Expected near-zero after 100Hz low-pass on 1kHz signal, got {peak}"
        );
    }

    #[test]
    fn lowpass_passes_signal_below_cutoff() {
        let mut buf = sine(100.0, SR as usize, 1);
        apply_filter(&mut buf, &low(5000.0)).unwrap();
        let peak = settled_peak(&buf, 0);
        assert!(peak > 0.9, "Expected the passband intact, got {peak}");
    }

    #[test]
    fn highpass_attenuates_signal_below_cutoff() {
        let mut buf = sine(100.0, SR as usize, 1);
        apply_filter(&mut buf, &high(2000.0)).unwrap();
        let peak = settled_peak(&buf, 0);
        assert!(
            peak < 0.02,
            "Expected near-zero after 2kHz high-pass on 100Hz signal, got {peak}"
        );
    }

    #[test]
    fn highpass_passes_signal_above_cutoff() {
        let mut buf = sine(5000.0, SR as usize, 1);
        apply_filter(&mut buf, &high(500.0)).unwrap();
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

    // ── Slope and Q ─────────────────────────────────────────────────────

    /// Gain, in dB, a filter applies to a sine of `freq` (settled peak over input peak).
    fn response_db(spec: &FilterSpec, freq: f64) -> f64 {
        let mut buf = sine(freq, SR as usize, 1);
        apply_filter(&mut buf, spec).unwrap();
        20.0 * (settled_peak(&buf, 0) as f64).log10()
    }

    #[test]
    fn parse_accepts_a_slope_and_a_q() {
        assert_eq!(
            FilterSpec::parse("lowpass:1000:24").unwrap(),
            FilterSpec::LowPass {
                cutoff_hz: 1000.0,
                slope: slope(24.0),
                q: None
            }
        );
        assert_eq!(
            FilterSpec::parse("highpass:300:12:2.5").unwrap(),
            FilterSpec::HighPass {
                cutoff_hz: 300.0,
                slope: slope(12.0),
                q: Some(2.5)
            }
        );
    }

    #[test]
    fn parse_refuses_a_slope_that_is_not_offered() {
        for spec in [
            "lowpass:1000:18",
            "lowpass:1000:abc",
            "highpass:1000:96",
            "lowpass:1000:NaN",
        ] {
            let e = crate::error::CmdError::from(FilterSpec::parse(spec).unwrap_err());
            assert_eq!(e.code, "filter_slope", "{spec}");
        }
    }

    #[test]
    fn parse_refuses_a_q_that_is_not_a_positive_number() {
        for spec in [
            "lowpass:1000:12:0",
            "lowpass:1000:12:-1",
            "lowpass:1000:12:abc",
            "lowpass:1000:12:inf",
        ] {
            let e = crate::error::CmdError::from(FilterSpec::parse(spec).unwrap_err());
            assert_eq!(e.code, "filter_q", "{spec}");
        }
    }

    #[test]
    fn a_q_on_a_steeper_filter_is_refused_because_butterworth_fixes_it() {
        let e = crate::error::CmdError::from(FilterSpec::parse("lowpass:1000:24:2").unwrap_err());
        assert_eq!(e.code, "filter_q_slope");
    }

    #[test]
    fn too_many_or_too_few_fields_is_a_spec_error() {
        for spec in [
            "lowpass",
            "lowpass:1:12:1:1",
            "bandpass:1000",
            "bandpass:1000:100:5",
        ] {
            let e = crate::error::CmdError::from(FilterSpec::parse(spec).unwrap_err());
            assert_eq!(e.code, "filter_spec", "{spec}");
        }
    }

    #[test]
    fn butterworth_stage_qs() {
        // 2nd order: 1/sqrt(2); 4th order: 0.5412 and 1.3066.
        assert!((slope(12.0).butterworth_q(1) - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-9);
        assert!((slope(24.0).butterworth_q(1) - 0.541_196).abs() < 1e-5);
        assert!((slope(24.0).butterworth_q(2) - 1.306_563).abs() < 1e-5);
    }

    #[test]
    fn each_extra_12_db_per_octave_adds_a_stage() {
        for (db, stages) in [(12.0, 1), (24.0, 2), (36.0, 3), (48.0, 4)] {
            let spec = FilterSpec::LowPass {
                cutoff_hz: 1000.0,
                slope: slope(db),
                q: None,
            };
            assert_eq!(spec.stages(SR).unwrap().len(), stages);
        }
    }

    #[test]
    fn the_cut_is_3_db_down_at_the_cutoff_whatever_the_slope() {
        // Butterworth: -3 dB at the corner for every order.
        for db in [12.0, 24.0, 36.0, 48.0] {
            let spec = FilterSpec::LowPass {
                cutoff_hz: 2000.0,
                slope: slope(db),
                q: None,
            };
            let at_corner = response_db(&spec, 2000.0);
            assert!(
                (at_corner + 3.01).abs() < 0.3,
                "{db} dB/oct: {at_corner:.2} dB"
            );
        }
    }

    #[test]
    fn a_steeper_slope_cuts_the_stopband_harder() {
        let one_octave_above = |db: f64| {
            response_db(
                &FilterSpec::LowPass {
                    cutoff_hz: 2000.0,
                    slope: slope(db),
                    q: None,
                },
                4000.0,
            )
        };
        let (a, b, c, d) = (
            one_octave_above(12.0),
            one_octave_above(24.0),
            one_octave_above(36.0),
            one_octave_above(48.0),
        );
        assert!(a > b && b > c && c > d, "{a:.1} {b:.1} {c:.1} {d:.1}");
        // About one slope's worth of attenuation per octave, give or take the
        // curvature near the corner.
        assert!((b + 24.0).abs() < 4.0, "{b:.1}");
    }

    #[test]
    fn a_steeper_high_pass_cuts_the_stopband_harder() {
        let below = |db: f64| {
            response_db(
                &FilterSpec::HighPass {
                    cutoff_hz: 2000.0,
                    slope: slope(db),
                    q: None,
                },
                1000.0,
            )
        };
        assert!(below(12.0) > below(24.0) && below(24.0) > below(48.0));
    }

    #[test]
    fn a_high_q_makes_the_corner_resonate() {
        let flat = response_db(&low(2000.0), 2000.0);
        let resonant = response_db(
            &FilterSpec::LowPass {
                cutoff_hz: 2000.0,
                slope: Slope::DEFAULT,
                q: Some(4.0),
            },
            2000.0,
        );
        // The gain at the corner of a 2nd-order low-pass is 20·log10(Q).
        assert!(resonant > flat + 8.0, "{flat:.1} -> {resonant:.1}");
        assert!((resonant - 12.04).abs() < 0.5, "{resonant:.2}");
    }

    #[test]
    fn a_cascade_keeps_the_passband_flat() {
        let spec = FilterSpec::LowPass {
            cutoff_hz: 8000.0,
            slope: slope(48.0),
            q: None,
        };
        assert!(response_db(&spec, 200.0).abs() < 0.2);
    }

    #[test]
    fn every_stage_is_range_checked() {
        let mut buf = sine(1000.0, 100, 1);
        let spec = FilterSpec::LowPass {
            cutoff_hz: 30000.0,
            slope: slope(48.0),
            q: None,
        };
        assert!(apply_filter(&mut buf, &spec).is_err());
    }

    // ── Buffer handling ─────────────────────────────────────────────────

    #[test]
    fn filter_state_is_independent_per_channel() {
        let mut buf = sine(1000.0, SR as usize, 2);
        apply_filter(&mut buf, &low(5000.0)).unwrap();
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
        apply_filter(&mut buf, &low(1000.0)).unwrap();
        assert_eq!(buf.num_frames(), 0);
    }

    #[test]
    fn filtering_preserves_the_frame_count() {
        let mut buf = sine(1000.0, 4410, 1);
        apply_filter(&mut buf, &low(2000.0)).unwrap();
        assert_eq!(buf.num_frames(), 4410);
    }
}
