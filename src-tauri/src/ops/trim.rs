use crate::audio::AudioBuffer;
use crate::error::coded;
use anyhow::Result;

pub fn trim(buf: &mut AudioBuffer, start_secs: f64, end_secs: f64) -> Result<()> {
    let total = buf.duration_secs();
    // Written so that NaN fails every comparison and lands in the error branch.
    let valid = start_secs >= 0.0 && end_secs > start_secs && end_secs <= total + 0.001;
    if !valid {
        return Err(coded(
            "trim_range",
            &[
                ("start", format!("{start_secs:.2}")),
                ("end", format!("{end_secs:.2}")),
                ("total", format!("{total:.2}")),
            ],
            format!("Invalid trim range {start_secs:.3}:{end_secs:.3} (audio is {total:.3}s)"),
        ));
    }
    let frames = buf.num_frames();
    // Both bounds are clamped: the 1ms tolerance above is worth 44 frames at
    // 44.1kHz, enough for a rounded start to land past the end of the buffer.
    let start_frame = ((start_secs * buf.sample_rate as f64).round() as usize).min(frames);
    let end_frame = ((end_secs * buf.sample_rate as f64).round() as usize)
        .min(frames)
        .max(start_frame);

    // The 1ms tolerance can also collapse a tiny range onto a single frame
    // boundary; exporting zero frames would "succeed" with an empty file.
    if end_frame <= start_frame {
        return Err(coded("trim_empty", &[], "Trim range is empty"));
    }

    // In place: a copy would briefly hold the audio twice.
    for ch in buf.samples.iter_mut() {
        ch.truncate(end_frame);
        ch.drain(..start_frame);
    }
    Ok(())
}

/// Removes the `cuts` (start, end in seconds) from the audio and joins what is
/// left. Overlapping or out-of-order cuts are merged first; a cut is clamped to
/// the audio, and what remains must not be empty.
pub fn remove(buf: &mut AudioBuffer, cuts: &[(f64, f64)]) -> Result<()> {
    if cuts.is_empty() {
        return Ok(());
    }
    let frames = buf.num_frames();
    let rate = buf.sample_rate as f64;
    // Written so that NaN fails every comparison and lands in the error branch.
    if let Some(&(start, end)) = cuts.iter().find(|&&(s, e)| !(s >= 0.0 && e > s)) {
        return Err(coded(
            "trim_range",
            &[
                ("start", format!("{start:.2}")),
                ("end", format!("{end:.2}")),
                ("total", format!("{:.2}", buf.duration_secs())),
            ],
            format!("Invalid cut {start:.3}:{end:.3}"),
        ));
    }
    let mut ranges: Vec<(usize, usize)> = cuts
        .iter()
        .map(|&(s, e)| {
            let a = ((s * rate).round() as usize).min(frames);
            let b = ((e * rate).round() as usize).min(frames);
            (a, b)
        })
        .filter(|&(a, b)| b > a)
        .collect();
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (a, b) in ranges {
        match merged.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    let removed: usize = merged.iter().map(|&(a, b)| b - a).sum();
    if removed >= frames {
        return Err(coded("trim_empty", &[], "Nothing is left after the cuts"));
    }
    for ch in buf.samples.iter_mut() {
        let mut write = 0;
        let mut read = 0;
        for &(a, b) in &merged {
            ch.copy_within(read..a, write);
            write += a - read;
            read = b;
        }
        ch.copy_within(read..frames, write);
        write += frames - read;
        ch.truncate(write);
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
    fn trim_within_the_tolerance_window_is_an_empty_range_not_a_panic() {
        // Regression: start rounded to frame 44122 of a 44100-frame buffer. The
        // range then holds no audio, which must be refused rather than exported.
        let mut buf = make_buf(44_100, 44_100);
        let err = trim(&mut buf, 1.0005, 1.001).unwrap_err();
        assert_eq!(crate::error::CmdError::from(err).code, "trim_empty");
    }

    #[test]
    fn trim_rejects_nan_bounds() {
        let mut buf = make_buf(10, 10);
        assert!(trim(&mut buf, f64::NAN, 0.5).is_err());
        assert!(trim(&mut buf, 0.0, f64::NAN).is_err());
    }

    #[test]
    fn an_invalid_range_carries_its_numbers_for_the_translated_message() {
        let mut buf = make_buf(10, 10);
        let e = crate::error::CmdError::from(trim(&mut buf, 0.5, 0.5).unwrap_err());
        assert_eq!(e.code, "trim_range");
        assert_eq!(e.params["start"], "0.50");
        assert_eq!(e.params["total"], "1.00");
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

    #[test]
    fn remove_joins_what_is_left() {
        let mut buf = AudioBuffer {
            samples: vec![(0..10).map(|i| i as f32).collect()],
            sample_rate: 10,
        };
        remove(&mut buf, &[(0.2, 0.4), (0.7, 0.8)]).unwrap();
        assert_eq!(buf.samples[0], vec![0.0, 1.0, 4.0, 5.0, 6.0, 8.0, 9.0]);
    }

    #[test]
    fn remove_merges_overlapping_and_unordered_cuts() {
        let mut buf = AudioBuffer {
            samples: vec![(0..10).map(|i| i as f32).collect()],
            sample_rate: 10,
        };
        remove(&mut buf, &[(0.5, 0.8), (0.2, 0.6)]).unwrap();
        assert_eq!(buf.samples[0], vec![0.0, 1.0, 8.0, 9.0]);
    }

    #[test]
    fn remove_applies_to_every_channel() {
        let mut buf = make_stereo(10, 10);
        remove(&mut buf, &[(0.0, 0.5)]).unwrap();
        assert_eq!(buf.samples[0].len(), 5);
        assert_eq!(buf.samples[1].len(), 5);
    }

    #[test]
    fn remove_clamps_a_cut_past_the_end() {
        let mut buf = make_buf(10, 10);
        remove(&mut buf, &[(0.5, 5.0)]).unwrap();
        assert_eq!(buf.samples[0].len(), 5);
    }

    #[test]
    fn remove_nothing_is_a_no_op() {
        let mut buf = make_buf(10, 10);
        remove(&mut buf, &[]).unwrap();
        assert_eq!(buf.samples[0].len(), 10);
    }

    #[test]
    fn remove_refuses_to_leave_nothing() {
        let mut buf = make_buf(10, 10);
        let e = crate::error::CmdError::from(remove(&mut buf, &[(0.0, 1.0)]).unwrap_err());
        assert_eq!(e.code, "trim_empty");
    }

    #[test]
    fn remove_rejects_an_invalid_cut() {
        let mut buf = make_buf(10, 10);
        for cut in [(0.5, 0.5), (0.6, 0.2), (-0.1, 0.3), (f64::NAN, 0.3)] {
            let e = crate::error::CmdError::from(remove(&mut buf, &[cut]).unwrap_err());
            assert_eq!(e.code, "trim_range", "{cut:?}");
        }
    }
}
