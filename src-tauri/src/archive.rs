//! 文件夹打成 zip 附件（拖入 / 粘贴文件夹，见 docs/proposals/folder-zip-2026-11-01.md）：
//! 照 Windows“发送到 → 压缩文件夹”，zip 顶层就是文件夹本身（条目名 `<文件夹名>/...`），
//! 只存不压（store），条目名为 UTF-8（zip crate 对非 ASCII 名字自动写 UTF-8 标志）。
//!
//! 先流式写到数据目录 `zip\` 里的临时文件 `<id>.zip.tmp`，打完再由 lib.rs 读回、哈希入 Store
//! 并清掉临时文件；内存峰值只有单个文件（拖放时前端逐个送来的字节）。中途放弃或出错时
//! 临时文件随 `ZipBuilder` 一起清掉；程序意外退出留下的在下次启动时清（lib.rs `sweep_staged`）。
//! 打包的上限同附件：原始字节之和不超过 256 MB（`images::check_file_size`）。
use crate::{errors::describe, images, model::Result};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use zip::{result::ZipError, write::SimpleFileOptions, CompressionMethod, DateTime, ZipWriter};

/// 临时文件所在的文件夹在数据目录下的名字（lib.rs 启动时建好、清空）。
pub const ZIP_FOLDER: &str = "zip";
const TOO_LARGE: &str = "文件夹过大（上限 256 MB）";

/// 原始字节之和 `total` 超过附件上限时报“文件夹过大”。
pub fn check_total(total: u64) -> Result<()> {
    images::check_file_size(usize::try_from(total).unwrap_or(usize::MAX))
        .map_err(|_| TOO_LARGE.into())
}
/// 文件夹内的相对路径规范成 zip 里的写法：反斜杠换成正斜杠，去掉 `.` 段；
/// 空路径、空段（含首尾斜杠、`a//b`）与 `..` 段一律拒绝。
pub fn normalize(rel: &str) -> Result<String> {
    let rel = rel.replace('\\', "/");
    let mut parts = Vec::new();
    for part in rel.split('/') {
        match part {
            "." => {}
            "" | ".." => return Err(format!("文件夹内的路径无效：{rel}")),
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(format!("文件夹内的路径无效：{rel}"));
    }
    Ok(parts.join("/"))
}
/// 写 zip 时的错误：写临时文件失败照 IO 错误说明原因，其余（如重名）原样附上。
fn zip_error(e: ZipError) -> String {
    match e {
        ZipError::Io(e) => format!("无法写入临时文件：{}", describe(e)),
        e => format!("无法打包文件夹（{e}）"),
    }
}
fn read_error(e: io::Error) -> String {
    format!("无法读取文件夹：{}", describe(e))
}
/// 条目的修改时间：现在的本地时间（zip 存的是不带时区的本地时间，照资源管理器）；
/// 超出 zip 能表示的范围时为 1980-01-01。
fn now() -> DateTime {
    // SAFETY：GetLocalTime 只写入返回的结构体。
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    let byte = |n: u16| u8::try_from(n).unwrap_or(u8::MAX);
    DateTime::from_date_and_time(
        t.wYear,
        byte(t.wMonth),
        byte(t.wDay),
        byte(t.wHour),
        byte(t.wMinute),
        byte(t.wSecond),
    )
    .unwrap_or_default()
}
/// 临时文件名里的 id：启动以来的序号加时间，同一数据目录里不会重复。
fn temp_name() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{nanos:x}-{}.zip.tmp", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// 一个正在打的 zip。`finish` 之前丢弃（`abort` 或 drop）即清掉临时文件。
pub struct ZipBuilder {
    writer: Option<ZipWriter<BufWriter<File>>>,
    path: PathBuf,
    /// 文件夹名：每个条目名的第一段。
    name: String,
    /// 已写的目录条目（不带文件夹名与末尾斜杠，顶层为空串），同一目录只写一次。
    dirs: HashSet<String>,
    /// 已写文件的原始字节之和。
    total: u64,
    options: SimpleFileOptions,
}
impl ZipBuilder {
    /// 在 `dir`（数据目录下的 `zip\`，不存在则建）里开一个临时文件，打名为 `name` 的文件夹：
    /// 先写顶层目录条目 `name/`。
    pub fn create(dir: &Path, name: &str) -> Result<ZipBuilder> {
        let name = name.trim_matches(['/', '\\']);
        if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
            return Err(format!("文件夹名无效：{name}"));
        }
        let path = dir.join(temp_name());
        let file = fs::create_dir_all(dir)
            .and_then(|()| File::options().write(true).create_new(true).open(&path))
            .map_err(|e| format!("无法写入临时文件：{}", describe(e)))?;
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .last_modified_time(now());
        let mut builder = ZipBuilder {
            writer: Some(ZipWriter::new(BufWriter::new(file))),
            path,
            name: name.to_owned(),
            dirs: HashSet::new(),
            total: 0,
            options,
        };
        builder.ensure_dir("")?;
        Ok(builder)
    }
    /// 文件夹名（zip 顶层目录的名字）。
    pub fn name(&self) -> &str {
        &self.name
    }
    fn writer(&mut self) -> &mut ZipWriter<BufWriter<File>> {
        self.writer.as_mut().expect("ZipBuilder 已结束")
    }
    /// 写目录条目 `name/rel/`（`rel` 已规范化，空串为顶层），连同还没写过的上级目录。
    fn ensure_dir(&mut self, rel: &str) -> Result<()> {
        if self.dirs.contains(rel) {
            return Ok(());
        }
        if let Some((parent, _)) = rel.rsplit_once('/') {
            self.ensure_dir(parent)?;
        } else if !rel.is_empty() {
            self.ensure_dir("")?;
        }
        let entry = if rel.is_empty() {
            format!("{}/", self.name)
        } else {
            format!("{}/{rel}/", self.name)
        };
        let options = self.options;
        self.writer().add_directory(entry, options).map_err(zip_error)?;
        self.dirs.insert(rel.to_owned());
        Ok(())
    }
    /// 开始文件条目 `name/rel`（上级目录条目先补上），之后往 writer 里写内容。
    fn start_file(&mut self, rel: &str) -> Result<()> {
        if let Some((parent, _)) = rel.rsplit_once('/') {
            self.ensure_dir(parent)?;
        }
        let entry = format!("{}/{rel}", self.name);
        let options = self.options;
        self.writer().start_file(entry, options).map_err(zip_error)
    }
    /// 目录条目 `name/rel/`（`rel` 为文件夹内的相对路径，可多级；已有的不重复写）。
    pub fn add_dir(&mut self, rel: &str) -> Result<()> {
        let rel = normalize(rel)?;
        self.ensure_dir(&rel)
    }
    /// 文件条目 `name/rel`，内容为 `bytes`。原始字节之和超过上限即报“文件夹过大”，什么也不写。
    pub fn add_file(&mut self, rel: &str, bytes: &[u8]) -> Result<()> {
        let rel = normalize(rel)?;
        let total = self.total + bytes.len() as u64;
        check_total(total)?;
        self.start_file(&rel)?;
        self.writer()
            .write_all(bytes)
            .map_err(|e| format!("无法写入临时文件：{}", describe(e)))?;
        self.total = total;
        Ok(())
    }
    /// 把磁盘上的文件夹 `root` 里的全部内容（不含 `root` 本身，它就是顶层的 `name/`）按名字
    /// 排序递归加进来：目录为目录条目，文件流式复制，不整个读进内存。符号链接与目录联接
    /// 不跟随，直接略过。
    pub fn add_path(&mut self, root: &Path) -> Result<()> {
        self.add_tree(root, "")
    }
    fn add_tree(&mut self, dir: &Path, rel: &str) -> Result<()> {
        let mut entries = fs::read_dir(dir)
            .and_then(|entries| entries.collect::<io::Result<Vec<_>>>())
            .map_err(read_error)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            // symlink_metadata：链接本身的信息，不跟随。
            let meta = fs::symlink_metadata(&path).map_err(read_error)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                self.ensure_dir(&child)?;
                self.add_tree(&path, &child)?;
            } else {
                // 先按目录里记的大小拒绝，免得白复制；复制完再按实际字节数核一遍。
                check_total(self.total + meta.len())?;
                let mut file = File::open(&path).map_err(read_error)?;
                self.start_file(&child)?;
                let copied = io::copy(&mut file, self.writer()).map_err(|e| {
                    // 读源文件与写临时文件的错误分不开，都按读文件夹说明。
                    read_error(e)
                })?;
                self.total += copied;
                check_total(self.total)?;
            }
        }
        Ok(())
    }
    /// 写完中央目录并落盘，返回临时文件的路径；之后由调用方读走并清掉它。
    pub fn finish(mut self) -> Result<PathBuf> {
        let writer = self.writer.take().expect("ZipBuilder 已结束");
        writer
            .finish()
            .map_err(zip_error)?
            .into_inner()
            .map_err(|e| format!("无法写入临时文件：{}", describe(e.into_error())))?;
        Ok(std::mem::take(&mut self.path))
    }
    /// 放弃这个 zip，清掉临时文件（同 drop）。
    pub fn abort(self) {}
}
impl Drop for ZipBuilder {
    fn drop(&mut self) {
        // 还没 finish：先关掉文件再清。zip crate 在 drop 时会补写中央目录，无妨。
        if let Some(writer) = self.writer.take() {
            drop(writer);
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    fn temp() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "linehush-test-zip-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    /// zip 里的条目（名字、内容），按写入顺序；同时断言全部只存不压。
    fn entries(path: &Path) -> Vec<(String, Vec<u8>)> {
        let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut file = archive.by_index(i).unwrap();
                assert_eq!(file.compression(), CompressionMethod::Stored);
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).unwrap();
                (file.name().unwrap().into_owned(), bytes)
            })
            .collect()
    }
    fn names(entries: &[(String, Vec<u8>)]) -> Vec<&str> {
        entries.iter().map(|(name, _)| name.as_str()).collect()
    }

    #[test]
    fn paths_are_normalized_and_escapes_rejected() {
        assert_eq!(normalize("a.txt").unwrap(), "a.txt");
        assert_eq!(normalize(r"子\孙\c.txt").unwrap(), "子/孙/c.txt");
        assert_eq!(normalize("./a/./b").unwrap(), "a/b");
        assert_eq!(normalize(r".\a").unwrap(), "a");
        assert_eq!(normalize("名字 有空格/x").unwrap(), "名字 有空格/x");
        for bad in ["", ".", "./.", "/a", "a/", "a//b", "..", "a/../b", r"..\x", "a/.."] {
            assert!(
                normalize(bad).unwrap_err().starts_with("文件夹内的路径无效："),
                "{bad}"
            );
        }
    }
    #[test]
    fn a_folder_is_zipped_under_its_own_name_without_compression() {
        let dir = temp();
        let mut zip = ZipBuilder::create(&dir, "旅行 2026").unwrap();
        zip.add_file("说明.txt", "你好".as_bytes()).unwrap();
        zip.add_dir("空的").unwrap();
        zip.add_file("照片/第一天/a.jpg", b"\xFF\xD8 jpeg").unwrap();
        zip.add_file("照片/空文件", b"").unwrap();
        zip.add_dir("照片/第一天/更空").unwrap();
        // 已有的目录不重复写。
        zip.add_dir("照片").unwrap();
        let path = zip.finish().unwrap();
        assert!(path.starts_with(&dir));
        let entries = entries(&path);
        assert_eq!(
            names(&entries),
            [
                "旅行 2026/",
                "旅行 2026/说明.txt",
                "旅行 2026/空的/",
                "旅行 2026/照片/",
                "旅行 2026/照片/第一天/",
                "旅行 2026/照片/第一天/a.jpg",
                "旅行 2026/照片/空文件",
                "旅行 2026/照片/第一天/更空/",
            ]
        );
        assert_eq!(entries[1].1, "你好".as_bytes());
        assert_eq!(entries[5].1, b"\xFF\xD8 jpeg");
        assert_eq!(entries[6].1, b"");
        // 目录条目以 / 结尾、没有内容。
        assert!(entries
            .iter()
            .filter(|(name, _)| name.ends_with('/'))
            .all(|(_, bytes)| bytes.is_empty()));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn an_empty_folder_is_just_its_top_entry() {
        let dir = temp();
        let path = ZipBuilder::create(&dir, "空").unwrap().finish().unwrap();
        assert_eq!(names(&entries(&path)), ["空/"]);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn going_over_the_limit_is_refused() {
        assert!(check_total(256 * 1024 * 1024).is_ok());
        assert_eq!(
            check_total(256 * 1024 * 1024 + 1).unwrap_err(),
            "文件夹过大（上限 256 MB）"
        );
        let dir = temp();
        let mut zip = ZipBuilder::create(&dir, "大").unwrap();
        zip.add_file("a", b"ab").unwrap();
        // 不真写 256 MB：把已写的字节数拨到上限附近。
        zip.total = 256 * 1024 * 1024 - 2;
        assert_eq!(zip.add_file("b", b"abc").unwrap_err(), "文件夹过大（上限 256 MB）");
        zip.add_file("c", b"ab").unwrap();
        let path = zip.finish().unwrap();
        assert_eq!(names(&entries(&path)), ["大/", "大/a", "大/c"]);
        // 磁盘上的文件同样按大小之和拒绝。
        let src = dir.join("源");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("x"), b"abc").unwrap();
        let mut zip = ZipBuilder::create(&dir, "源").unwrap();
        zip.total = 256 * 1024 * 1024 - 2;
        assert_eq!(zip.add_path(&src).unwrap_err(), "文件夹过大（上限 256 MB）");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn a_folder_on_disk_is_zipped_like_one_added_by_hand() {
        let dir = temp();
        let src = dir.join("源");
        fs::create_dir_all(src.join("b 子目录").join("孙")).unwrap();
        fs::create_dir_all(src.join("c 空目录")).unwrap();
        fs::write(src.join("a.txt"), b"alpha").unwrap();
        fs::write(src.join("b 子目录").join("空.bin"), b"").unwrap();
        fs::write(src.join("b 子目录").join("孙").join("日记.txt"), "一行".as_bytes()).unwrap();
        fs::write(src.join("d.dat"), [0u8, 1, 2, 255]).unwrap();

        let mut zip = ZipBuilder::create(&dir.join("zip"), "笔记").unwrap();
        zip.add_path(&src).unwrap();
        let from_disk = entries(&zip.finish().unwrap());

        let mut zip = ZipBuilder::create(&dir.join("zip"), "笔记").unwrap();
        zip.add_file("a.txt", b"alpha").unwrap();
        zip.add_dir("b 子目录").unwrap();
        zip.add_dir("b 子目录/孙").unwrap();
        zip.add_file("b 子目录/孙/日记.txt", "一行".as_bytes()).unwrap();
        zip.add_file("b 子目录/空.bin", b"").unwrap();
        zip.add_dir("c 空目录").unwrap();
        zip.add_file("d.dat", &[0, 1, 2, 255]).unwrap();
        let by_hand = entries(&zip.finish().unwrap());
        assert_eq!(from_disk, by_hand);

        // 读不了的文件夹报中文原因。
        let mut zip = ZipBuilder::create(&dir.join("zip"), "无").unwrap();
        let error = zip.add_path(&dir.join("不存在")).unwrap_err();
        assert!(error.starts_with("无法读取文件夹：文件不存在（"), "{error}");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn an_abandoned_zip_leaves_no_temporary_file() {
        let dir = temp();
        let mut zip = ZipBuilder::create(&dir, "弃").unwrap();
        zip.add_file("a", b"abc").unwrap();
        let path = zip.path.clone();
        assert!(path.is_file());
        assert_eq!(path.extension().unwrap(), "tmp");
        zip.abort();
        assert!(!path.exists());
        // 重名文件是错误，不是 panic。
        let mut zip = ZipBuilder::create(&dir, "重").unwrap();
        zip.add_file("a", b"1").unwrap();
        assert!(zip.add_file("a", b"2").unwrap_err().starts_with("无法打包文件夹（"));
        drop(zip);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        // 文件夹名不能是空的或带路径。
        assert!(ZipBuilder::create(&dir, "").is_err());
        assert!(ZipBuilder::create(&dir, "a/b").is_err());
        assert!(ZipBuilder::create(&dir, "..").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
