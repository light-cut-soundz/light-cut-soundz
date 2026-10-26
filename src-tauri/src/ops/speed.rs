use crate::audio::AudioBuffer;
use crate::error::coded;
use crate::job::Job;
use anyhow::{bail, Result};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

fn invalid(message: &str) -> anyhow::Error {
    coded("speed_invalid", &[], message)
}

pub fn change_speed(buf: &mut AudioBuffer, factor: f64, job: &Job) -> Result<()> {
    if !factor.is_finite() {
        return Err(invalid("Speed factor must be a finite number"));
    }
    if factor <= 0.0 {
        return Err(invalid("Speed factor must be positive"));
    }
    if (factor - 1.0).abs() < 1e-6 {
        return Ok(());
    }
    let channels = buf.channels();
    let frames = buf.num_frames();
    if channels == 0 || frames == 0 {
        bail!("Cannot change the speed of an empty buffer");
    }

    // 128 taps with 128x oversampling is transparent for this use and about
    // twice as fast as the 256/256 preset, the costliest step of the pipeline.
    let params = SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };

    let chunk_size = 1024usize;
    let resample_ratio = 1.0 / factor;

    let mut resampler = SincFixedIn::<f32>::new(resample_ratio, 2.0, params, chunk_size, channels)?;

    let expected = (frames as f64 * resample_ratio).round() as usize;
    // The sinc filter needs half its length of history before it emits the
    // sample matching input frame 0; those leading frames are dropped below.
    let delay = resampler.output_delay();

    // One output block, reused for every call.
    let mut block = resampler.output_buffer_allocate(true);
    let mut output: Vec<Vec<f32>> = (0..channels)
        .map(|_| Vec::with_capacity(expected + delay + block[0].len()))
        .collect();
    let append = |output: &mut Vec<Vec<f32>>, block: &[Vec<f32>], written: usize| {
        for (dst, src) in output.iter_mut().zip(block) {
            dst.extend_from_slice(&src[..written]);
        }
    };

    let mut pos = 0usize;
    while pos < frames {
        job.check()?;
        job.progress(pos as f32 / frames as f32);
        let end = (pos + chunk_size).min(frames);
        let input: Vec<&[f32]> = buf.samples.iter().map(|ch| &ch[pos..end]).collect();
        // A short last chunk is zero-padded by `process_partial_into_buffer`.
        let (_, written) = if end - pos == chunk_size {
            resampler.process_into_buffer(&input, &mut block, None)?
        } else {
            resampler.process_partial_into_buffer(Some(&input), &mut block, None)?
        };
        append(&mut output, &block, written);
        pos = end;
    }

    // Keep flushing silence until the tail that the delay pushed out has come
    // through, otherwise the truncation below eats the end of the audio.
    while output[0].len() < expected + delay {
        let (_, written) =
            resampler.process_partial_into_buffer(None::<&[Vec<f32>]>, &mut block, None)?;
        if written == 0 {
            break;
        }
        append(&mut output, &block, written);
    }

    for ch in output.iter_mut() {
        ch.drain(..delay.min(ch.len()));
        ch.truncate(expected);
    }

    buf.samples = output;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioBuffer;
    use crate::job::Job;

    fn dc_buf(frames: usize, channels: usize, level: f32) -> AudioBuffer {
        AudioBuffer {
            samples: vec![vec![level; frames]; channels],
            sample_rate: 44100,
        }
    }

    fn sine_buf(frames: usize, freq: f64, sr: u32) -> AudioBuffer {
        AudioBuffer {
            samples: vec![(0..frames)
                .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr as f64).sin() as f32)
                .collect()],
            sample_rate: sr,
        }
    }

    #[test]
    fn speeding_up_halves_the_length() {
        let mut buf = dc_buf(44_100, 1, 0.5);
        change_speed(&mut buf, 2.0, &Job::detached()).unwrap();
        assert_eq!(buf.num_frames(), 22_050);
    }

    #[test]
    fn slowing_down_doubles_the_length() {
        let mut buf = dc_buf(22_050, 1, 0.5);
        change_speed(&mut buf, 0.5, &Job::detached()).unwrap();
        assert_eq!(buf.num_frames(), 44_100);
    }

    #[test]
    fn non_integer_factor_gives_the_expected_length() {
        let mut buf = dc_buf(30_000, 1, 0.5);
        change_speed(&mut buf, 1.5, &Job::detached()).unwrap();
        assert_eq!(buf.num_frames(), 20_000);
    }

    #[test]
    fn every_channel_keeps_the_same_length() {
        let mut buf = dc_buf(44_100, 2, 0.5);
        change_speed(&mut buf, 2.0, &Job::detached()).unwrap();
        assert_eq!(buf.channels(), 2);
        assert_eq!(buf.samples[0].len(), buf.samples[1].len());
        assert_eq!(buf.samples[0].len(), 22_050);
    }

    #[test]
    fn the_output_does_not_start_with_resampler_latency() {
        // Regression: the ~128 frames of sinc latency used to be kept at the
        // head of the output, shifting the whole track and cutting its tail.
        let mut buf = dc_buf(44_100, 1, 0.5);
        change_speed(&mut buf, 2.0, &Job::detached()).unwrap();
        let head_peak = buf.samples[0][..64]
            .iter()
            .map(|s| s.abs())
            .fold(0.0f32, f32::max);
        assert!(
            head_peak > 0.1,
            "output starts with silence: peak {head_peak}"
        );
    }

    #[test]
    fn the_output_keeps_its_tail() {
        let mut buf = dc_buf(44_100, 1, 0.5);
        change_speed(&mut buf, 2.0, &Job::detached()).unwrap();
        let n = buf.num_frames();
        let tail_peak = buf.samples[0][n - 200..n - 100]
            .iter()
            .map(|s| s.abs())
            .fold(0.0f32, f32::max);
        assert!(
            tail_peak > 0.1,
            "output ends with silence: peak {tail_peak}"
        );
    }

    #[test]
    fn a_steady_level_is_preserved_through_the_middle() {
        let mut buf = dc_buf(44_100, 1, 0.5);
        change_speed(&mut buf, 2.0, &Job::detached()).unwrap();
        let mid = buf.num_frames() / 2;
        assert!((buf.samples[0][mid] - 0.5).abs() < 0.01);
    }

    #[test]
    fn speeding_up_a_sine_raises_its_pitch() {
        // 1kHz sped up 2x lands at 2kHz: count zero crossings to check.
        let sr = 44_100u32;
        let mut buf = sine_buf(sr as usize, 1000.0, sr);
        change_speed(&mut buf, 2.0, &Job::detached()).unwrap();

        let s = &buf.samples[0];
        let mid = s.len() / 4..s.len() * 3 / 4;
        let window = &s[mid];
        let crossings = window
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count();
        let seconds = window.len() as f64 / sr as f64;
        let freq = crossings as f64 / seconds;
        assert!(
            (freq - 2000.0).abs() < 60.0,
            "expected ~2000Hz after 2x speed-up, measured {freq:.0}Hz"
        );
    }

    #[test]
    fn a_neutral_factor_leaves_the_buffer_untouched() {
        let mut buf = dc_buf(1000, 1, 0.5);
        change_speed(&mut buf, 1.0, &Job::detached()).unwrap();
        assert_eq!(buf.num_frames(), 1000);
        assert!(buf.samples[0].iter().all(|s| *s == 0.5));
    }

    #[test]
    fn a_zero_or_negative_factor_is_rejected() {
        let mut buf = dc_buf(100, 1, 0.5);
        assert!(change_speed(&mut buf, 0.0, &Job::detached()).is_err());
        assert!(change_speed(&mut buf, -1.0, &Job::detached()).is_err());
    }

    #[test]
    fn a_bad_factor_has_a_translatable_code() {
        let mut buf = dc_buf(100, 1, 0.5);
        let e = crate::error::CmdError::from(
            change_speed(&mut buf, 0.0, &Job::detached()).unwrap_err(),
        );
        assert_eq!(e.code, "speed_invalid");
    }

    #[test]
    fn a_cancelled_job_stops_the_resampling() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let mut buf = dc_buf(44_100, 1, 0.5);
        let job = Job::new(Arc::new(AtomicBool::new(true)), |_| {});
        let e = crate::error::CmdError::from(change_speed(&mut buf, 2.0, &job).unwrap_err());
        assert_eq!(e.code, "cancelled");
    }

    #[test]
    fn resampling_reports_increasing_progress() {
        use std::sync::atomic::AtomicBool;
        use std::sync::{Arc, Mutex};
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let job = Job::new(Arc::new(AtomicBool::new(false)), move |f| {
            sink.lock().unwrap().push(f)
        });
        let mut buf = dc_buf(44_100, 1, 0.5);
        change_speed(&mut buf, 2.0, &job).unwrap();
        let seen = seen.lock().unwrap();
        assert!(seen.len() > 10);
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn a_non_finite_factor_is_rejected() {
        let mut buf = dc_buf(100, 1, 0.5);
        assert!(change_speed(&mut buf, f64::NAN, &Job::detached()).is_err());
        assert!(change_speed(&mut buf, f64::INFINITY, &Job::detached()).is_err());
    }

    #[test]
    fn an_empty_buffer_is_rejected() {
        let mut buf = AudioBuffer {
            samples: vec![],
            sample_rate: 44100,
        };
        assert!(change_speed(&mut buf, 2.0, &Job::detached()).is_err());

        let mut buf = dc_buf(0, 1, 0.5);
        assert!(change_speed(&mut buf, 2.0, &Job::detached()).is_err());
    }

    #[test]
    fn a_length_that_is_an_exact_multiple_of_the_chunk_keeps_its_tail() {
        let mut buf = dc_buf(1024 * 40, 2, 0.5);
        change_speed(&mut buf, 0.5, &Job::detached()).unwrap();
        assert_eq!(buf.num_frames(), 1024 * 80);
        let n = buf.num_frames();
        assert!((buf.samples[1][n - 200] - 0.5).abs() < 0.05);
    }

    #[test]
    fn a_buffer_shorter_than_one_chunk_still_resamples() {
        let mut buf = dc_buf(300, 1, 0.5);
        change_speed(&mut buf, 2.0, &Job::detached()).unwrap();
        assert_eq!(buf.num_frames(), 150);
    }
}
