//! Descriptive metadata (title, artist, cover…) carried from the opened file to
//! the exported one. Best effort: a file whose tags cannot be read is exported
//! without them rather than not at all.

use std::path::Path;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{
    MetadataOptions, MetadataRevision, StandardTagKey, StandardVisualKey, Tag,
};
use symphonia::core::probe::Hint;

/// Longest text value passed on; anything longer is almost certainly lyrics or
/// binary junk, and ffmpeg takes it on the command line.
const MAX_VALUE_CHARS: usize = 1000;
/// Largest cover accepted.
const MAX_COVER_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct Cover {
    pub data: Vec<u8>,
    /// File extension ffmpeg recognises the image by: `jpg` or `png`.
    pub ext: &'static str,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Tags {
    /// `(ffmpeg metadata key, value)`, in a stable order.
    pub pairs: Vec<(&'static str, String)>,
    pub cover: Option<Cover>,
}

/// The ffmpeg key for a tag, if it is one worth carrying over.
fn key_for(key: StandardTagKey) -> Option<&'static str> {
    Some(match key {
        StandardTagKey::TrackTitle => "title",
        StandardTagKey::Artist => "artist",
        StandardTagKey::Album => "album",
        StandardTagKey::AlbumArtist => "album_artist",
        StandardTagKey::Genre => "genre",
        StandardTagKey::Date | StandardTagKey::ReleaseDate => "date",
        StandardTagKey::TrackNumber => "track",
        StandardTagKey::DiscNumber => "disc",
        StandardTagKey::Composer => "composer",
        StandardTagKey::Comment => "comment",
        _ => return None,
    })
}

fn clean(raw: &str) -> Option<String> {
    let text: String = raw.chars().filter(|c| *c != '\0').collect();
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(MAX_VALUE_CHARS).collect())
}

/// Adds what `revision` knows; what an earlier revision already said wins.
fn collect(revision: &MetadataRevision, tags: &mut Tags) {
    for Tag { std_key, value, .. } in revision.tags() {
        let Some(key) = std_key.and_then(key_for) else {
            continue;
        };
        if tags.pairs.iter().any(|(k, _)| *k == key) {
            continue;
        }
        if let Some(text) = clean(&value.to_string()) {
            tags.pairs.push((key, text));
        }
    }
    if tags.cover.is_some() {
        return;
    }
    // The front cover if the file says which one it is, else the first image.
    let visuals = revision.visuals();
    let chosen = visuals
        .iter()
        .find(|v| v.usage == Some(StandardVisualKey::FrontCover))
        .or_else(|| visuals.first());
    if let Some(v) = chosen {
        let ext = match v.media_type.as_str() {
            "image/jpeg" | "image/jpg" => Some("jpg"),
            "image/png" => Some("png"),
            _ => None,
        };
        if let Some(ext) = ext {
            if !v.data.is_empty() && v.data.len() <= MAX_COVER_BYTES {
                tags.cover = Some(Cover {
                    data: v.data.to_vec(),
                    ext,
                });
            }
        }
    }
}

/// Reads the tags of `path`. Never fails: no tags is a valid answer.
pub fn read(path: &str) -> Tags {
    let mut tags = Tags::default();
    let Ok(file) = std::fs::File::open(path) else {
        return tags;
    };
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let Ok(mut probed) = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) else {
        return tags;
    };

    // Tags in front of the stream (ID3v2) first, then those of the container.
    if let Some(log) = probed.metadata.get() {
        if let Some(revision) = log.current() {
            collect(revision, &mut tags);
        }
    }
    if let Some(revision) = probed.format.metadata().current() {
        collect(revision, &mut tags);
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;
    use symphonia::core::meta::{MetadataBuilder, StandardTagKey as K, Value, Visual};

    fn tag(key: Option<K>, raw: &str, value: &str) -> Tag {
        Tag::new(key, raw, Value::from(value))
    }

    fn visual(media_type: &str, usage: Option<StandardVisualKey>, data: &[u8]) -> Visual {
        Visual {
            media_type: media_type.into(),
            dimensions: None,
            bits_per_pixel: None,
            color_mode: None,
            usage,
            tags: vec![],
            data: data.into(),
        }
    }

    fn revision(tags: Vec<Tag>, visuals: Vec<Visual>) -> MetadataRevision {
        let mut b = MetadataBuilder::new();
        for t in tags {
            b.add_tag(t);
        }
        for v in visuals {
            b.add_visual(v);
        }
        b.metadata()
    }

    fn collected(rev: &MetadataRevision) -> Tags {
        let mut t = Tags::default();
        collect(rev, &mut t);
        t
    }

    #[test]
    fn the_common_tags_are_carried_under_ffmpeg_names() {
        let rev = revision(
            vec![
                tag(Some(K::TrackTitle), "TIT2", "Song"),
                tag(Some(K::Artist), "TPE1", "Me"),
                tag(Some(K::Album), "TALB", "Record"),
                tag(Some(K::AlbumArtist), "TPE2", "Us"),
                tag(Some(K::Genre), "TCON", "Folk"),
                tag(Some(K::Date), "TDRC", "2024"),
                tag(Some(K::TrackNumber), "TRCK", "3"),
                tag(Some(K::DiscNumber), "TPOS", "1"),
                tag(Some(K::Composer), "TCOM", "Them"),
                tag(Some(K::Comment), "COMM", "hi"),
            ],
            vec![],
        );
        let pairs: Vec<_> = collected(&rev).pairs.into_iter().collect();
        assert_eq!(
            pairs,
            vec![
                ("title", "Song".to_string()),
                ("artist", "Me".to_string()),
                ("album", "Record".to_string()),
                ("album_artist", "Us".to_string()),
                ("genre", "Folk".to_string()),
                ("date", "2024".to_string()),
                ("track", "3".to_string()),
                ("disc", "1".to_string()),
                ("composer", "Them".to_string()),
                ("comment", "hi".to_string()),
            ]
        );
    }

    #[test]
    fn numbers_are_written_as_text() {
        let rev = revision(
            vec![Tag::new(
                Some(K::TrackNumber),
                "TRCK",
                Value::UnsignedInt(7),
            )],
            vec![],
        );
        assert_eq!(collected(&rev).pairs, vec![("track", "7".to_string())]);
    }

    #[test]
    fn unknown_empty_and_blank_tags_are_left_out() {
        let rev = revision(
            vec![
                tag(None, "XXXX", "mystery"),
                tag(Some(K::Bpm), "TBPM", "120"),
                tag(Some(K::Artist), "TPE1", "   "),
                tag(Some(K::Album), "TALB", ""),
            ],
            vec![],
        );
        assert!(collected(&rev).pairs.is_empty());
    }

    #[test]
    fn nul_bytes_are_dropped_and_long_values_cut() {
        let long = "x".repeat(5000);
        let rev = revision(
            vec![
                tag(Some(K::TrackTitle), "TIT2", "So\0ng\0"),
                tag(Some(K::Comment), "COMM", &long),
            ],
            vec![],
        );
        let t = collected(&rev);
        assert_eq!(t.pairs[0].1, "Song");
        assert_eq!(t.pairs[1].1.chars().count(), MAX_VALUE_CHARS);
    }

    #[test]
    fn the_first_value_of_a_key_wins() {
        let rev = revision(
            vec![
                tag(Some(K::Artist), "TPE1", "First"),
                tag(Some(K::Artist), "TPE1", "Second"),
            ],
            vec![],
        );
        assert_eq!(collected(&rev).pairs, vec![("artist", "First".to_string())]);
    }

    #[test]
    fn an_earlier_revision_beats_a_later_one() {
        let first = revision(vec![tag(Some(K::Artist), "TPE1", "Front")], vec![]);
        let second = revision(
            vec![
                tag(Some(K::Artist), "ARTIST", "Container"),
                tag(Some(K::Album), "ALBUM", "Record"),
            ],
            vec![],
        );
        let mut t = Tags::default();
        collect(&first, &mut t);
        collect(&second, &mut t);
        assert_eq!(
            t.pairs,
            vec![
                ("artist", "Front".to_string()),
                ("album", "Record".to_string())
            ]
        );
    }

    #[test]
    fn the_front_cover_is_preferred_over_other_images() {
        let rev = revision(
            vec![],
            vec![
                visual("image/png", Some(StandardVisualKey::BackCover), b"back"),
                visual("image/jpeg", Some(StandardVisualKey::FrontCover), b"front"),
            ],
        );
        assert_eq!(
            collected(&rev).cover,
            Some(Cover {
                data: b"front".to_vec(),
                ext: "jpg"
            })
        );
    }

    #[test]
    fn without_a_marked_front_cover_the_first_image_is_used() {
        let rev = revision(vec![], vec![visual("image/png", None, b"pic")]);
        assert_eq!(collected(&rev).cover.unwrap().ext, "png");
    }

    #[test]
    fn covers_in_other_formats_or_empty_or_huge_are_skipped() {
        let rev = revision(vec![], vec![visual("image/gif", None, b"gif")]);
        assert_eq!(collected(&rev).cover, None);
        let rev = revision(vec![], vec![visual("image/png", None, b"")]);
        assert_eq!(collected(&rev).cover, None);
        let huge = vec![0u8; MAX_COVER_BYTES + 1];
        let rev = revision(vec![], vec![visual("image/png", None, &huge)]);
        assert_eq!(collected(&rev).cover, None);
    }

    #[test]
    fn a_file_that_cannot_be_read_has_no_tags() {
        assert_eq!(read("/nonexistent-dir-lcs/x.mp3"), Tags::default());
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("junk.mp3");
        std::fs::write(&junk, b"not audio at all").unwrap();
        assert_eq!(read(junk.to_str().unwrap()), Tags::default());
    }

    #[test]
    fn a_plain_wav_has_no_tags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.wav").to_str().unwrap().to_string();
        let buf = crate::audio::AudioBuffer {
            samples: vec![vec![0.1; 100]],
            sample_rate: 8000,
        };
        crate::audio::encode_wav(
            &buf,
            &path,
            crate::audio::WavDepth::Float32,
            &crate::job::Job::detached(),
        )
        .unwrap();
        assert_eq!(read(&path), Tags::default());
    }
}
