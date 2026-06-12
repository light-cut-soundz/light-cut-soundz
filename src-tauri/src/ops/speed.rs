use crate::audio::AudioBuffer;
use anyhow::{bail, Result};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub fn change_speed(buf: &mut AudioBuffer, factor: f64) -> Result<()> {
    if factor <= 0.0 {
        bail!("Speed factor must be positive");
    }
    if (factor - 1.0).abs() < 1e-6 {
        return Ok(());
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

    let mut resampler =
        SincFixedIn::<f32>::new(resample_ratio, 2.0, params, chunk_size, buf.channels)?;

    let frames = buf.num_frames();
    let mut output: Vec<Vec<f32>> = vec![Vec::new(); buf.channels];

    let mut pos = 0usize;
    loop {
        let end = (pos + chunk_size).min(frames);
        let chunk: Vec<Vec<f32>> = (0..buf.channels)
            .map(|ch| {
                let mut v = buf.samples[ch][pos..end].to_vec();
                if v.len() < chunk_size {
                    v.resize(chunk_size, 0.0);
                }
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

    // Flush remaining
    let zeros: Vec<Vec<f32>> = vec![vec![0.0f32; chunk_size]; buf.channels];
    let out = resampler.process(&zeros, None)?;
    for (ch, ch_out) in out.iter().enumerate() {
        output[ch].extend_from_slice(ch_out);
    }

    // Trim to expected length
    let expected = (frames as f64 * resample_ratio).round() as usize;
    for ch in output.iter_mut() {
        ch.truncate(expected);
    }

    buf.samples = output;
    Ok(())
}
