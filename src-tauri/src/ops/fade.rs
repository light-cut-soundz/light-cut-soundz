use crate::audio::AudioBuffer;
use anyhow::{bail, Result};

pub fn fade_in(buf: &mut AudioBuffer, duration_secs: f64) -> Result<()> {
    let frames = buf.num_frames();
    let fade_frames = (duration_secs * buf.sample_rate as f64).round() as usize;
    if fade_frames > frames {
        bail!("Fade in duration ({duration_secs:.2}s) exceeds audio length");
    }
    for ch in buf.samples.iter_mut() {
        for i in 0..fade_frames {
            ch[i] *= i as f32 / fade_frames as f32;
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
    let start = frames - fade_frames;
    for ch in buf.samples.iter_mut() {
        for i in 0..fade_frames {
            ch[start + i] *= 1.0 - (i as f32 / fade_frames as f32);
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
            channels: 1,
        }
    }

    #[test]
    fn fade_in_starts_near_zero() {
        let mut buf = make_buf(100, 100);
        fade_in(&mut buf, 1.0).unwrap();
        assert!(buf.samples[0][0].abs() < 1e-6);
    }

    #[test]
    fn fade_in_end_near_one() {
        let mut buf = make_buf(100, 100);
        fade_in(&mut buf, 1.0).unwrap();
        assert!((buf.samples[0][99] - 99.0 / 100.0).abs() < 1e-5);
    }

    #[test]
    fn fade_out_ends_near_zero() {
        let mut buf = make_buf(100, 100);
        fade_out(&mut buf, 1.0).unwrap();
        assert!(buf.samples[0][99].abs() < 0.02);
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
}
