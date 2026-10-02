//! The `.linehush` document model (format version 1) and its validation rules.
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
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 || self.blocks.is_empty() {
            return Err("文件格式无效或版本不受支持".into());
        }
        for block in &self.blocks {
            match block {
                Block::Line { text } => {
                    if text.contains(['\r', '\n']) {
                        return Err("文本行中存在非法换行".into());
                    }
                }
                Block::Images { images } => {
                    for pic in images {
                        validate_picture_path(&pic.path)?;
                    }
                }
            }
        }
        Ok(())
    }
    pub fn pictures(&self) -> impl Iterator<Item = &Picture> {
        self.blocks.iter().flat_map(|block| match block {
            Block::Images { images } => images.as_slice(),
            Block::Line { .. } => [].as_slice(),
        })
    }
}
/// The document-relative path of an attachment: `附件/<file_name>`.
pub fn picture_path(file_name: &str) -> String {
    format!("{ATTACHMENTS}/{file_name}")
}
// A picture path is `附件/` plus one plain file name; names come from unique_id().
pub fn validate_picture_path(path: &str) -> Result<()> {
    let name = path
        .strip_prefix(ATTACHMENTS)
        .and_then(|rest| rest.strip_prefix('/'))
        .ok_or("图片必须位于附件目录")?;
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("图片路径无效".into());
    }
    Ok(())
}
