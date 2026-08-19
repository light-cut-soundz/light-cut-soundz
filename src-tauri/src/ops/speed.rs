use crate::audio::AudioBuffer;
use anyhow::{bail, Result};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub fn change_speed(buf: &mut AudioBuffer, factor: f64) -> Result<()> {
    if factor <= 0.0 {
        bail!("Speed factor must be positive");
    }
    if !factor.is_finite() {
        bail!("Speed factor must be a finite number");
    }
    if (factor - 1.0).abs() < 1e-6 {
        return Ok(());
    }
    let channels = buf.channels();
    let frames = buf.num_frames();
    if channels == 0 || frames == 0 {
        bail!("Cannot change the speed of an empty buffer");
    }

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let chunk_size = 1024usize;
    let resample_ratio = 1.0 / factor;

    let mut resampler = SincFixedIn::<f32>::new(resample_ratio, 2.0, params, chunk_size, channels)?;

    let expected = (frames as f64 * resample_ratio).round() as usize;
    // The sinc filter needs half its length of history before it emits the
    // sample matching input frame 0; those leading frames are dropped below.
    let delay = resampler.output_delay();

    let mut output: Vec<Vec<f32>> = vec![Vec::new(); channels];

    let mut pos = 0usize;
    loop {
        let end = (pos + chunk_size).min(frames);
        let chunk: Vec<Vec<f32>> = buf
            .samples
            .iter()
            .map(|ch| {
                let mut v = ch[pos..end].to_vec();
                v.resize(chunk_size, 0.0);
                v
            })
            .collect();

        let out = resampler.process(&chunk, None)?;
        for (ch, ch_out) in out.iter().enumerate() {
            output[ch].extend_from_slice(ch_out);
        }

        if end == frames {
            break;
        }
        pos += chunk_size;
    }

    // Keep flushing silence until the tail that the delay pushed out has come
    // through, otherwise the truncation below eats the end of the audio.
    let zeros: Vec<Vec<f32>> = vec![vec![0.0f32; chunk_size]; channels];
    while output[0].len() < expected + delay {
        let out = resampler.process(&zeros, None)?;
        if out[0].is_empty() {
            break;
        }
        for (ch, ch_out) in out.iter().enumerate() {
            output[ch].extend_from_slice(ch_out);
        }
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
        change_speed(&mut buf, 2.0).unwrap();
        assert_eq!(buf.num_frames(), 22_050);
    }

    #[test]
    fn slowing_down_doubles_the_length() {
        let mut buf = dc_buf(22_050, 1, 0.5);
        change_speed(&mut buf, 0.5).unwrap();
        assert_eq!(buf.num_frames(), 44_100);
    }

    #[test]
    fn non_integer_factor_gives_the_expected_length() {
        let mut buf = dc_buf(30_000, 1, 0.5);
        change_speed(&mut buf, 1.5).unwrap();
        assert_eq!(buf.num_frames(), 20_000);
    }

    #[test]
    fn every_channel_keeps_the_same_length() {
        let mut buf = dc_buf(44_100, 2, 0.5);
        change_speed(&mut buf, 2.0).unwrap();
        assert_eq!(buf.channels(), 2);
        assert_eq!(buf.samples[0].len(), buf.samples[1].len());
        assert_eq!(buf.samples[0].len(), 22_050);
    }

    #[test]
    fn the_output_does_not_start_with_resampler_latency() {
        // Regression: the ~128 frames of sinc latency used to be kept at the
        // head of the output, shifting the whole track and cutting its tail.
        let mut buf = dc_buf(44_100, 1, 0.5);
        change_speed(&mut buf, 2.0).unwrap();
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
        change_speed(&mut buf, 2.0).unwrap();
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
        change_speed(&mut buf, 2.0).unwrap();
        let mid = buf.num_frames() / 2;
        assert!((buf.samples[0][mid] - 0.5).abs() < 0.01);
    }

    #[test]
    fn speeding_up_a_sine_raises_its_pitch() {
        // 1kHz sped up 2x lands at 2kHz: count zero crossings to check.
        let sr = 44_100u32;
        let mut buf = sine_buf(sr as usize, 1000.0, sr);
        change_speed(&mut buf, 2.0).unwrap();

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
        change_speed(&mut buf, 1.0).unwrap();
        assert_eq!(buf.num_frames(), 1000);
        assert!(buf.samples[0].iter().all(|s| *s == 0.5));
    }

    #[test]
    fn a_zero_or_negative_factor_is_rejected() {
        let mut buf = dc_buf(100, 1, 0.5);
        assert!(change_speed(&mut buf, 0.0).is_err());
        assert!(change_speed(&mut buf, -1.0).is_err());
    }

    #[test]
    fn a_non_finite_factor_is_rejected() {
        let mut buf = dc_buf(100, 1, 0.5);
        assert!(change_speed(&mut buf, f64::NAN).is_err());
        assert!(change_speed(&mut buf, f64::INFINITY).is_err());
    }

    #[test]
    fn an_empty_buffer_is_rejected() {
        let mut buf = AudioBuffer {
            samples: vec![],
            sample_rate: 44100,
        };
        assert!(change_speed(&mut buf, 2.0).is_err());

        let mut buf = dc_buf(0, 1, 0.5);
        assert!(change_speed(&mut buf, 2.0).is_err());
    }

    #[test]
    fn a_buffer_shorter_than_one_chunk_still_resamples() {
        let mut buf = dc_buf(300, 1, 0.5);
        change_speed(&mut buf, 2.0).unwrap();
        assert_eq!(buf.num_frames(), 150);
    }
}
