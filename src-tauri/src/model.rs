//! The `.linehush` document model (format version 1).
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;

/// Folder, next to the document, that holds the original image files.
pub const ATTACHMENTS: &str = "附件";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Picture {
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
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
    pub version: u32,
    pub blocks: Vec<Block>,
}
impl Diary {
    pub fn empty() -> Self {
        Self {
            version: 1,
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
