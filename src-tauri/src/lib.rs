mod approval;
mod audio;
mod error;
mod job;
mod menu;
mod ops;
mod tags;

use anyhow::Result;
use approval::Approved;
use audio::AudioBuffer;
use error::CmdError;
use job::Job;
use ops::{fade, filter, normalize, speed, trim};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize, Debug)]
struct AudioInfo {
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
    /// `"linear"` (the default) or `"equal-power"`.
    #[serde(default)]
    fade_curve: Option<String>,
    normalize: bool,
    speed: Option<f64>,
    filters: Vec<String>,
    /// WAV sample format: `"float32"` (the default), `"pcm24"` or `"pcm16"`.
    #[serde(default)]
    wav_depth: Option<String>,
}

/// The last decoded file. Opening a file decodes it once; the export that
/// follows reuses that decode instead of reading the whole file again. A file
/// edited on disk in between is detected by its size and modification time.
struct Cached {
    path: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
    audio: Arc<AudioBuffer>,
}

#[derive(Default, Clone)]
pub struct DecodeCache(Arc<Mutex<Option<Cached>>>);

impl DecodeCache {
    fn get_or_decode(&self, path: &str) -> Result<Arc<AudioBuffer>> {
        let meta = std::fs::metadata(path).ok();
        let stamp = meta.as_ref().map(|m| (m.modified().ok(), m.len()));

        if let Some((modified, len)) = stamp {
            let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(c) = guard.as_ref() {
                if c.path.as_path() == Path::new(path) && c.modified == modified && c.len == len {
                    return Ok(c.audio.clone());
                }
            }
        }

        // Decoded outside the lock: it can take seconds.
        let audio = Arc::new(audio::decode(path)?);
        if let Some((modified, len)) = stamp {
            *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Cached {
                path: PathBuf::from(path),
                modified,
                len,
                audio: audio.clone(),
            });
        }
        Ok(audio)
    }
}

/// Extensions the file picker offers and the OS file associations declare.
const AUDIO_EXTENSIONS: [&str; 11] = [
    "mp3", "wav", "flac", "ogg", "aac", "m4a", "aif", "aiff", "caf", "mka", "webm",
];

/// The audio file named on a command line, if any: what "Open with…" and
/// `lightcutsoundz song.mp3` pass in. The first argument is the program itself.
fn audio_file_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find(|a| {
        let p = Path::new(a);
        let known = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        known && p.is_file()
    })
}

/// A file the app was asked to open before its window could listen for it.
#[derive(Default)]
struct PendingOpen(Mutex<Option<String>>);

/// Hands the front end the file given at launch, once.
#[tauri::command]
fn take_pending_file(pending: State<'_, PendingOpen>) -> Option<String> {
    pending.0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// Tells the running front end to open `path`, and brings its window forward.
fn open_in_window<R: Runtime>(app: &AppHandle<R>, path: String) {
    app.state::<Approved>().allow_input(&path);
    let _ = app.emit("open-file", path);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
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

fn load_audio_blocking(cache: &DecodeCache, path: &str, points: usize) -> Result<AudioInfo> {
    let buf = cache.get_or_decode(path)?;
    Ok(AudioInfo {
        duration: buf.duration_secs(),
        channels: buf.channels(),
        sample_rate: buf.sample_rate,
        waveform: compute_waveform(&buf, points),
    })
}

/// Runs `job` on the blocking pool: decoding, DSP and the wait for ffmpeg would
/// otherwise occupy an async worker shared with IPC and the plugins.
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T, CmdError> {
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(result) => result.map_err(CmdError::from),
        Err(e) => Err(anyhow::anyhow!("Background task failed: {e}").into()),
    }
}

/// Lets the WebView read this one file through the `asset:` protocol, which
/// serves the audio preview. The static scope is empty: nothing is readable
/// until the user has picked or dropped the file.
fn authorize<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<()> {
    app.state::<Approved>().check_input(path)?;
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|e| anyhow::anyhow!("Cannot open '{path}' for preview: {e}"))
}

#[tauri::command]
async fn allow_asset<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), CmdError> {
    authorize(&app, &path).map_err(CmdError::from)
}

#[tauri::command]
async fn load_audio(
    approved: State<'_, Approved>,
    cache: State<'_, DecodeCache>,
    path: String,
    points: usize,
) -> Result<AudioInfo, CmdError> {
    approved.check_input(&path).map_err(CmdError::from)?;
    let cache = cache.inner().clone();
    blocking(move || load_audio_blocking(&cache, &path, points)).await
}

/// A native file dialog on the blocking pool (it waits for the user), parented
/// to the main window.
async fn dialog<R: Runtime>(
    app: &AppHandle<R>,
    build: impl FnOnce(tauri_plugin_dialog::FileDialogBuilder<R>) -> Option<tauri_plugin_dialog::FilePath>
        + Send
        + 'static,
) -> Result<Option<String>, CmdError> {
    let handle = app.clone();
    let picked = blocking(move || {
        let mut dialog = handle.dialog().file();
        if let Some(window) = handle.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        Ok(build(dialog))
    })
    .await?;
    picked
        .map(|p| {
            let path = p.into_path().map_err(anyhow::Error::from)?;
            path.to_str()
                .map(String::from)
                .ok_or_else(|| anyhow::anyhow!("The chosen path is not valid UTF-8"))
        })
        .transpose()
        .map_err(CmdError::from)
}

/// The file picker. Only what it returns can be opened.
#[tauri::command]
async fn pick_audio_file<R: Runtime>(
    app: AppHandle<R>,
    approved: State<'_, Approved>,
) -> Result<Option<String>, CmdError> {
    let picked = dialog(&app, |d| {
        d.add_filter("Audio", &AUDIO_EXTENSIONS)
            .blocking_pick_file()
    })
    .await?;
    if let Some(path) = &picked {
        approved.allow_input(path);
    }
    Ok(picked)
}

/// The save dialog, offering `default_path`. The extension of the chosen format
/// is added if the user left it off, and only the result can be written to.
#[tauri::command]
async fn pick_output_file<R: Runtime>(
    app: AppHandle<R>,
    approved: State<'_, Approved>,
    default_path: String,
    ext: String,
) -> Result<Option<String>, CmdError> {
    let (dir, name) = split_default_path(&default_path);
    let filter_ext = ext.clone();
    let picked = dialog(&app, move |mut d| {
        if let Some(dir) = dir.filter(|d| d.is_dir()) {
            d = d.set_directory(dir);
        }
        if let Some(name) = name {
            d = d.set_file_name(name);
        }
        d.add_filter(filter_ext.to_uppercase(), &[filter_ext.as_str()])
            .blocking_save_file()
    })
    .await?;
    Ok(picked.map(|path| {
        let path = approval::ensure_extension(&path, &ext);
        approved.allow_output(&path);
        path
    }))
}

/// Directory and file name of the suggested output path.
fn split_default_path(default_path: &str) -> (Option<PathBuf>, Option<String>) {
    let p = Path::new(default_path);
    (
        p.parent().map(Path::to_path_buf),
        p.file_name().and_then(|n| n.to_str()).map(String::from),
    )
}

fn wav_depth(opts: &ProcessOptions) -> Result<audio::WavDepth> {
    match &opts.wav_depth {
        Some(name) => audio::WavDepth::parse(name),
        None => Ok(audio::WavDepth::default()),
    }
}

fn check_format(opts: &ProcessOptions) -> Result<()> {
    match opts.format.as_str() {
        "wav" => wav_depth(opts).map(|_| ()),
        other => audio::ffmpeg_target(other).map(|_| ()),
    }
}

/// trim → fades → speed → filters → normalise. Normalising comes last on
/// purpose: speed and filters change the peak, and the promised −1 dBFS must
/// describe the file that is actually written.
fn run_pipeline(opts: &ProcessOptions, buf: &mut AudioBuffer, job: &Job) -> Result<()> {
    job.check()?;
    if opts.trim_start.is_some() || opts.trim_end.is_some() {
        let start = opts.trim_start.unwrap_or(0.0);
        let end = opts.trim_end.unwrap_or_else(|| buf.duration_secs());
        trim::trim(buf, start, end)?;
    }
    let curve = match &opts.fade_curve {
        Some(name) => fade::Curve::parse(name)?,
        None => fade::Curve::default(),
    };
    if let Some(secs) = opts.fade_in {
        if secs > 0.0 {
            fade::fade_in(buf, secs, curve)?;
        }
    }
    if let Some(secs) = opts.fade_out {
        if secs > 0.0 {
            fade::fade_out(buf, secs, curve)?;
        }
    }
    if let Some(factor) = opts.speed {
        if (factor - 1.0).abs() > 1e-6 {
            speed::change_speed(buf, factor, job)?;
        }
    }
    for spec_str in &opts.filters {
        job.check()?;
        let spec = filter::FilterSpec::parse(spec_str)?;
        filter::apply_filter(buf, &spec)?;
    }
    if opts.normalize {
        job.check()?;
        normalize::normalize(buf)?;
    }
    Ok(())
}

/// Decoding is the first tenth of an export, the edits (resampling is the slow
/// part) the next three, and writing the file the rest.
fn process_blocking(cache: &DecodeCache, opts: &ProcessOptions, job: &Job) -> Result<()> {
    check_format(opts)?;
    // The cached decode is shared, so the pipeline works on its own copy.
    let mut buf = (*cache.get_or_decode(&opts.input)?).clone();
    job.progress(0.1);
    run_pipeline(opts, &mut buf, &job.slice(0.1, 0.4))?;

    let write = job.slice(0.4, 1.0);
    match opts.format.as_str() {
        "wav" => audio::encode_wav(&buf, &opts.output, wav_depth(opts)?, &write),
        fmt => {
            // Read from the source, not carried by the cached decode: probing
            // the headers again costs milliseconds.
            let tags = tags::read(&opts.input);
            audio::encode_via_ffmpeg(&buf, &opts.output, fmt, &tags, &write)
        }
    }?;
    job.progress(1.0);
    Ok(())
}

/// Set by the front end's Cancel button, read by the running export.
#[derive(Default)]
struct ExportControl(Arc<AtomicBool>);

#[tauri::command]
async fn process_audio<R: Runtime>(
    app: AppHandle<R>,
    approved: State<'_, Approved>,
    cache: State<'_, DecodeCache>,
    control: State<'_, ExportControl>,
    opts: ProcessOptions,
) -> Result<(), CmdError> {
    approved.check_input(&opts.input).map_err(CmdError::from)?;
    approved
        .check_output(&opts.output)
        .map_err(CmdError::from)?;
    let cache = cache.inner().clone();
    let cancel = control.0.clone();
    cancel.store(false, Ordering::Relaxed);

    // One event per percent, not one per block.
    let last = AtomicU8::new(255);
    let job = Job::new(cancel, move |fraction| {
        let percent = (fraction * 100.0) as u8;
        if last.swap(percent, Ordering::Relaxed) != percent {
            let _ = app.emit("export-progress", percent);
        }
    });
    blocking(move || process_blocking(&cache, &opts, &job)).await
}

#[tauri::command]
fn cancel_export(control: State<'_, ExportControl>) {
    control.0.store(true, Ordering::Relaxed);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch_file = audio_file_from_args(std::env::args());
    let approved = Approved::default();
    if let Some(path) = &launch_file {
        approved.allow_input(path);
    }
    let builder = tauri::Builder::default();

    // A second launch ("Open with…" while the app is running) hands its file to
    // the first instance instead of starting another window.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if let Some(path) = audio_file_from_args(args) {
            open_in_window(app, path);
        }
    }));

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(approved)
        .manage(DecodeCache::default())
        .manage(ExportControl::default())
        .manage(PendingOpen(Mutex::new(launch_file)))
        .setup(|app| {
            // English at startup; the front end calls `set_menu_language` with the
            // saved language as soon as it is ready.
            menu::install(app.handle(), menu::Lang::default())?;
            Ok(())
        })
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        // A file dropped on the window is the user's own act: the only way, besides
        // the dialogs, to name a file the app may open.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let approved = window.state::<Approved>();
                for path in paths {
                    approved.allow_input(path);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            allow_asset,
            pick_audio_file,
            pick_output_file,
            load_audio,
            process_audio,
            cancel_export,
            take_pending_file,
            menu::set_menu_language,
        ])
        .build(tauri::generate_context!())
        .expect("error building soundZ");

    app.run(|handle, event| {
        // macOS delivers "Open with…" as an event rather than as an argument.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            let first = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .find_map(|p| p.to_str().map(String::from));
            if let Some(path) = first {
                *handle
                    .state::<PendingOpen>()
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(path.clone());
                open_in_window(handle, path);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (handle, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::coded;
    use std::sync::atomic::Ordering as AtomicOrdering;

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
        audio::encode_wav(&buf, &path, audio::WavDepth::Float32, &Job::detached()).unwrap();
        path
    }

    fn buf_of(frames: usize, channels: usize) -> AudioBuffer {
        AudioBuffer {
            samples: vec![vec![0.5f32; frames]; channels],
            sample_rate: 44100,
        }
    }

    fn peak(buf: &AudioBuffer) -> f32 {
        buf.samples
            .iter()
            .flat_map(|c| c.iter())
            .map(|s| s.abs())
            .fold(0.0, f32::max)
    }

    fn code_of(e: anyhow::Error) -> String {
        CmdError::from(e).code
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

    // ── command line ────────────────────────────────────────────────────

    #[test]
    fn an_audio_file_on_the_command_line_is_picked_up() {
        let dir = tempfile::tempdir().unwrap();
        let song = write_wav(&dir, "Song.WAV", 10, 1);
        let args = vec!["app".to_string(), song.clone()];
        assert_eq!(audio_file_from_args(args), Some(song));
    }

    #[test]
    fn the_program_name_is_never_mistaken_for_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let song = write_wav(&dir, "song.wav", 10, 1);
        assert_eq!(audio_file_from_args(vec![song]), None);
    }

    #[test]
    fn flags_missing_files_and_other_types_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, b"x").unwrap();
        let args = vec![
            "app".to_string(),
            "--flag".to_string(),
            "/nonexistent-dir-lcs/ghost.mp3".to_string(),
            text.to_str().unwrap().to_string(),
        ];
        assert_eq!(audio_file_from_args(args), None);
    }

    #[test]
    fn the_launch_file_is_handed_over_once() {
        let app = tauri::test::mock_app();
        app.manage(PendingOpen(Mutex::new(Some("/a/b.mp3".into()))));
        let state = app.state::<PendingOpen>();
        assert_eq!(take_pending_file(state.clone()), Some("/a/b.mp3".into()));
        assert_eq!(take_pending_file(state), None);
    }

    // ── load_audio ──────────────────────────────────────────────────────

    #[test]
    fn load_audio_returns_info_and_waveform_in_one_call() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_wav(&dir, "in.wav", 4410, 2);
        let info = load_audio_blocking(&DecodeCache::default(), &path, 100).unwrap();
        assert_eq!(info.channels, 2);
        assert_eq!(info.sample_rate, 44100);
        assert!((info.duration - 0.1).abs() < 1e-6);
        assert_eq!(info.waveform.len(), 100);
    }

    #[test]
    fn load_audio_survives_a_file_shorter_than_the_point_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_wav(&dir, "tiny.wav", 100, 1);
        let info = load_audio_blocking(&DecodeCache::default(), &path, 900).unwrap();
        assert_eq!(info.waveform.len(), 100);
    }

    #[test]
    fn load_audio_reports_a_missing_file_as_an_error() {
        let err = load_audio_blocking(&DecodeCache::default(), "/nonexistent-dir-lcs/x.wav", 900)
            .unwrap_err();
        assert_eq!(code_of(err), "cannot_open");
    }

    // ── decode cache ────────────────────────────────────────────────────

    #[test]
    fn a_second_read_of_the_same_file_reuses_the_decode() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_wav(&dir, "in.wav", 4410, 1);
        let cache = DecodeCache::default();

        let first = cache.get_or_decode(&path).unwrap();
        let second = cache.get_or_decode(&path).unwrap();

        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn a_file_rewritten_on_disk_is_decoded_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_wav(&dir, "in.wav", 4410, 1);
        let cache = DecodeCache::default();
        let first = cache.get_or_decode(&path).unwrap();

        write_wav(&dir, "in.wav", 8820, 1);
        let second = cache.get_or_decode(&path).unwrap();

        assert!(!Arc::ptr_eq(&first, &second));
        assert_eq!(second.num_frames(), 8820);
    }

    #[test]
    fn a_different_file_replaces_the_cached_one() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_wav(&dir, "a.wav", 1000, 1);
        let b = write_wav(&dir, "b.wav", 2000, 1);
        let cache = DecodeCache::default();

        cache.get_or_decode(&a).unwrap();
        assert_eq!(cache.get_or_decode(&b).unwrap().num_frames(), 2000);
        assert_eq!(cache.get_or_decode(&a).unwrap().num_frames(), 1000);
    }

    #[test]
    fn a_failed_decode_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("junk.wav").to_str().unwrap().to_string();
        std::fs::write(&path, b"not audio").unwrap();
        let cache = DecodeCache::default();

        assert!(cache.get_or_decode(&path).is_err());
        assert!(cache.0.lock().unwrap().is_none());
    }

    #[test]
    fn editing_the_working_copy_never_touches_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let cache = DecodeCache::default();
        let mut opts = base_opts(input.clone(), output);
        opts.trim_end = Some(0.05);

        process_blocking(&cache, &opts, &Job::detached()).unwrap();

        assert_eq!(cache.get_or_decode(&input).unwrap().num_frames(), 4410);
    }

    // ── approved paths and the asset protocol scope ─────────────────────

    /// A mock app with the state the commands read.
    fn mock_app_with_state() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(Approved::default());
        app.manage(DecodeCache::default());
        app.manage(ExportControl::default());
        app
    }

    #[test]
    fn only_the_authorised_file_becomes_readable_by_the_webview() {
        let app = mock_app_with_state();
        let scope = app.handle().asset_protocol_scope();
        let dir = tempfile::tempdir().unwrap();
        let picked = write_wav(&dir, "picked.wav", 10, 1);
        let other = write_wav(&dir, "other.wav", 10, 1);
        app.state::<Approved>().allow_input(&picked);
        app.state::<Approved>().allow_input(&other);
        assert!(!scope.is_allowed(&picked));

        authorize(app.handle(), &picked).unwrap();

        assert!(scope.is_allowed(&picked));
        assert!(!scope.is_allowed(&other));
    }

    #[test]
    fn a_file_in_a_hidden_folder_can_be_authorised() {
        let app = mock_app_with_state();
        let dir = tempfile::tempdir().unwrap();
        let hidden = dir.path().join(".local").join("share");
        std::fs::create_dir_all(&hidden).unwrap();
        let path = hidden.join("song.wav").to_str().unwrap().to_string();
        std::fs::write(&path, b"x").unwrap();
        app.state::<Approved>().allow_input(&path);

        authorize(app.handle(), &path).unwrap();

        assert!(app.handle().asset_protocol_scope().is_allowed(&path));
    }

    #[test]
    fn a_file_nobody_chose_cannot_be_made_readable() {
        let app = mock_app_with_state();
        let err = authorize(app.handle(), "/home/me/.ssh/id_rsa").unwrap_err();
        assert_eq!(code_of(err), "path_not_approved");
        assert!(!app
            .handle()
            .asset_protocol_scope()
            .is_allowed("/home/me/.ssh/id_rsa"));
    }

    #[test]
    fn the_allow_asset_command_enforces_the_same_rule() {
        let app = mock_app_with_state();
        let dir = tempfile::tempdir().unwrap();
        let path = write_wav(&dir, "a.wav", 10, 1);
        let handle = app.handle().clone();

        let err =
            tauri::async_runtime::block_on(allow_asset(handle.clone(), path.clone())).unwrap_err();
        assert_eq!(err.code, "path_not_approved");

        app.state::<Approved>().allow_input(&path);
        tauri::async_runtime::block_on(allow_asset(handle, path)).unwrap();
    }

    #[test]
    fn load_audio_refuses_a_path_the_user_never_chose() {
        let app = mock_app_with_state();
        let dir = tempfile::tempdir().unwrap();
        let path = write_wav(&dir, "a.wav", 4410, 1);

        let refused =
            tauri::async_runtime::block_on(load_audio(app.state(), app.state(), path.clone(), 10));
        assert_eq!(refused.unwrap_err().code, "path_not_approved");

        app.state::<Approved>().allow_input(&path);
        let info =
            tauri::async_runtime::block_on(load_audio(app.state(), app.state(), path, 10)).unwrap();
        assert_eq!(info.waveform.len(), 10);
    }

    fn export_via_command(
        app: &tauri::App<tauri::test::MockRuntime>,
        input: &str,
        output: &str,
    ) -> Result<(), CmdError> {
        tauri::async_runtime::block_on(process_audio(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            base_opts(input.into(), output.into()),
        ))
    }

    #[test]
    fn process_audio_refuses_an_unapproved_source_or_destination() {
        let app = mock_app_with_state();
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 100, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();

        assert_eq!(
            export_via_command(&app, &input, &output).unwrap_err().code,
            "path_not_approved"
        );

        app.state::<Approved>().allow_input(&input);
        let err = export_via_command(&app, &input, &output).unwrap_err();
        assert_eq!(err.code, "path_not_approved");
        assert_eq!(err.params["path"], output);
        assert!(!Path::new(&output).exists());

        app.state::<Approved>().allow_output(&output);
        export_via_command(&app, &input, &output).unwrap();
        assert!(Path::new(&output).exists());
    }

    #[test]
    fn an_export_cannot_overwrite_a_file_that_was_only_opened() {
        let app = mock_app_with_state();
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 100, 1);
        app.state::<Approved>().allow_input(&input);

        // Opening a file does not make it a valid destination.
        let err = export_via_command(&app, &input, &input).unwrap_err();
        assert_eq!(err.code, "path_not_approved");
    }

    #[test]
    fn a_dropped_or_launched_file_is_opened_through_the_same_door() {
        let app = mock_app_with_state();
        let dir = tempfile::tempdir().unwrap();
        let path = write_wav(&dir, "dropped.wav", 4410, 1);
        // What the window-event and open-file handlers record.
        open_in_window(app.handle(), path.clone());

        assert!(app.state::<Approved>().check_input(&path).is_ok());
    }

    #[test]
    fn the_suggested_output_path_is_split_into_folder_and_name() {
        let (dir, name) = split_default_path("/home/me/music/song-edit.mp3");
        assert_eq!(dir, Some(PathBuf::from("/home/me/music")));
        assert_eq!(name.as_deref(), Some("song-edit.mp3"));
        let (dir, name) = split_default_path("song-edit.mp3");
        assert_eq!(dir, Some(PathBuf::from("")));
        assert_eq!(name.as_deref(), Some("song-edit.mp3"));
        assert_eq!(split_default_path("").1, None);
    }

    #[test]
    fn the_picker_offers_every_format_the_decoder_reads() {
        for ext in [
            "mp3", "wav", "flac", "ogg", "aac", "m4a", "aif", "aiff", "caf", "mka", "webm",
        ] {
            assert!(AUDIO_EXTENSIONS.contains(&ext), "{ext}");
        }
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
            fade_curve: None,
            normalize: false,
            speed: None,
            filters: vec![],
            wav_depth: None,
        }
    }

    fn process(opts: &ProcessOptions) -> Result<()> {
        process_blocking(&DecodeCache::default(), opts, &Job::detached())
    }

    #[test]
    fn process_audio_writes_a_wav_passthrough() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 2);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        process(&base_opts(input, output.clone())).unwrap();

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

        process(&opts).unwrap();

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
    fn normalising_is_the_last_step_so_the_peak_is_what_the_label_says() {
        // Regression: normalising before the filter or the speed change left
        // peaks of +4 dBFS (high-pass on a square wave) in the written file.
        let square = |hz: usize| -> Vec<f32> {
            (0..44_100)
                .map(|i| {
                    if (i * hz * 2 / 44_100) & 1 == 0 {
                        0.6
                    } else {
                        -0.6
                    }
                })
                .collect()
        };
        for (speed, filters) in [
            (None, vec!["highpass:1000".to_string()]),
            (Some(1.5), vec![]),
            (Some(1.5), vec!["highpass:1000".to_string()]),
        ] {
            let mut buf = AudioBuffer {
                samples: vec![square(100)],
                sample_rate: 44100,
            };
            let mut opts = base_opts(String::new(), String::new());
            opts.normalize = true;
            opts.speed = speed;
            opts.filters = filters;

            run_pipeline(&opts, &mut buf, &Job::detached()).unwrap();

            assert!(
                (peak(&buf) - normalize::TARGET_PEAK).abs() < 1e-4,
                "peak {} after {:?} {:?}",
                peak(&buf),
                opts.speed,
                opts.filters
            );
        }
    }

    #[test]
    fn overlapping_fades_multiply() {
        let mut buf = buf_of(1000, 1);
        buf.sample_rate = 1000;
        let mut opts = base_opts(String::new(), String::new());
        opts.fade_in = Some(0.8);
        opts.fade_out = Some(0.8);

        run_pipeline(&opts, &mut buf, &Job::detached()).unwrap();

        // At frame 500 the fade-in ramp is at 500/799 and the fade-out at
        // 1 - 300/799, over a source of 0.5: the two multiply (≈ 0.195).
        let expected = 0.5 * (500.0 / 799.0) * (1.0 - 300.0 / 799.0);
        assert!((buf.samples[0][500] - expected).abs() < 1e-4);
    }

    #[test]
    fn the_fade_curve_option_selects_the_shape() {
        let run = |curve: Option<&str>| {
            let mut buf = buf_of(101, 1);
            buf.sample_rate = 101;
            let mut opts = base_opts(String::new(), String::new());
            opts.fade_in = Some(1.0);
            opts.fade_curve = curve.map(String::from);
            run_pipeline(&opts, &mut buf, &Job::detached()).map(|_| buf.samples[0][50])
        };
        assert!((run(None).unwrap() - 0.25).abs() < 0.01);
        assert!((run(Some("linear")).unwrap() - 0.25).abs() < 0.01);
        assert!(
            (run(Some("equal-power")).unwrap() - 0.5 * std::f32::consts::FRAC_1_SQRT_2).abs()
                < 0.01
        );
        assert_eq!(code_of(run(Some("bogus")).unwrap_err()), "fade_curve");
    }

    #[test]
    fn a_quiet_region_can_be_exported_with_normalise_checked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("quiet.wav").to_str().unwrap().to_string();
        audio::encode_wav(
            &AudioBuffer {
                samples: vec![vec![0.0; 4410]],
                sample_rate: 44100,
            },
            &path,
            audio::WavDepth::Float32,
            &Job::detached(),
        )
        .unwrap();
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(path, output.clone());
        opts.normalize = true;

        process(&opts).unwrap();

        assert_eq!(audio::decode(&output).unwrap().num_frames(), 4410);
    }

    #[test]
    fn process_audio_trims_with_only_a_start_bound() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 44_100, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output.clone());
        opts.trim_start = Some(0.5);

        process(&opts).unwrap();
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

        process(&opts).unwrap();
        let decoded = audio::decode(&output).unwrap();
        assert_eq!(decoded.num_frames(), 11_025);
    }

    #[test]
    fn process_audio_rejects_an_unknown_format_before_doing_any_work() {
        let dir = tempfile::tempdir().unwrap();
        // The input does not even exist: the format is checked first.
        let output = dir.path().join("out.xyz").to_str().unwrap().to_string();
        let mut opts = base_opts("/nonexistent-dir-lcs/x.wav".into(), output);
        opts.format = "xyz".into();
        assert_eq!(code_of(process(&opts).unwrap_err()), "unknown_format");
    }

    #[test]
    fn process_audio_reports_an_invalid_filter_spec() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 1000, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output);
        opts.filters = vec!["notch:100".into()];
        assert_eq!(code_of(process(&opts).unwrap_err()), "filter_spec");
    }

    #[test]
    fn process_audio_reports_an_invalid_trim_range() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output);
        opts.trim_start = Some(0.05);
        opts.trim_end = Some(5.0);
        assert_eq!(code_of(process(&opts).unwrap_err()), "trim_range");
    }

    #[test]
    fn process_audio_reports_a_missing_input() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let opts = base_opts("/nonexistent-dir-lcs/x.wav".into(), output);
        assert_eq!(code_of(process(&opts).unwrap_err()), "cannot_open");
    }

    #[test]
    fn process_audio_ignores_a_neutral_speed_factor() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let mut opts = base_opts(input, output.clone());
        opts.speed = Some(1.0);

        process(&opts).unwrap();
        assert_eq!(audio::decode(&output).unwrap().num_frames(), 4410);
    }

    #[test]
    fn overwriting_the_source_file_works_and_goes_through_a_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 1);
        let mut opts = base_opts(input.clone(), input.clone());
        opts.trim_end = Some(0.05);

        process(&opts).unwrap();

        assert_eq!(audio::decode(&input).unwrap().num_frames(), 2205);
    }

    #[test]
    fn a_failing_export_leaves_the_existing_output_intact() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        std::fs::write(&output, b"precious").unwrap();
        let mut opts = base_opts(input, output.clone());
        opts.filters = vec!["lowpass:99999".into()];

        assert!(process(&opts).is_err());

        assert_eq!(std::fs::read(&output).unwrap(), b"precious");
    }

    #[test]
    fn a_cancelled_export_writes_nothing_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 4410, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let flag = Arc::new(AtomicBool::new(false));
        let job = Job::new(flag.clone(), |_| {});
        flag.store(true, AtomicOrdering::Relaxed);

        let err = process_blocking(
            &DecodeCache::default(),
            &base_opts(input, output.clone()),
            &job,
        )
        .unwrap_err();

        assert_eq!(code_of(err), "cancelled");
        assert!(!std::path::Path::new(&output).exists());
    }

    #[test]
    fn an_export_reports_progress_from_start_to_finish() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_wav(&dir, "in.wav", 200_000, 1);
        let output = dir.path().join("out.wav").to_str().unwrap().to_string();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let job = Job::new(Arc::new(AtomicBool::new(false)), move |f| {
            sink.lock().unwrap().push(f)
        });
        let mut opts = base_opts(input, output);
        opts.speed = Some(1.5);

        process_blocking(&DecodeCache::default(), &opts, &job).unwrap();

        let seen = seen.lock().unwrap();
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
        assert_eq!(*seen.last().unwrap(), 1.0);
    }

    #[test]
    fn the_cancel_command_raises_the_flag_the_next_export_resets() {
        let app = tauri::test::mock_app();
        app.manage(ExportControl::default());
        cancel_export(app.state::<ExportControl>());
        assert!(app.state::<ExportControl>().0.load(AtomicOrdering::Relaxed));
    }

    #[test]
    fn the_blocking_helper_converts_failures_to_command_errors() {
        tauri::async_runtime::block_on(async {
            assert_eq!(blocking(|| Ok(7)).await.unwrap(), 7);
            let err = blocking::<()>(|| Err(coded("trim_empty", &[], "x")))
                .await
                .unwrap_err();
            assert_eq!(err.code, "trim_empty");
            let err = blocking::<()>(|| panic!("boom")).await.unwrap_err();
            assert_eq!(err.code, "generic");
        });
    }
}
