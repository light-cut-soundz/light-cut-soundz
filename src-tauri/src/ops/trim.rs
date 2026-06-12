use crate::audio::AudioBuffer;
use anyhow::{bail, Result};

pub fn trim(buf: &mut AudioBuffer, start_secs: f64, end_secs: f64) -> Result<()> {
    let total = buf.duration_secs();
    if start_secs < 0.0 || end_secs <= start_secs || end_secs > total + 0.001 {
        bail!("Invalid trim range {start_secs:.3}:{end_secs:.3} (audio is {total:.3}s)");
    }
    let start_frame = (start_secs * buf.sample_rate as f64).round() as usize;
    let end_frame = (end_secs * buf.sample_rate as f64)
        .round()
        .min(buf.num_frames() as f64) as usize;

    for ch in buf.samples.iter_mut() {
        *ch = ch[start_frame..end_frame].to_vec();
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
    fn trim_basic() {
        let mut buf = make_buf(100, 10);
        trim(&mut buf, 2.0, 8.0).unwrap();
        assert_eq!(buf.num_frames(), 60);
    }

    #[test]
    fn trim_full_range() {
        let mut buf = make_buf(10, 10);
        trim(&mut buf, 0.0, 1.0).unwrap();
        assert_eq!(buf.num_frames(), 10);
    }

    #[test]
    fn trim_start_gte_end() {
        let mut buf = make_buf(10, 10);
        assert!(trim(&mut buf, 0.5, 0.5).is_err());
    }

    #[test]
    fn trim_negative_start() {
        let mut buf = make_buf(10, 10);
        assert!(trim(&mut buf, -0.1, 0.5).is_err());
    }

    #[test]
    fn trim_end_beyond_duration() {
        let mut buf = make_buf(10, 10);
        assert!(trim(&mut buf, 0.0, 2.0).is_err());
    }
}
