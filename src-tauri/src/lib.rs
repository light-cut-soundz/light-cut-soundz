mod audio;
mod menu;
mod ops;

use audio::AudioBuffer;
use ops::{fade, filter, normalize, speed, trim};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Debug)]
struct AudioInfo {
    path: String,
    duration: f64,
    channels: usize,
    sample_rate: u32,
    waveform: Vec<f32>,
}

#[derive(Deserialize)]
struct ProcessOptions {
    input: String,
    output: String,
    format: String,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
    fade_in: Option<f64>,
    fade_out: Option<f64>,
    normalize: bool,
    speed: Option<f64>,
    filters: Vec<String>,
}

/// Peak envelope over `points` buckets covering the whole buffer.
///
/// `points` is clamped to the frame count: asking for more buckets than there
/// are frames used to walk past the end of the slice, and `points == 0` used to
/// divide by zero.
fn compute_waveform(buf: &AudioBuffer, points: usize) -> Vec<f32> {
    let frames = buf.num_frames();
    if frames == 0 || points == 0 {
        return Vec::new();
    }
    let points = points.min(frames);

    (0..points)
        .map(|i| {
            let start = i * frames / points;
            let end = (((i + 1) * frames / points).max(start + 1)).min(frames);
            buf.samples
                .iter()
                .flat_map(|ch| ch[start..end].iter())
                .map(|s| s.abs())
                .fold(0.0f32, f32::max)
        })
        .collect()
}

#[tauri::command]
async fn load_audio(path: String, points: usize) -> Result<AudioInfo, String> {
    // One decode per open: the waveform used to come from a second, parallel
    // decode of the very same file.
    let buf = audio::decode(&path).map_err(|e| e.to_string())?;
    Ok(AudioInfo {
        duration: buf.duration_secs(),
        channels: buf.channels(),
        sample_rate: buf.sample_rate,
        waveform: compute_waveform(&buf, points),
        path,
    })
}

#[tauri::command]
async fn process_audio(opts: ProcessOptions) -> Result<(), String> {
    let mut buf = audio::decode(&opts.input).map_err(|e| e.to_string())?;

    if opts.trim_start.is_some() || opts.trim_end.is_some() {
        let start = opts.trim_start.unwrap_or(0.0);
        let end = opts.trim_end.unwrap_or_else(|| buf.duration_secs());
        trim::trim(&mut buf, start, end).map_err(|e| e.to_string())?;
    }
    if let Some(secs) = opts.fade_in {
        if secs > 0.0 {
            fade::fade_in(&mut buf, secs).map_err(|e| e.to_string())?;
        }
    }
    if let Some(secs) = opts.fade_out {
        if secs > 0.0 {
            fade::fade_out(&mut buf, secs).map_err(|e| e.to_string())?;
        }
    }
    if opts.normalize {
        normalize::normalize(&mut buf).map_err(|e| e.to_string())?;
    }
    if let Some(factor) = opts.speed {
        if (factor - 1.0).abs() > 1e-6 {
            speed::change_speed(&mut buf, factor).map_err(|e| e.to_string())?;
        }
    }
    for spec_str in &opts.filters {
        let spec = filter::FilterSpec::parse(spec_str).map_err(|e| e.to_string())?;
        filter::apply_filter(&mut buf, &spec).map_err(|e| e.to_string())?;
    }

    match opts.format.as_str() {
        "wav" => audio::encode_wav(&buf, &opts.output).map_err(|e| e.to_string())?,
        fmt @ ("mp3" | "flac" | "ogg" | "aac") => {
            audio::encode_via_ffmpeg(&buf, &opts.output, fmt).map_err(|e| e.to_string())?
        }
        other => return Err(format!("Unknown format: {other}")),
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // En anglais au démarrage ; le front rappelle `set_menu_language` avec la
            // langue retenue dès qu'il est prêt.
            menu::install(app.handle(), menu::Lang::default())?;
            Ok(())
        })
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            load_audio,
            process_audio,
            menu::set_menu_language,
        ])
        .run(tauri::generate_context!())
        .expect("error running soundZ");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

    /// The commands are `async fn` that never await, so a single poll with an
    /// inert waker drives them to completion without pulling in a runtime.
    fn noop_vtable() -> &'static RawWakerVTable {
        &RawWakerVTable::new(
            |_| RawWaker::new(std::ptr::null(), noop_vtable()),
            |_| {},
            |_| {},
            |_| {},
        )
    }

    fn block_on<F: Future>(mut fut: F) -> F::Output {
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), noop_vtable())) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = unsafe { Pin::new_unchecked(&mut fut) };
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("command awaited something unexpectedly"),
        }
    }

    fn write_wav(dir: &tempfile::TempDir, name: &str, frames: usize, channels: usize) -> String {
        let path = dir.path().join(name).to_str().unwrap().to_string();
        let buf = AudioBuffer {
            samples: (0..channels)
                .map(|c| {
                    (0..frames)
                        .map(|i| ((i + c) as f32 / frames as f32) - 0.5)
                        .collect()
                })
                .collect(),
            sample_rate: 44100,
        };
        audio::encode_wav(&buf, &path).unwrap();
        path
    }

    fn buf_of(frames: usize, channels: usize) -> AudioBuffer {
        AudioBuffer {
            samples: vec![vec![0.5f32; frames]; channels],
            sample_rate: 44100,
        }
    }

    // ── compute_waveform ────────────────────────────────────────────────

    #[test]
    fn waveform_has_requested_number_of_points() {
        let buf = buf_of(10_000, 1);
        assert_eq!(compute_waveform(&buf, 900).len(), 900);
    }

    #[test]
    fn waveform_clamps_points_to_frame_count() {
        // Regression: 900 points over 100 frames used to index past the slice.
        let buf = buf_of(100, 1);
        assert_eq!(compute_waveform(&buf, 900).len(), 100);
    }

    #[test]
    fn waveform_with_zero_points_is_empty() {
        // Regression: `frames / points` used to divide by zero.
        let buf = buf_of(44_100, 1);
        assert!(compute_waveform(&buf, 0).is_empty());
    }

    #[test]
    fn waveform_of_empty_buffer_is_empty() {
        let buf = AudioBuffer {
            samples: vec![],
            sample_rate: 44100,
        };
        assert!(compute_waveform(&buf, 900).is_empty());
    }

    #[test]
    fn waveform_reports_peaks_from_every_channel() {
        let buf = AudioBuffer {
            samples: vec![vec![0.1f32; 100], vec![0.9f32; 100]],
            sample_rate: 44100,
        };
        let wave = compute_waveform(&buf, 10);
        assert!(wave.iter().all(|v| (v - 0.9).abs() < 1e-6));
    }

    #[test]
    fn waveform_covers_the_tail_of_the_buffer() {
        let mut buf = buf_of(1000, 1);
        for s in buf.samples[0].iter_mut() {
            *s = 0.0;
        }
        buf.samples[0][999] = 1.0;
        let wave = compute_waveform(&buf, 10);
        assert!(
            (wave[9] - 1.0).abs() < 1e-6,
            "last bucket must see the tail"
        );
    }

    #[test]
    fn waveform_single_point_is_the_global_peak() {
        let mut buf = buf_of(500, 1);
        buf.samples[0][250] = -0.75;
        let wave = compute_waveform(&buf, 1);
        assert_eq!(wave.len(), 1);
        assert!((wave[0] - 0.75).abs() < 1e-6);
    }

    // ── load_audio ──────────────────────────────────────────────────────

    #[test]
    fn load_audio_returns_info_and_waveform_in_one_call() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_wav(&dir, "in.wav", 4410, 2);
        let info = block_on(load_audio(path.clone(), 100)).unwrap();
        assert_eq!(info.path, path);
        assert_eq!(info.channels, 2);
        assert_eq!(info.sample_rate, 44100);
        assert!((info.duration - 0.1).abs() < 1e-6);
        assert_eq!(info.waveform.len(), 100);
    }

    #[test]
    fn load_audio_survives_a_file_shorter_than_the_point_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_wav(&dir, "tiny.wav", 100, 1);
        let info = block_on(load_audio(path, 900)).unwrap();
        assert_eq!(info.waveform.len(), 100);
    }

    #[test]
    fn load_audio_reports_a_missing_file_as_an_error() {
        let err = block_on(load_audio("/nonexistent-dir-lcs/x.wav".into(), 900)).unwrap_err();
        assert!(err.contains("Cannot open"));
    }

    // ── process_audio ───────────────────────────────────────────────────

    fn base_opts(input: String, output: String) -> ProcessOptions {
        ProcessOptions {
            input,
            output,
            format: "wav".into(),
            trim_start: None,
            trim_end: None,
            fade_in: None,
            fade_out: None,
            normalize: false,
            speed: None,
            filters: vec![],
        }
    }

    #[test]
    fn process_audio_writes_a_wav_passthrough() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 2);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        block_on(process_audio(base_opts(input, output.clone()))).unwrap();

        let decoded = audio::decode(&output).unwrap();
        assert_eq!(decoded.num_frames(), 4410);
        assert_eq!(decoded.channels(), 2);
    }

    #[test]
    fn process_audio_applies_the_whole_chain() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 44_100, 2);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output.clone());
        opts.trim_start = Some(0.1);
        opts.trim_end = Some(0.6);
        opts.fade_in = Some(0.05);
        opts.fade_out = Some(0.05);
        opts.normalize = true;
        opts.speed = Some(2.0);
        opts.filters = vec!["lowpass:4000".into()];

        block_on(process_audio(opts)).unwrap();

        let decoded = audio::decode(&output).unwrap();
        // 0.5s trimmed, then played back at 2x.
        let expected = (0.25 * 44_100.0) as usize;
        let delta = (decoded.num_frames() as i64 - expected as i64).abs();
        assert!(
            delta < 64,
            "got {} frames, expected ~{expected}",
            decoded.num_frames()
        );
    }

    #[test]
    fn process_audio_trims_with_only_a_start_bound() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 44_100, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output.clone());
        opts.trim_start = Some(0.5);

        block_on(process_audio(opts)).unwrap();
        let decoded = audio::decode(&output).unwrap();
        assert_eq!(decoded.num_frames(), 22_050);
    }

    #[test]
    fn process_audio_trims_with_only_an_end_bound() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 44_100, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output.clone());
        opts.trim_end = Some(0.25);

        block_on(process_audio(opts)).unwrap();
        let decoded = audio::decode(&output).unwrap();
        assert_eq!(decoded.num_frames(), 11_025);
    }

    #[test]
    fn process_audio_rejects_an_unknown_format() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 100, 1);
        let output = dir.path().join("out.xyz").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output);
        opts.format = "xyz".into();
        let err = block_on(process_audio(opts)).unwrap_err();
        assert!(err.contains("Unknown format"));
    }

    #[test]
    fn process_audio_reports_an_invalid_filter_spec() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 1000, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output);
        opts.filters = vec!["notch:100".into()];
        assert!(block_on(process_audio(opts))
            .unwrap_err()
            .contains("Invalid filter spec"));
    }

    #[test]
    fn process_audio_reports_an_invalid_trim_range() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output);
        opts.trim_start = Some(0.05);
        opts.trim_end = Some(5.0);
        assert!(block_on(process_audio(opts))
            .unwrap_err()
            .contains("Invalid trim range"));
    }

    #[test]
    fn process_audio_reports_a_missing_input() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let opts = base_opts("/nonexistent-dir-lcs/x.wav".into(), output);
        assert!(block_on(process_audio(opts))
            .unwrap_err()
            .contains("Cannot open"));
    }

    #[test]
    fn process_audio_ignores_a_neutral_speed_factor() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output.clone());
        opts.speed = Some(1.0);

        block_on(process_audio(opts)).unwrap();
        assert_eq!(audio::decode(&output).unwrap().num_frames(), 4410);
    }
}
