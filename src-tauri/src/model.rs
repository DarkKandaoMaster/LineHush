//! The document body stored in a `.hush` file (see db.rs for the container).
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Picture {
    /// Lowercase hex SHA-256 of the original bytes; key of the `images` table.
    pub id: String,
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
/// One original to copy next to an exported HTML file, as `附件/<file>`.
#[derive(Debug, Deserialize)]
pub struct ExportImage {
    pub id: String,
    pub file: String,
}
