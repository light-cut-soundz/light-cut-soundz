//! The "recent files" list shown on the home screen.
//!
//! Kept by Rust, like the approved paths: the WebView can only ask for the list
//! and for entries to be dropped, never name a path to add. A path enters the
//! list when a file the user picked or dropped has been loaded, and comes back
//! approved for opening when the list is read.

use crate::approval::Approved;
use crate::error::CmdError;
use crate::menu;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, State};

const MAX_RECENT: usize = 10;
const FILE_NAME: &str = "recent.json";

#[derive(Serialize, Debug, PartialEq)]
pub struct RecentFile {
    path: String,
    name: String,
    dir: String,
}

impl RecentFile {
    pub fn name(&self) -> &str {
        &self.name
    }

    #[cfg(test)]
    pub fn for_test(path: &str) -> Self {
        Self::new(path)
    }

    fn new(path: &str) -> Self {
        let p = Path::new(path);
        RecentFile {
            path: path.to_string(),
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            dir: p
                .parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }
}

/// `path` at the top of `list`, moved there if already present, list bounded.
fn pushed(list: Vec<String>, path: &str) -> Vec<String> {
    let mut out = vec![path.to_string()];
    out.extend(list.into_iter().filter(|p| p != path));
    out.truncate(MAX_RECENT);
    out
}

fn read(file: &Path) -> Vec<String> {
    fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(file: &Path, list: &[String]) {
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(list) {
        let _ = fs::write(file, json);
    }
}

fn list_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME))
}

/// Records a file that has just been loaded.
pub fn record<R: Runtime>(app: &AppHandle<R>, path: &str) {
    if let Some(file) = list_file(app) {
        write(&file, &pushed(read(&file), path));
        menu::refresh(app);
    }
}

/// The paths whose file still exists, in order. A file that is gone is dropped
/// from the stored list too.
fn existing_paths<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let Some(file) = list_file(app) else {
        return Vec::new();
    };
    let list = read(&file);
    let kept: Vec<String> = list
        .iter()
        .filter(|p| Path::new(p).is_file())
        .cloned()
        .collect();
    if kept.len() != list.len() {
        write(&file, &kept);
    }
    kept
}

/// The entries whose file still exists.
pub fn existing<R: Runtime>(app: &AppHandle<R>) -> Vec<RecentFile> {
    existing_paths(app)
        .iter()
        .map(|p| RecentFile::new(p))
        .collect()
}

/// The n-th entry of what `existing` returns, as the menu numbers them.
pub fn path_at<R: Runtime>(app: &AppHandle<R>, n: usize) -> Option<String> {
    existing_paths(app).into_iter().nth(n)
}

/// Empties the list.
pub fn clear<R: Runtime>(app: &AppHandle<R>) {
    if let Some(file) = list_file(app) {
        write(&file, &[]);
    }
}

/// The recent files, each approved for opening.
#[tauri::command]
pub fn get_recent<R: Runtime>(app: AppHandle<R>, approved: State<'_, Approved>) -> Vec<RecentFile> {
    let list = existing(&app);
    for file in &list {
        approved.allow_input(&file.path);
    }
    list
}

/// Drops one entry, or all of them when `path` is `None`.
#[tauri::command]
pub fn forget_recent<R: Runtime>(app: AppHandle<R>, path: Option<String>) -> Result<(), CmdError> {
    if let Some(file) = list_file(&app) {
        let list = match path {
            Some(p) => read(&file).into_iter().filter(|q| *q != p).collect(),
            None => Vec::new(),
        };
        write(&file, &list);
        menu::refresh(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_new_file_goes_first() {
        assert_eq!(pushed(v(&["/a", "/b"]), "/c"), v(&["/c", "/a", "/b"]));
    }

    #[test]
    fn an_already_listed_file_moves_to_the_top_without_a_duplicate() {
        assert_eq!(pushed(v(&["/a", "/b", "/c"]), "/c"), v(&["/c", "/a", "/b"]));
    }

    #[test]
    fn the_list_is_bounded() {
        let many: Vec<String> = (0..MAX_RECENT).map(|i| format!("/f{i}")).collect();
        let out = pushed(many, "/new");
        assert_eq!(out.len(), MAX_RECENT);
        assert_eq!(out[0], "/new");
    }

    #[test]
    fn a_missing_or_corrupt_file_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE_NAME);
        assert!(read(&file).is_empty());
        fs::write(&file, "not json").unwrap();
        assert!(read(&file).is_empty());
    }

    #[test]
    fn the_list_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join(FILE_NAME);
        write(&file, &v(&["/a", "/b"]));
        assert_eq!(read(&file), v(&["/a", "/b"]));
    }

    #[test]
    fn an_entry_is_split_into_name_and_folder() {
        let f = RecentFile::new("/home/me/music/song.wav");
        assert_eq!(f.name, "song.wav");
        assert_eq!(f.dir, "/home/me/music");
    }
}
