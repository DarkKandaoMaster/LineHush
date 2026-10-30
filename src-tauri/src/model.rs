//! The document body stored in a `.hush` file (see db.rs for the container).
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;

/// What an entry of an `images` row is. Files of format v1 hold images only.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    #[default]
    Image,
    Video,
    Audio,
}
impl MediaKind {
    pub fn is_image(&self) -> bool {
        *self == Self::Image
    }
}
/// An image, video or audio clip in a row of the body.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Picture {
    /// Lowercase hex SHA-256 of the original bytes; key of the `images` table.
    pub id: String,
    pub name: String,
    /// Pixels of an image or of a video's picture; 0 × 0 for audio.
    pub width: u32,
    pub height: u32,
    /// Left out for an image, so a body without media is written as in format v1.
    #[serde(default, skip_serializing_if = "MediaKind::is_image")]
    pub kind: MediaKind,
    /// Seconds; video and audio only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
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
    }
}
/// One original to copy next to an exported HTML file, as `附件/<file>`.
#[derive(Debug, Deserialize)]
pub struct ExportImage {
    pub id: String,
    pub file: String,
}
