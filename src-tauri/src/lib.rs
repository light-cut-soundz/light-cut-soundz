mod audio;
mod ops;

use ops::{fade, filter, normalize, speed, trim};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct AudioInfo {
    path: String,
    duration: f64,
    channels: usize,
    sample_rate: u32,
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

#[tauri::command]
async fn load_audio(path: String) -> Result<AudioInfo, String> {
    let buf = audio::decode(&path).map_err(|e| e.to_string())?;
    Ok(AudioInfo {
        path: path.clone(),
        duration: buf.duration_secs(),
        channels: buf.channels,
        sample_rate: buf.sample_rate,
    })
}

#[tauri::command]
async fn get_waveform(path: String, points: usize) -> Result<Vec<f32>, String> {
    let buf = audio::decode(&path).map_err(|e| e.to_string())?;
    let frames = buf.num_frames();
    if frames == 0 {
        return Ok(vec![]);
    }
    let chunk = (frames / points).max(1);
    let data: Vec<f32> = (0..points)
        .map(|i| {
            let start = i * chunk;
            let end = ((i + 1) * chunk).min(frames);
            buf.samples[0][start..end]
                .iter()
                .map(|s| s.abs())
                .fold(0.0f32, f32::max)
        })
        .collect();
    Ok(data)
}

#[tauri::command]
async fn process_audio(opts: ProcessOptions) -> Result<(), String> {
    let mut buf = audio::decode(&opts.input).map_err(|e| e.to_string())?;

    if let (Some(start), Some(end)) = (opts.trim_start, opts.trim_end) {
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
        .invoke_handler(tauri::generate_handler![
            load_audio,
            get_waveform,
            process_audio,
        ])
        .run(tauri::generate_context!())
        .expect("error running soundZ");
}
