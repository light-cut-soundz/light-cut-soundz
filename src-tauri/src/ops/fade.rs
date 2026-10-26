use crate::audio::AudioBuffer;
use crate::error::coded;
use anyhow::Result;
use std::f32::consts::FRAC_PI_2;

/// Shape of a fade. A linear ramp in amplitude sounds like it hangs on and then
/// drops at the end; equal-power (a quarter sine) keeps the loudness even,
/// which is what a smooth fade is usually after.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Curve {
    #[default]
    Linear,
    EqualPower,
}

impl Curve {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "linear" => Ok(Curve::Linear),
            "equal-power" => Ok(Curve::EqualPower),
            other => Err(coded(
                "fade_curve",
                &[("value", other.to_string())],
                format!("Unknown fade curve '{other}'"),
            )),
        }
    }

    /// Gain of a fade-in at `x`, 0 (start) to 1 (end of the fade).
    fn rising(self, x: f32) -> f32 {
        match self {
            Curve::Linear => x,
            Curve::EqualPower => (x * FRAC_PI_2).sin(),
        }
    }
}

fn too_long(which: &'static str, secs: f64) -> anyhow::Error {
    coded(
        "fade_too_long",
        &[("which", which.to_string()), ("secs", format!("{secs:.2}"))],
        format!("Fade {which} duration ({secs:.2}s) exceeds audio length"),
    )
}

pub fn fade_in(buf: &mut AudioBuffer, duration_secs: f64, curve: Curve) -> Result<()> {
    let frames = buf.num_frames();
    let fade_frames = (duration_secs * buf.sample_rate as f64).round() as usize;
    if fade_frames > frames {
        return Err(too_long("in", duration_secs));
    }
    if fade_frames < 2 {
        return Ok(());
    }
    // Divided by `fade_frames - 1` so the ramp actually reaches unity on the
    // last faded sample instead of stopping at (n-1)/n.
    let last = (fade_frames - 1) as f32;
    for ch in buf.samples.iter_mut() {
        for (i, s) in ch[..fade_frames].iter_mut().enumerate() {
            *s *= curve.rising(i as f32 / last);
        }
    }
    Ok(())
}

pub fn fade_out(buf: &mut AudioBuffer, duration_secs: f64, curve: Curve) -> Result<()> {
    let frames = buf.num_frames();
    let fade_frames = (duration_secs * buf.sample_rate as f64).round() as usize;
    if fade_frames > frames {
        return Err(too_long("out", duration_secs));
    }
    if fade_frames < 2 {
        return Ok(());
    }
    // Same correction: the ramp must land on exact silence, otherwise the cut
    // leaves an audible click.
    let last = (fade_frames - 1) as f32;
    let start = frames - fade_frames;
    for ch in buf.samples.iter_mut() {
        // Bounded by `frames`: a longer channel must not run `i / last` past 1,
        // which would flip the polarity of its tail.
        for (i, s) in ch[start..frames].iter_mut().enumerate() {
            *s *= curve.rising(1.0 - i as f32 / last);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioBuffer;

    fn make_buf(frames: usize, sr: u32) -> AudioBuffer {
        AudioBuffer {
            samples: vec![vec![1.0f32; frames]; 1],
            sample_rate: sr,
        }
    }

    fn make_stereo(frames: usize, sr: u32) -> AudioBuffer {
        AudioBuffer {
            samples: vec![vec![1.0f32; frames], vec![1.0f32; frames]],
            sample_rate: sr,
        }
    }

    #[test]
    fn fade_in_starts_at_silence() {
        let mut buf = make_buf(100, 100);
        fade_in(&mut buf, 1.0, Curve::Linear).unwrap();
        assert_eq!(buf.samples[0][0], 0.0);
    }

    #[test]
    fn fade_in_reaches_unity_on_the_last_faded_sample() {
        let mut buf = make_buf(100, 100);
        fade_in(&mut buf, 1.0, Curve::Linear).unwrap();
        assert!((buf.samples[0][99] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn fade_in_is_monotonic() {
        let mut buf = make_buf(50, 50);
        fade_in(&mut buf, 1.0, Curve::Linear).unwrap();
        for i in 1..50 {
            assert!(buf.samples[0][i] >= buf.samples[0][i - 1]);
        }
    }

    #[test]
    fn fade_out_ends_at_exact_silence() {
        let mut buf = make_buf(100, 100);
        fade_out(&mut buf, 1.0, Curve::Linear).unwrap();
        assert_eq!(buf.samples[0][99], 0.0);
    }

    #[test]
    fn fade_out_starts_at_unity() {
        let mut buf = make_buf(100, 100);
        fade_out(&mut buf, 1.0, Curve::Linear).unwrap();
        assert!((buf.samples[0][0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn fade_out_leaves_the_head_untouched() {
        let mut buf = make_buf(100, 100);
        fade_out(&mut buf, 0.5, Curve::Linear).unwrap();
        for i in 0..50 {
            assert_eq!(buf.samples[0][i], 1.0);
        }
    }

    #[test]
    fn fade_in_too_long() {
        let mut buf = make_buf(10, 10);
        assert!(fade_in(&mut buf, 2.0, Curve::Linear).is_err());
    }

    #[test]
    fn fade_out_too_long() {
        let mut buf = make_buf(10, 10);
        assert!(fade_out(&mut buf, 2.0, Curve::Linear).is_err());
    }

    #[test]
    fn fade_out_never_inverts_the_tail_of_a_longer_channel() {
        let mut buf = AudioBuffer {
            samples: vec![vec![1.0f32; 100], vec![1.0f32; 120]],
            sample_rate: 100,
        };
        fade_out(&mut buf, 0.5, Curve::Linear).unwrap();
        assert!(buf.samples[1].iter().all(|s| *s >= 0.0));
    }

    #[test]
    fn an_over_long_fade_says_which_fade_and_how_long() {
        let mut buf = make_buf(10, 10);
        let e = crate::error::CmdError::from(fade_out(&mut buf, 2.0, Curve::Linear).unwrap_err());
        assert_eq!(e.code, "fade_too_long");
        assert_eq!(e.params["which"], "out");
        assert_eq!(e.params["secs"], "2.00");
    }

    #[test]
    fn equal_power_fades_have_the_same_endpoints() {
        let mut buf = make_buf(100, 100);
        fade_in(&mut buf, 1.0, Curve::EqualPower).unwrap();
        assert_eq!(buf.samples[0][0], 0.0);
        assert!((buf.samples[0][99] - 1.0).abs() < 1e-6);

        let mut buf = make_buf(100, 100);
        fade_out(&mut buf, 1.0, Curve::EqualPower).unwrap();
        assert!((buf.samples[0][0] - 1.0).abs() < 1e-6);
        assert!(buf.samples[0][99].abs() < 1e-6);
    }

    #[test]
    fn equal_power_is_louder_than_linear_in_the_middle() {
        let mut lin = make_buf(101, 101);
        let mut eq = make_buf(101, 101);
        fade_in(&mut lin, 1.0, Curve::Linear).unwrap();
        fade_in(&mut eq, 1.0, Curve::EqualPower).unwrap();
        // sin(pi/4) = 0.7071 against 0.5 halfway through.
        assert!((lin.samples[0][50] - 0.5).abs() < 0.01);
        assert!((eq.samples[0][50] - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.01);
    }

    #[test]
    fn an_equal_power_fade_out_mirrors_the_fade_in() {
        let mut a = make_buf(101, 101);
        let mut b = make_buf(101, 101);
        fade_in(&mut a, 1.0, Curve::EqualPower).unwrap();
        fade_out(&mut b, 1.0, Curve::EqualPower).unwrap();
        for i in 0..101 {
            assert!(
                (a.samples[0][i] - b.samples[0][100 - i]).abs() < 1e-5,
                "{i}"
            );
        }
    }

    #[test]
    fn equal_power_fades_are_monotonic() {
        let mut buf = make_buf(200, 200);
        fade_in(&mut buf, 1.0, Curve::EqualPower).unwrap();
        for i in 1..200 {
            assert!(buf.samples[0][i] >= buf.samples[0][i - 1]);
        }
    }

    #[test]
    fn the_curve_is_parsed_by_name() {
        assert_eq!(Curve::parse("linear").unwrap(), Curve::Linear);
        assert_eq!(Curve::parse("equal-power").unwrap(), Curve::EqualPower);
        assert_eq!(Curve::default(), Curve::Linear);
        let e = crate::error::CmdError::from(Curve::parse("exponential").unwrap_err());
        assert_eq!(e.code, "fade_curve");
        assert_eq!(e.params["value"], "exponential");
    }

    #[test]
    fn zero_length_fades_are_no_ops() {
        let mut buf = make_buf(10, 10);
        fade_in(&mut buf, 0.0, Curve::Linear).unwrap();
        fade_out(&mut buf, 0.0, Curve::Linear).unwrap();
        assert!(buf.samples[0].iter().all(|s| *s == 1.0));
    }

    #[test]
    fn single_frame_fades_are_no_ops() {
        let mut buf = make_buf(10, 10);
        fade_in(&mut buf, 0.1, Curve::Linear).unwrap();
        fade_out(&mut buf, 0.1, Curve::Linear).unwrap();
        assert!(buf.samples[0].iter().all(|s| *s == 1.0));
    }

    #[test]
    fn fades_apply_to_every_channel() {
        let mut buf = make_stereo(100, 100);
        fade_in(&mut buf, 1.0, Curve::Linear).unwrap();
        assert_eq!(buf.samples[0][0], 0.0);
        assert_eq!(buf.samples[1][0], 0.0);

        let mut buf = make_stereo(100, 100);
        fade_out(&mut buf, 1.0, Curve::Linear).unwrap();
        assert_eq!(buf.samples[0][99], 0.0);
        assert_eq!(buf.samples[1][99], 0.0);
    }
}
