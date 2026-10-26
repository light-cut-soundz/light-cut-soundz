//! Which files the front end may read and write.
//!
//! The commands that open, decode and export files take paths from the WebView.
//! A compromised WebView could name any path, so a path is only accepted if it
//! came from somewhere the user acted: a native file dialog, a file dropped on
//! the window, or the command line. Those are recorded here, by Rust, and
//! nothing the WebView sends can add to them.

use crate::error::coded;
use anyhow::Result;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
pub struct Approved {
    inputs: Arc<Mutex<HashSet<PathBuf>>>,
    outputs: Arc<Mutex<HashSet<PathBuf>>>,
}

fn lock(set: &Mutex<HashSet<PathBuf>>) -> std::sync::MutexGuard<'_, HashSet<PathBuf>> {
    set.lock().unwrap_or_else(|e| e.into_inner())
}

fn refuse(path: &str, what: &str) -> anyhow::Error {
    coded(
        "path_not_approved",
        &[("path", path.to_string())],
        format!("'{path}' was not chosen as {what} by the user"),
    )
}

impl Approved {
    /// A file the user picked, dropped or launched the app with.
    pub fn allow_input(&self, path: impl AsRef<Path>) {
        lock(&self.inputs).insert(path.as_ref().to_path_buf());
    }

    /// A destination the user picked in a save dialog.
    pub fn allow_output(&self, path: impl AsRef<Path>) {
        lock(&self.outputs).insert(path.as_ref().to_path_buf());
    }

    pub fn check_input(&self, path: &str) -> Result<()> {
        if lock(&self.inputs).contains(Path::new(path)) {
            Ok(())
        } else {
            Err(refuse(path, "a file to open"))
        }
    }

    pub fn check_output(&self, path: &str) -> Result<()> {
        if lock(&self.outputs).contains(Path::new(path)) {
            Ok(())
        } else {
            Err(refuse(path, "a destination"))
        }
    }
}

/// `path` with `.ext` appended unless it already ends with it (any case): the
/// container is decided by the format tab, so the name has to agree with it.
pub fn ensure_extension(path: &str, ext: &str) -> String {
    let suffix = format!(".{}", ext.to_ascii_lowercase());
    if path.to_ascii_lowercase().ends_with(&suffix) {
        path.to_string()
    } else {
        format!("{path}.{ext}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CmdError;

    fn code_of(e: anyhow::Error) -> String {
        CmdError::from(e).code
    }

    #[test]
    fn nothing_is_approved_to_begin_with() {
        let a = Approved::default();
        assert_eq!(
            code_of(a.check_input("/home/me/a.mp3").unwrap_err()),
            "path_not_approved"
        );
        assert_eq!(
            code_of(a.check_output("/home/me/a.wav").unwrap_err()),
            "path_not_approved"
        );
    }

    #[test]
    fn an_approved_input_is_accepted_exactly() {
        let a = Approved::default();
        a.allow_input("/home/me/song.mp3");
        assert!(a.check_input("/home/me/song.mp3").is_ok());
        assert!(a.check_input("/home/me/other.mp3").is_err());
        assert!(a.check_input("/home/me/song.mp3.bak").is_err());
        assert!(a.check_input("/home/me/../me/song.mp3").is_err());
    }

    #[test]
    fn inputs_and_outputs_are_separate() {
        let a = Approved::default();
        a.allow_input("/home/me/in.wav");
        a.allow_output("/home/me/out.wav");
        assert!(
            a.check_output("/home/me/in.wav").is_err(),
            "an opened file is not a destination"
        );
        assert!(a.check_input("/home/me/out.wav").is_err());
    }

    #[test]
    fn clones_share_the_same_approvals() {
        let a = Approved::default();
        let b = a.clone();
        a.allow_input("/x/y.flac");
        assert!(b.check_input("/x/y.flac").is_ok());
    }

    #[test]
    fn the_refusal_names_the_path() {
        let e = CmdError::from(Approved::default().check_input("/etc/passwd").unwrap_err());
        assert_eq!(e.params["path"], "/etc/passwd");
    }

    #[test]
    fn ensure_extension_appends_a_missing_one() {
        assert_eq!(ensure_extension("/a/chanson", "mp3"), "/a/chanson.mp3");
    }

    #[test]
    fn ensure_extension_keeps_a_matching_one_in_any_case() {
        assert_eq!(ensure_extension("/a/x.mp3", "mp3"), "/a/x.mp3");
        assert_eq!(ensure_extension("/a/X.MP3", "mp3"), "/a/X.MP3");
        assert_eq!(ensure_extension("/a/x.mp3", "MP3"), "/a/x.mp3");
    }

    #[test]
    fn ensure_extension_appends_rather_than_replaces_a_different_one() {
        assert_eq!(ensure_extension("/a/x.wav", "mp3"), "/a/x.wav.mp3");
    }

    #[test]
    fn ensure_extension_does_not_mistake_a_name_that_merely_ends_in_the_letters() {
        assert_eq!(ensure_extension("/a/mp3", "mp3"), "/a/mp3.mp3");
    }
}
