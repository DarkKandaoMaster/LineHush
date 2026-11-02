//! 分块导入（2026-11-02，见 docs/design/chunked-import-2026-11-02.md）：大于一块的图片 /
//! 视频 / 音频 / 文件由前端切成 8 MiB 的块逐块送来（`upload_begin` → `upload_chunk`…），
//! 这里追加写进数据目录 `upload\<id>.tmp` 并边写边算 SHA-256；最后由 `import_*_upload`
//! 取走（`Uploads::finish`），从临时文件入库后清掉。WebView2 下 wry 在 UI 主线程上按 1 KB
//! 读 raw body，整个文件一次送来时几百 MB 会让窗口卡住几秒，分块后每次只占主线程一小会儿。
//!
//! 累计超过 256 MB（`images::check_file_size`）、写入失败、取消（`upload_abort`）或所属
//! 标签页关闭时放弃这次上传并清掉临时文件；程序意外退出留下的在下次启动时清（lib.rs）。
use crate::{errors::describe, images, lock, model::Result};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

/// 临时文件所在的文件夹在数据目录下的名字（lib.rs 启动时清空）。
pub const UPLOAD_FOLDER: &str = "upload";
/// 已放弃、已取走或不存在的上传再收到块时的原因。
pub const UPLOAD_GONE: &str = "文件传输已取消";

/// 程序自己的临时文件，丢弃时删掉（尽力而为）。
struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
/// 进行中的一次上传。字段按声明顺序丢弃：先关文件，再删临时文件。
struct Upload {
    tab: String,
    file: File,
    temp: TempFile,
    len: u64,
    hasher: Sha256,
}
impl Upload {
    /// 追加一块；累计超过上限时报“文件过大（上限 256 MB）”，什么也不写。
    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        let len = self.len + bytes.len() as u64;
        images::check_file_size(usize::try_from(len).unwrap_or(usize::MAX))?;
        self.file
            .write_all(bytes)
            .map_err(|e| format!("无法写入临时文件：{}", describe(e)))?;
        self.hasher.update(bytes);
        self.len = len;
        Ok(())
    }
}
/// 收齐的一次上传：临时文件已关闭，`id` 是它的 SHA-256（小写十六进制，即图片表的 id）。
/// 丢弃时删掉临时文件。
pub struct Uploaded {
    pub len: u64,
    pub id: String,
    temp: TempFile,
}
impl Uploaded {
    pub fn path(&self) -> &Path {
        &self.temp.0
    }
}

/// 进行中的上传，按上传 id。
pub struct Uploads {
    dir: PathBuf,
    next: AtomicU64,
    /// 所属标签页与上传；None 表示已取走或已放弃。
    jobs: Mutex<HashMap<String, Arc<Mutex<Option<Upload>>>>>,
}
impl Uploads {
    /// 临时文件写在 `dir` 里（用到时才建）。
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            next: AtomicU64::new(0),
            jobs: Mutex::new(HashMap::new()),
        }
    }
    /// 为标签页 `tab` 开始一次上传，返回它的 id。
    pub fn begin(&self, tab: String) -> Result<String> {
        fs::create_dir_all(&self.dir).map_err(|e| format!("无法创建临时文件：{}", describe(e)))?;
        let id = format!("upload-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let path = self.dir.join(format!("{id}.tmp"));
        let file = File::create(&path).map_err(|e| format!("无法创建临时文件：{}", describe(e)))?;
        let upload = Upload {
            tab,
            file,
            temp: TempFile(path),
            len: 0,
            hasher: Sha256::new(),
        };
        lock(&self.jobs).insert(id.clone(), Arc::new(Mutex::new(Some(upload))));
        Ok(id)
    }
    /// 给上传 `id` 追加一块。失败（超过上限、写不进去）时放弃这次上传、清掉临时文件，
    /// 前端不必再调 `upload_abort`。
    pub fn append(&self, id: &str, bytes: &[u8]) -> Result<()> {
        let job = lock(&self.jobs).get(id).cloned().ok_or(UPLOAD_GONE)?;
        let result = match lock(&job).as_mut() {
            Some(upload) => upload.append(bytes),
            None => Err(UPLOAD_GONE.into()),
        };
        if result.is_err() {
            self.abort(id);
        }
        result
    }
    /// 取走标签页 `tab` 收齐的上传 `id`；不属于这个标签页的上传被放弃。
    pub fn finish(&self, id: &str, tab: &str) -> Result<Uploaded> {
        let job = lock(&self.jobs).remove(id).ok_or(UPLOAD_GONE)?;
        let upload = lock(&job).take().ok_or(UPLOAD_GONE)?;
        if upload.tab != tab {
            return Err("文件传输不属于这个标签页".into());
        }
        let Upload {
            file,
            temp,
            len,
            hasher,
            ..
        } = upload;
        // 关掉文件，之后由入库的一方按路径读。
        drop(file);
        Ok(Uploaded {
            len,
            id: images::hex(&hasher.finalize()),
            temp,
        })
    }
    /// 放弃上传 `id`（没有就什么也不做）。
    pub fn abort(&self, id: &str) {
        let job = lock(&self.jobs).remove(id);
        if let Some(job) = job {
            lock(&job).take();
        }
    }
    /// 放弃标签页 `tab` 的全部上传（标签页关闭时）。
    pub fn abort_tab(&self, tab: &str) {
        let jobs: Vec<_> = {
            let mut table = lock(&self.jobs);
            let ids: Vec<String> = table
                .iter()
                .filter(|(_, job)| lock(job).as_ref().is_some_and(|upload| upload.tab == tab))
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| table.remove(id)).collect()
        };
        for job in jobs {
            lock(&job).take();
        }
    }
}
