use crate::audio::AudioBuffer;
use anyhow::{bail, Result};

pub fn trim(buf: &mut AudioBuffer, start_secs: f64, end_secs: f64) -> Result<()> {
    let total = buf.duration_secs();
    if start_secs < 0.0 || end_secs <= start_secs || end_secs > total + 0.001 {
        bail!("Invalid trim range {start_secs:.3}:{end_secs:.3} (audio is {total:.3}s)");
    }
    let frames = buf.num_frames();
    // Both bounds are clamped: the 1ms tolerance above is worth 44 frames at
    // 44.1kHz, enough for a rounded start to land past the end of the buffer.
    let start_frame = ((start_secs * buf.sample_rate as f64).round() as usize).min(frames);
    let end_frame = ((end_secs * buf.sample_rate as f64).round() as usize)
        .min(frames)
        .max(start_frame);

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
        }
    }

    fn make_stereo(frames: usize, sr: u32) -> AudioBuffer {
        AudioBuffer {
            samples: vec![vec![1.0f32; frames], vec![0.5f32; frames]],
            sample_rate: sr,
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

    #[test]
    fn trim_within_the_tolerance_window_does_not_panic() {
        // Regression: start rounded to frame 44122 of a 44100-frame buffer.
        let mut buf = make_buf(44_100, 44_100);
        trim(&mut buf, 1.0005, 1.001).unwrap();
        assert_eq!(buf.num_frames(), 0);
    }

    #[test]
    fn trim_end_exactly_at_the_tolerance_edge() {
        let mut buf = make_buf(44_100, 44_100);
        trim(&mut buf, 0.5, 1.001).unwrap();
        assert_eq!(buf.num_frames(), 22_050);
    }

    #[test]
    fn trim_applies_to_every_channel() {
        let mut buf = make_stereo(100, 10);
        trim(&mut buf, 2.0, 8.0).unwrap();
        assert_eq!(buf.channels(), 2);
        assert_eq!(buf.samples[0].len(), 60);
        assert_eq!(buf.samples[1].len(), 60);
        assert!((buf.samples[1][0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn trim_keeps_the_expected_content() {
        let mut buf = AudioBuffer {
            samples: vec![(0..10).map(|i| i as f32).collect()],
            sample_rate: 10,
        };
        trim(&mut buf, 0.3, 0.6).unwrap();
        assert_eq!(buf.samples[0], vec![3.0, 4.0, 5.0]);
    }

    #[test]
    fn trim_of_an_empty_buffer_is_rejected() {
        let mut buf = make_buf(0, 44_100);
        assert!(trim(&mut buf, 0.0, 1.0).is_err());
    }
}
