use crate::audio::AudioBuffer;
use anyhow::{bail, Result};

pub fn fade_in(buf: &mut AudioBuffer, duration_secs: f64) -> Result<()> {
    let frames = buf.num_frames();
    let fade_frames = (duration_secs * buf.sample_rate as f64).round() as usize;
    if fade_frames > frames {
        bail!("Fade in duration ({duration_secs:.2}s) exceeds audio length");
    }
    if fade_frames < 2 {
        return Ok(());
    }
    // Divided by `fade_frames - 1` so the ramp actually reaches unity on the
    // last faded sample instead of stopping at (n-1)/n.
    let last = (fade_frames - 1) as f32;
    for ch in buf.samples.iter_mut() {
        for (i, s) in ch[..fade_frames].iter_mut().enumerate() {
            *s *= i as f32 / last;
        }
    }
    Ok(())
}

pub fn fade_out(buf: &mut AudioBuffer, duration_secs: f64) -> Result<()> {
    let frames = buf.num_frames();
    let fade_frames = (duration_secs * buf.sample_rate as f64).round() as usize;
    if fade_frames > frames {
        bail!("Fade out duration ({duration_secs:.2}s) exceeds audio length");
    }
    if fade_frames < 2 {
        return Ok(());
    }
    // Same correction: the ramp must land on exact silence, otherwise the cut
    // leaves an audible click.
    let last = (fade_frames - 1) as f32;
    let start = frames - fade_frames;
    for ch in buf.samples.iter_mut() {
        for (i, s) in ch[start..].iter_mut().enumerate() {
            *s *= 1.0 - (i as f32 / last);
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
        fade_in(&mut buf, 1.0).unwrap();
        assert_eq!(buf.samples[0][0], 0.0);
    }

    #[test]
    fn fade_in_reaches_unity_on_the_last_faded_sample() {
        let mut buf = make_buf(100, 100);
        fade_in(&mut buf, 1.0).unwrap();
        assert!((buf.samples[0][99] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn fade_in_is_monotonic() {
        let mut buf = make_buf(50, 50);
        fade_in(&mut buf, 1.0).unwrap();
        for i in 1..50 {
            assert!(buf.samples[0][i] >= buf.samples[0][i - 1]);
        }
    }

    #[test]
    fn fade_out_ends_at_exact_silence() {
        let mut buf = make_buf(100, 100);
        fade_out(&mut buf, 1.0).unwrap();
        assert_eq!(buf.samples[0][99], 0.0);
    }

    #[test]
    fn fade_out_starts_at_unity() {
        let mut buf = make_buf(100, 100);
        fade_out(&mut buf, 1.0).unwrap();
        assert!((buf.samples[0][0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn fade_out_leaves_the_head_untouched() {
        let mut buf = make_buf(100, 100);
        fade_out(&mut buf, 0.5).unwrap();
        for i in 0..50 {
            assert_eq!(buf.samples[0][i], 1.0);
        }
    }

    #[test]
    fn fade_in_too_long() {
        let mut buf = make_buf(10, 10);
        assert!(fade_in(&mut buf, 2.0).is_err());
    }

    #[test]
    fn fade_out_too_long() {
        let mut buf = make_buf(10, 10);
        assert!(fade_out(&mut buf, 2.0).is_err());
    }

    #[test]
    fn zero_length_fades_are_no_ops() {
        let mut buf = make_buf(10, 10);
        fade_in(&mut buf, 0.0).unwrap();
        fade_out(&mut buf, 0.0).unwrap();
        assert!(buf.samples[0].iter().all(|s| *s == 1.0));
    }

    #[test]
    fn single_frame_fades_are_no_ops() {
        let mut buf = make_buf(10, 10);
        fade_in(&mut buf, 0.1).unwrap();
        fade_out(&mut buf, 0.1).unwrap();
        assert!(buf.samples[0].iter().all(|s| *s == 1.0));
    }

    #[test]
    fn fades_apply_to_every_channel() {
        let mut buf = make_stereo(100, 100);
        fade_in(&mut buf, 1.0).unwrap();
        assert_eq!(buf.samples[0][0], 0.0);
        assert_eq!(buf.samples[1][0], 0.0);

        let mut buf = make_stereo(100, 100);
        fade_out(&mut buf, 1.0).unwrap();
        assert_eq!(buf.samples[0][99], 0.0);
        assert_eq!(buf.samples[1][99], 0.0);
    }
}
