//! The document body stored in a `.hush` file (see db.rs for the container).
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;

/// What an entry of an `images` row is. Files of format v1 hold images only;
/// `File` (any other file, attached as it is) since 2026-11-01, still format v2.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    #[default]
    Image,
    Video,
    Audio,
    File,
}
impl MediaKind {
    pub fn is_image(&self) -> bool {
        *self == Self::Image
    }
}
/// An image, video, audio clip or attached file in a row of the body.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Picture {
    /// Lowercase hex SHA-256 of the original bytes; key of the `images` table.
    pub id: String,
    pub name: String,
    /// Pixels of an image or of a video's picture; 0 × 0 for audio and files.
    pub width: u32,
    pub height: u32,
    /// Left out for an image, so a body without media is written as in format v1.
    #[serde(default, skip_serializing_if = "MediaKind::is_image")]
    pub kind: MediaKind,
    /// Seconds; video and audio only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// Bytes of the original; attached files only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Block {
    Line { text: String },
    Images { images: Vec<Picture> },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Diary {
    pub blocks: Vec<Block>,
}
impl Diary {
    pub fn empty() -> Self {
        Self {
            blocks: vec![Block::Line {
                text: String::new(),
            }],
        }
    }
    pub fn pictures(&self) -> impl Iterator<Item = &Picture> {
        self.blocks.iter().flat_map(|block| match block {
            Block::Images { images } => images.as_slice(),
            Block::Line { .. } => [].as_slice(),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn images_are_written_as_in_format_v1_and_media_carry_kind_and_duration() {
        let v1 = r#"{"blocks":[{"type":"images","images":[{"id":"a","name":"a.png","width":3,"height":2}]}]}"#;
        let doc: Diary = serde_json::from_str(v1).unwrap();
        let Block::Images { images } = &doc.blocks[0] else {
            panic!()
        };
        assert_eq!((images[0].kind, images[0].duration), (MediaKind::Image, None));
        assert_eq!(serde_json::to_string(&doc).unwrap(), v1);
        // An explicit "image" and a null duration read as the defaults.
        let explicit = r#"{"id":"a","name":"","width":0,"height":0,"kind":"image","duration":null}"#;
        let pic: Picture = serde_json::from_str(explicit).unwrap();
        assert_eq!(serde_json::to_string(&pic).unwrap(), r#"{"id":"a","name":"","width":0,"height":0}"#);
        let audio = r#"{"id":"b","name":"语音.m4a","width":0,"height":0,"kind":"audio","duration":12.5}"#;
        let pic: Picture = serde_json::from_str(audio).unwrap();
        assert_eq!((pic.kind, pic.duration), (MediaKind::Audio, Some(12.5)));
        assert_eq!(serde_json::to_string(&pic).unwrap(), audio);
        assert!(serde_json::from_str::<Picture>(r#"{"id":"a","name":"","width":0,"height":0,"kind":"gif"}"#).is_err());
        assert_eq!(pic.size, None);
    }
    #[test]
    fn attached_files_carry_kind_and_size() {
        let file = r#"{"id":"c","name":"报告.docx","width":0,"height":0,"kind":"file","size":12345}"#;
        let pic: Picture = serde_json::from_str(file).unwrap();
        assert_eq!((pic.kind, pic.size, pic.duration), (MediaKind::File, Some(12345), None));
        assert_eq!(serde_json::to_string(&pic).unwrap(), file);
        // A size of 0 is still written; a missing one reads as None.
        let empty = r#"{"id":"d","name":"空.txt","width":0,"height":0,"kind":"file","size":0}"#;
        let pic: Picture = serde_json::from_str(empty).unwrap();
        assert_eq!(serde_json::to_string(&pic).unwrap(), empty);
        let unsized_file = r#"{"id":"e","name":"x.bin","width":0,"height":0,"kind":"file"}"#;
        let pic: Picture = serde_json::from_str(unsized_file).unwrap();
        assert_eq!((pic.kind, pic.size), (MediaKind::File, None));
        assert_eq!(serde_json::to_string(&pic).unwrap(), unsized_file);
        // An image is still written without kind or size.
        let image = Picture {
            kind: MediaKind::Image,
            size: None,
            ..pic
        };
        assert_eq!(
            serde_json::to_string(&image).unwrap(),
            r#"{"id":"e","name":"x.bin","width":0,"height":0}"#
        );
    }
}
/// One original to copy next to an exported HTML file, as `附件/<file>`.
#[derive(Debug, Deserialize)]
pub struct ExportImage {
    pub id: String,
    pub file: String,
}
