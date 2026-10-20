//! session.json：有哪些窗口、每个窗口的标签页（id 与所属文件）、当前标签页、
//! 最近获得焦点的窗口。每个标签页的工作副本是数据目录下的 `tabs/<id>.hush`，
//! 它属于哪个文件只记在这里，程序意外退出后据此把暂存的修改配回原文件。
//!
//! 每次改动由调用方 `save()` 写穿（先写 `.json.tmp` 再 rename）。读不出的
//! session.json 视为空会话。
use crate::errors::describe;
use crate::fsx::shown;
use crate::model::Result;
use crate::settings::{OpenFile, Startup};
use crate::store::{remove_if_exists, Store};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    hash::{BuildHasher, Hasher, RandomState},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub const SESSION_FILE: &str = "session.json";
/// 各标签页工作副本所在的文件夹。
const TABS_DIR: &str = "tabs";
/// 旧版本（单窗口单文档）的工作副本与它所属文件的记录，首次启动时迁移。
const LEGACY_WORKING: &str = "working.hush";
const LEGACY_RECOVERY: &str = "recovery.json";
const VERSION: u32 = 1;
/// 窗口标签的前缀：`win-1`、`win-2`…
pub const WINDOW_PREFIX: &str = "win-";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TabEntry {
    /// 16 位小写十六进制随机数，不复用。
    pub id: String,
    /// 所属文件（规范化路径）；未命名为 None。
    pub path: Option<PathBuf>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowEntry {
    pub label: String,
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub tabs: Vec<TabEntry>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    focused: Option<String>,
    #[serde(default)]
    windows: Vec<WindowEntry>,
}
/// 启动时要做的事（`Session::plan_launch` 的结果）。
#[derive(Debug, PartialEq)]
pub struct Launch {
    /// 按顺序创建的窗口；它们的标签页在各自前端 `restore_window` 时载入。
    pub windows: Vec<String>,
    /// 最后置顶并获得焦点的窗口。
    pub focus: String,
    /// 等某个窗口打开的文件（启动参数）。
    pub request: Option<(String, PathBuf)>,
}

/// 旧版 recovery.json：`{path}`。
#[derive(Deserialize)]
struct LegacyRecovery {
    path: Option<PathBuf>,
}

pub struct Session {
    /// 数据目录。
    root: PathBuf,
    data: Data,
}
impl Session {
    /// 读 session.json（读不出视为空会话），迁移旧版工作副本，删除 `tabs/` 中
    /// 没有被引用的文件。结果尚未写回，由调用方 `save()`。
    pub fn load(root: PathBuf) -> Self {
        let data = fs::read(root.join(SESSION_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Data>(&bytes).ok())
            .unwrap_or_default();
        let mut session = Self { root, data };
        if let Err(e) = fs::create_dir_all(session.tabs_dir()) {
            eprintln!("无法创建 {}：{}", shown(&session.tabs_dir()), describe(e));
        }
        session.migrate();
        session.remove_orphans();
        session
    }
    fn tabs_dir(&self) -> PathBuf {
        self.root.join(TABS_DIR)
    }
    /// 标签页 `id` 的工作副本。
    pub fn work_file(&self, id: &str) -> PathBuf {
        self.tabs_dir().join(format!("{id}.{}", crate::store::EXTENSION))
    }
    /// 写入 session.json：先写临时文件再改名，失败时不会留下半个文件。
    pub fn save(&self) -> Result<()> {
        let data = Data {
            version: VERSION,
            focused: self.data.focused.clone(),
            windows: self.data.windows.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
        let path = self.root.join(SESSION_FILE);
        let temp = path.with_extension("json.tmp");
        fs::write(&temp, bytes)
            .and_then(|()| fs::rename(&temp, &path))
            .map_err(|e| format!("无法写入会话记录 {}：{}", shown(&path), describe(e)))
    }

    /// 旧版本留下的 `working.hush`：有暂存就按 recovery.json 的路径变成一个残留
    /// 标签页（改名为 `tabs/<新 id>.hush`），没有就删除；recovery.json 一律删除。
    fn migrate(&mut self) {
        let legacy = self.root.join(LEGACY_WORKING);
        let recovery = self.root.join(LEGACY_RECOVERY);
        if legacy.exists() {
            let path = fs::read(&recovery)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<LegacyRecovery>(&bytes).ok())
                .and_then(|r| r.path);
            if Store::has_stash(&legacy, path.is_some()) {
                let id = self.new_id();
                let target = self.work_file(&id);
                match fs::rename(&legacy, &target) {
                    Ok(()) => {
                        // 未提交事务的回滚日志跟着走，SQLite 打开时据此恢复。
                        let journal = crate::fsx::sidecar(&legacy, "-journal");
                        if journal.exists() {
                            let _ = fs::rename(&journal, crate::fsx::sidecar(&target, "-journal"));
                        }
                        let label = match self.data.windows.first() {
                            Some(window) => window.label.clone(),
                            None => self.new_label(&[]),
                        };
                        self.add_tab(&label, TabEntry { id, path }, None);
                    }
                    Err(e) => eprintln!("无法迁移旧的工作副本 {}：{}", shown(&legacy), describe(e)),
                }
            } else {
                for file in [legacy.clone(), crate::fsx::sidecar(&legacy, "-journal")] {
                    if let Err(e) = remove_if_exists(&file) {
                        eprintln!("{e}");
                    }
                }
            }
        }
        if let Err(e) = remove_if_exists(&recovery) {
            eprintln!("{e}");
        }
    }
    /// 删除 `tabs/` 中不属于任何标签页的文件（含 SQLite 的 `-journal`）。
    fn remove_orphans(&self) {
        let Ok(entries) = fs::read_dir(self.tabs_dir()) else {
            return;
        };
        let owned: Vec<String> = self
            .all_tabs()
            .map(|tab| format!("{}.{}", tab.id, crate::store::EXTENSION))
            .collect();
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let referenced = owned
                .iter()
                .any(|own| name == *own || name.starts_with(&format!("{own}-")));
            if !referenced {
                if let Err(e) = remove_if_exists(&entry.path()) {
                    eprintln!("{e}");
                }
            }
        }
    }

    fn all_tabs(&self) -> impl Iterator<Item = &TabEntry> {
        self.data.windows.iter().flat_map(|w| w.tabs.iter())
    }
    /// 新的标签页 id：16 位小写十六进制随机数，不与现有标签页或文件重复。
    pub fn new_id(&self) -> String {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        loop {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            hasher.write_u128(nanos);
            hasher.write_u32(std::process::id());
            let id = format!("{:016x}", hasher.finish());
            if !self.all_tabs().any(|tab| tab.id == id) && !self.work_file(&id).exists() {
                return id;
            }
        }
    }
    /// 不被活窗口（`live`）或会话中任一窗口占用的最小 `win-<n>`。
    pub fn new_label(&self, live: &[String]) -> String {
        (1..)
            .map(|n| format!("{WINDOW_PREFIX}{n}"))
            .find(|label| {
                !live.contains(label) && !self.data.windows.iter().any(|w| w.label == *label)
            })
            .unwrap_or_default()
    }
    pub fn window(&self, label: &str) -> Option<&WindowEntry> {
        self.data.windows.iter().find(|w| w.label == label)
    }
    fn window_mut(&mut self, label: &str) -> &mut WindowEntry {
        let index = match self.data.windows.iter().position(|w| w.label == label) {
            Some(index) => index,
            None => {
                self.data.windows.push(WindowEntry {
                    label: label.to_owned(),
                    active: None,
                    tabs: Vec::new(),
                });
                self.data.windows.len() - 1
            }
        };
        &mut self.data.windows[index]
    }
    /// 窗口 `label` 的标签页（按顺序）；没有该窗口时为空。
    pub fn window_tabs(&self, label: &str) -> Vec<TabEntry> {
        self.window(label).map(|w| w.tabs.clone()).unwrap_or_default()
    }
    pub fn add_window(&mut self, label: &str) {
        self.window_mut(label);
    }
    pub fn remove_window(&mut self, label: &str) -> Option<WindowEntry> {
        let index = self.data.windows.iter().position(|w| w.label == label)?;
        if self.data.focused.as_deref() == Some(label) {
            self.data.focused = None;
        }
        Some(self.data.windows.remove(index))
    }
    /// 把 `tab` 加到窗口 `label`（不存在则新建）：`after` 指定的标签页右侧，否则末尾。
    pub fn add_tab(&mut self, label: &str, tab: TabEntry, after: Option<&str>) {
        let window = self.window_mut(label);
        let at = after
            .and_then(|after| window.tabs.iter().position(|t| t.id == after))
            .map_or(window.tabs.len(), |index| index + 1);
        window.tabs.insert(at, tab);
    }
    /// 移除标签页，返回它所在的窗口。它若是当前标签页，改为右邻，无右邻则左邻。
    pub fn remove_tab(&mut self, id: &str) -> Option<String> {
        for window in &mut self.data.windows {
            let Some(index) = window.tabs.iter().position(|t| t.id == id) else {
                continue;
            };
            window.tabs.remove(index);
            if window.active.as_deref() == Some(id) {
                window.active = window
                    .tabs
                    .get(index)
                    .or_else(|| index.checked_sub(1).and_then(|i| window.tabs.get(i)))
                    .map(|t| t.id.clone());
            }
            return Some(window.label.clone());
        }
        None
    }
    /// 把标签页连同工作副本归到另一个窗口（休眠窗口里的文件被再次打开时用）。
    pub fn move_tab(&mut self, id: &str, label: &str, after: Option<&str>) -> bool {
        let Some(tab) = self.all_tabs().find(|t| t.id == id).cloned() else {
            return false;
        };
        self.remove_tab(id);
        self.add_tab(label, tab, after);
        true
    }
    /// 窗口 `label` 的当前标签页改为 `id`；有变化时返回 true。
    pub fn set_active(&mut self, label: &str, id: &str) -> bool {
        let Some(window) = self.data.windows.iter_mut().find(|w| w.label == label) else {
            return false;
        };
        if window.active.as_deref() == Some(id) || !window.tabs.iter().any(|t| t.id == id) {
            return false;
        }
        window.active = Some(id.to_owned());
        true
    }
    pub fn set_path(&mut self, id: &str, path: Option<PathBuf>) {
        for window in &mut self.data.windows {
            for tab in &mut window.tabs {
                if tab.id == id {
                    tab.path = path;
                    return;
                }
            }
        }
    }
    /// 记下最近获得焦点的窗口；有变化时返回 true。
    pub fn set_focused(&mut self, label: &str) -> bool {
        if self.data.focused.as_deref() == Some(label) {
            return false;
        }
        self.data.focused = Some(label.to_owned());
        true
    }
    pub fn focused(&self) -> Option<&str> {
        self.data.focused.as_deref()
    }
    /// 打开着 `path` 的标签页：`(窗口, 标签页)`。
    pub fn find_path(&self, path: &Path) -> Option<(String, String)> {
        self.data.windows.iter().find_map(|window| {
            window
                .tabs
                .iter()
                .find(|tab| tab.path.as_deref() == Some(path))
                .map(|tab| (window.label.clone(), tab.id.clone()))
        })
    }
    /// 窗口已销毁：没有标签页的从会话中移除；还有标签页（窗口没关标签页就被销毁：
    /// 强制关闭，或“打开上一会话中的内容”时关闭最后一个窗口）的保留，下次启动时恢复。返回留下的标签页
    /// （由调用方卸载，不清理图片、不删工作副本）以及会话是否有变化。
    pub fn window_closed(&mut self, label: &str) -> (Vec<TabEntry>, bool) {
        let left = self.window_tabs(label);
        let changed = left.is_empty() && self.remove_window(label).is_some();
        (left, changed)
    }
    /// 启动时决定开哪些窗口（结果尚未写回，由调用方 `save()`）：
    /// - “打开新窗口”，或会话中没有窗口：一个新窗口，标签页是程序意外退出时
    ///   留下的未保存修改（`leftover_tabs`），没有就是一个新的空标签页；启动参数里的
    ///   文件交给这个窗口，按“打开”的规则处理。
    /// - “打开上一会话中的内容”：会话中的窗口按顺序全部重开，标签页与当前标签页
    ///   不变（各窗口载入时有暂存接上暂存，否则重新打开文件，见 lib.rs 的
    ///   `load_tab`），焦点回到上次最后使用的窗口。启动参数里的文件已在某个标签页
    ///   中：那个标签页成为当前、那个窗口获得焦点；否则按“打开文件”交给焦点窗口，
    ///   或开一个新窗口。
    /// `stashed` 判断工作副本里是否有未保存的修改。
    pub fn plan_launch(
        &mut self,
        startup: Startup,
        open_file: OpenFile,
        launch: Option<PathBuf>,
        stashed: impl Fn(&TabEntry, &Path) -> bool,
    ) -> Launch {
        if startup == Startup::NewWindow || self.data.windows.is_empty() {
            let leftovers = self.leftover_tabs(stashed);
            let label = self.new_label(&[]);
            let tabs = if leftovers.is_empty() {
                vec![TabEntry {
                    id: self.new_id(),
                    path: None,
                }]
            } else {
                leftovers
            };
            let first = tabs[0].id.clone();
            self.add_window(&label);
            for tab in tabs {
                self.add_tab(&label, tab, None);
            }
            self.set_active(&label, &first);
            self.set_focused(&label);
            return Launch {
                windows: vec![label.clone()],
                request: launch.map(|path| (label.clone(), path)),
                focus: label,
            };
        }
        let mut windows: Vec<String> = self.data.windows.iter().map(|w| w.label.clone()).collect();
        let mut focus = self
            .focused()
            .filter(|label| windows.iter().any(|w| w == label))
            .map_or_else(|| windows[0].clone(), str::to_owned);
        let mut request = None;
        if let Some(path) = launch {
            if let Some((label, tab)) = self.find_path(&path) {
                // 窗口的前端还没载入、收不到 activate-tab：直接改它的当前标签页。
                self.set_active(&label, &tab);
                focus = label;
            } else if open_file == OpenFile::Tab {
                request = Some((focus.clone(), path));
            } else {
                let label = self.new_label(&[]);
                self.add_window(&label);
                windows.push(label.clone());
                request = Some((label.clone(), path));
                focus = label;
            }
        }
        self.set_focused(&focus);
        Launch {
            windows,
            focus,
            request,
        }
    }
    /// 启动时（“打开新窗口”）：所有窗口从会话中移除，只留下工作副本里有未保存
    /// 修改的标签页（`stashed` 判断），按原窗口顺序返回；其余标签页的工作副本删除。
    pub fn leftover_tabs(&mut self, stashed: impl Fn(&TabEntry, &Path) -> bool) -> Vec<TabEntry> {
        let windows = std::mem::take(&mut self.data.windows);
        self.data.focused = None;
        let mut kept = Vec::new();
        for tab in windows.into_iter().flat_map(|w| w.tabs) {
            let work = self.work_file(&tab.id);
            if work.exists() && stashed(&tab, &work) {
                kept.push(tab);
            } else if let Err(e) = remove_if_exists(&work) {
                eprintln!("{e}");
            }
        }
        kept
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Block, Diary};

    fn temp(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "linehush-test-session-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn tab(id: &str, path: Option<&str>) -> TabEntry {
        TabEntry {
            id: id.into(),
            path: path.map(PathBuf::from),
        }
    }
    fn ids(session: &Session, label: &str) -> Vec<String> {
        session.window_tabs(label).into_iter().map(|t| t.id).collect()
    }
    /// 一个带暂存正文的工作副本。
    fn stashed_copy(file: &Path, text: &str) {
        Store::create(file.to_path_buf())
            .unwrap()
            .stash(&Diary {
                blocks: vec![Block::Line { text: text.into() }],
            })
            .unwrap();
    }

    #[test]
    fn saves_and_loads_windows_tabs_and_focus() {
        let root = temp("roundtrip");
        // 读不出的文件视为空会话。
        fs::write(root.join(SESSION_FILE), "{ 坏的").unwrap();
        let mut session = Session::load(root.clone());
        assert!(session.window("win-1").is_none() && session.focused().is_none());
        session.add_window("win-1");
        session.add_tab("win-1", tab("a", Some(r"D:\日记\a.hush")), None);
        session.add_tab("win-1", tab("b", None), None);
        assert!(session.set_active("win-1", "b"));
        assert!(!session.set_active("win-1", "b"));
        assert!(!session.set_active("win-1", "不存在"));
        assert!(session.set_focused("win-1"));
        assert!(!session.set_focused("win-1"));
        session.save().unwrap();
        let text = fs::read_to_string(root.join(SESSION_FILE)).unwrap();
        assert!(text.contains("\"version\": 1") && text.contains("\"label\": \"win-1\""));
        assert!(!root.join("session.json.tmp").exists());

        let loaded = Session::load(root.clone());
        assert_eq!(loaded.focused(), Some("win-1"));
        let window = loaded.window("win-1").unwrap();
        assert_eq!(window.active.as_deref(), Some("b"));
        assert_eq!(window.tabs, vec![tab("a", Some(r"D:\日记\a.hush")), tab("b", None)]);
        assert_eq!(
            loaded.find_path(Path::new(r"D:\日记\a.hush")),
            Some(("win-1".into(), "a".into()))
        );
        assert_eq!(loaded.find_path(Path::new(r"D:\日记\b.hush")), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn labels_ids_and_tab_order() {
        let root = temp("labels");
        let mut session = Session::load(root.clone());
        assert_eq!(session.new_label(&[]), "win-1");
        session.add_window("win-1");
        assert_eq!(session.new_label(&["win-2".into()]), "win-3");
        assert_eq!(session.new_label(&[]), "win-2");

        let a = session.new_id();
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(session.new_id(), a);

        // 新标签页插在指定标签页右侧，否则在末尾。
        session.add_tab("win-1", tab("a", None), None);
        session.add_tab("win-1", tab("c", None), None);
        session.add_tab("win-1", tab("b", None), Some("a"));
        session.add_tab("win-1", tab("d", None), Some("不存在"));
        assert_eq!(ids(&session, "win-1"), ["a", "b", "c", "d"]);
        session.set_path("c", Some(PathBuf::from("c.hush")));
        assert_eq!(session.window_tabs("win-1")[2].path, Some(PathBuf::from("c.hush")));

        // 关闭当前标签页：右邻成为当前，无右邻则左邻。
        session.set_active("win-1", "b");
        assert_eq!(session.remove_tab("b").as_deref(), Some("win-1"));
        assert_eq!(session.window("win-1").unwrap().active.as_deref(), Some("c"));
        session.set_active("win-1", "d");
        session.remove_tab("d");
        assert_eq!(session.window("win-1").unwrap().active.as_deref(), Some("c"));
        // 关闭其他标签页不改当前。
        session.remove_tab("a");
        assert_eq!(session.window("win-1").unwrap().active.as_deref(), Some("c"));
        assert_eq!(session.remove_tab("a"), None);

        // 标签页搬到另一个窗口。
        assert!(session.move_tab("c", "win-2", None));
        assert!(ids(&session, "win-1").is_empty());
        assert_eq!(ids(&session, "win-2"), ["c"]);
        assert!(!session.move_tab("不存在", "win-2", None));

        session.set_focused("win-2");
        assert!(session.remove_window("win-2").is_some());
        assert_eq!(session.focused(), None);
        assert!(session.remove_window("win-2").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_label_skips_live_and_recorded_windows() {
        let root = temp("label-gaps");
        let mut session = Session::load(root.clone());
        session.add_window("win-1");
        session.add_window("win-3");
        // win-2 只是活窗口（尚未写进会话）也算占用；win-4 空着。
        let live = ["win-1".to_string(), "win-2".to_string()];
        assert_eq!(session.new_label(&live), "win-4");
        // 关掉的窗口编号可再用：最小的空位优先。
        session.remove_window("win-1");
        assert_eq!(session.new_label(&["win-2".into()]), "win-1");
        assert_eq!(session.new_label(&[]), "win-1");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn find_path_names_the_window_and_tab() {
        let root = temp("find");
        let mut session = Session::load(root.clone());
        session.add_tab("win-1", tab("a", None), None);
        session.add_tab("win-1", tab("b", Some(r"D:\日记\甲.hush")), None);
        session.add_tab("win-2", tab("c", Some(r"D:\日记\乙.hush")), None);
        assert_eq!(
            session.find_path(Path::new(r"D:\日记\乙.hush")),
            Some(("win-2".into(), "c".into()))
        );
        assert_eq!(
            session.find_path(Path::new(r"D:\日记\甲.hush")),
            Some(("win-1".into(), "b".into()))
        );
        assert_eq!(session.find_path(Path::new(r"D:\日记\丙.hush")), None);
        // 另存为后按新路径找到；标签页关闭后找不到。
        session.set_path("b", Some(PathBuf::from(r"D:\日记\丙.hush")));
        assert_eq!(session.find_path(Path::new(r"D:\日记\甲.hush")), None);
        assert_eq!(
            session.find_path(Path::new(r"D:\日记\丙.hush")),
            Some(("win-1".into(), "b".into()))
        );
        session.remove_tab("c");
        assert_eq!(session.find_path(Path::new(r"D:\日记\乙.hush")), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn destroyed_windows_leave_only_if_they_have_no_tabs() {
        let root = temp("destroyed");
        let mut session = Session::load(root.clone());
        session.add_window("win-1");
        session.add_tab("win-2", tab("a", None), None);
        session.add_tab("win-2", tab("b", Some("b.hush")), None);
        session.set_focused("win-1");
        // 标签页都已关闭的窗口：从会话中移除，焦点记录一并清掉。
        assert_eq!(session.window_closed("win-1"), (Vec::new(), true));
        assert!(session.window("win-1").is_none());
        assert_eq!(session.focused(), None);
        // 还有标签页的窗口（被强制销毁）：保留，交回留下的标签页由调用方卸载。
        let (left, changed) = session.window_closed("win-2");
        assert_eq!(left, vec![tab("a", None), tab("b", Some("b.hush"))]);
        assert!(!changed);
        assert_eq!(ids(&session, "win-2"), ["a", "b"]);
        // 不在会话中的窗口（如导出 PDF 的窗口）：什么都不变。
        assert_eq!(session.window_closed("print"), (Vec::new(), false));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leftover_tabs_keep_only_unsaved_changes() {
        let root = temp("leftover");
        let mut session = Session::load(root.clone());
        session.add_tab("win-1", tab("aaaa", Some("a.hush")), None);
        session.add_tab("win-1", tab("bbbb", None), None);
        session.add_tab("win-2", tab("cccc", None), None);
        session.add_tab("win-2", tab("dddd", None), None);
        session.set_focused("win-2");
        stashed_copy(&session.work_file("aaaa"), "改过");
        // bbbb 有工作副本但没有暂存，dddd 连工作副本都没有。
        Store::create(session.work_file("bbbb")).unwrap();
        stashed_copy(&session.work_file("cccc"), "草稿");
        let left = session.leftover_tabs(|tab, work| Store::has_stash(work, tab.path.is_some()));
        assert_eq!(left, vec![tab("aaaa", Some("a.hush")), tab("cccc", None)]);
        assert!(session.window("win-1").is_none() && session.window("win-2").is_none());
        assert_eq!(session.focused(), None);
        assert!(!session.work_file("bbbb").exists());
        assert!(session.work_file("aaaa").exists() && session.work_file("cccc").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn untouched_drafts_are_not_leftovers() {
        let root = temp("draft");
        let mut session = Session::load(root.clone());
        session.add_tab("win-1", tab("aaaa", None), None);
        session.add_tab("win-1", tab("bbbb", Some("b.hush")), None);
        // 未命名且暂存为空文档不算；有路径时空文档也算修改（原文件可能有内容）。
        stashed_copy(&session.work_file("aaaa"), "");
        stashed_copy(&session.work_file("bbbb"), "");
        let left = session.leftover_tabs(|tab, work| Store::has_stash(work, tab.path.is_some()));
        assert_eq!(left, vec![tab("bbbb", Some("b.hush"))]);
        assert!(!session.work_file("aaaa").exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn no_stash(_: &TabEntry, _: &Path) -> bool {
        false
    }
    fn stashed(tab: &TabEntry, work: &Path) -> bool {
        Store::has_stash(work, tab.path.is_some())
    }

    #[test]
    fn new_window_launch_keeps_only_leftovers_even_after_a_last_session() {
        // 上次是“打开上一会话中的内容”：两个窗口、有没有暂存的标签页；改回“打开新窗口”后启动。
        let root = temp("launch-new");
        let mut session = Session::load(root.clone());
        session.add_tab("win-1", tab("aaaa", Some("a.hush")), None);
        session.add_tab("win-1", tab("bbbb", None), None);
        session.add_tab("win-3", tab("cccc", Some("c.hush")), None);
        session.add_tab("win-3", tab("dddd", None), None);
        session.set_active("win-3", "dddd");
        session.set_focused("win-3");
        Store::create(session.work_file("aaaa")).unwrap();
        stashed_copy(&session.work_file("bbbb"), "草稿");
        Store::create(session.work_file("cccc")).unwrap();
        stashed_copy(&session.work_file("dddd"), "改过");
        let launch = session.plan_launch(
            Startup::NewWindow,
            OpenFile::Window,
            Some(PathBuf::from("e.hush")),
            stashed,
        );
        assert_eq!(
            launch,
            Launch {
                windows: vec!["win-1".into()],
                focus: "win-1".into(),
                request: Some(("win-1".into(), PathBuf::from("e.hush"))),
            }
        );
        assert_eq!(ids(&session, "win-1"), ["bbbb", "dddd"]);
        assert_eq!(session.window("win-1").unwrap().active.as_deref(), Some("bbbb"));
        assert!(session.window("win-3").is_none());
        assert_eq!(session.focused(), Some("win-1"));
        assert!(!session.work_file("aaaa").exists() && !session.work_file("cccc").exists());

        // 没有残留：一个新的空标签页。
        let mut session = Session::load(root.clone());
        let launch = session.plan_launch(Startup::NewWindow, OpenFile::Tab, None, no_stash);
        assert_eq!((launch.windows, launch.request), (vec!["win-1".to_string()], None));
        let tabs = session.window_tabs("win-1");
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].path, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn last_session_launch_reopens_every_window_as_it_was() {
        let root = temp("launch-last");
        let mut session = Session::load(root.clone());
        session.add_tab("win-2", tab("aaaa", Some(r"D:\日记\甲.hush")), None);
        session.add_tab("win-2", tab("bbbb", None), None);
        session.set_active("win-2", "bbbb");
        session.add_tab("win-5", tab("cccc", Some(r"D:\日记\乙.hush")), None);
        session.set_focused("win-5");
        // 没有暂存的标签页也保留，不删工作副本（载入时重新打开文件）。
        Store::create(session.work_file("aaaa")).unwrap();
        let launch = session.plan_launch(Startup::LastSession, OpenFile::Tab, None, no_stash);
        assert_eq!(
            launch,
            Launch {
                windows: vec!["win-2".into(), "win-5".into()],
                focus: "win-5".into(),
                request: None,
            }
        );
        assert_eq!(ids(&session, "win-2"), ["aaaa", "bbbb"]);
        assert_eq!(session.window("win-2").unwrap().active.as_deref(), Some("bbbb"));
        assert_eq!(ids(&session, "win-5"), ["cccc"]);
        assert!(session.work_file("aaaa").exists());

        // 启动参数里的文件已在某个标签页中：那个标签页成为当前，那个窗口获得焦点。
        let launch = session.plan_launch(
            Startup::LastSession,
            OpenFile::Window,
            Some(PathBuf::from(r"D:\日记\甲.hush")),
            no_stash,
        );
        assert_eq!((launch.focus.as_str(), launch.request), ("win-2", None));
        assert_eq!(session.window("win-2").unwrap().active.as_deref(), Some("aaaa"));
        assert_eq!(session.focused(), Some("win-2"));

        // 没打开的文件，“在新标签页中打开”：交给焦点窗口。
        let launch = session.plan_launch(
            Startup::LastSession,
            OpenFile::Tab,
            Some(PathBuf::from(r"D:\日记\丙.hush")),
            no_stash,
        );
        assert_eq!(launch.windows, ["win-2", "win-5"]);
        assert_eq!(
            launch.request,
            Some(("win-2".into(), PathBuf::from(r"D:\日记\丙.hush")))
        );

        // “在新窗口中打开”：多开一个窗口（最小的空编号），由它打开并获得焦点。
        let launch = session.plan_launch(
            Startup::LastSession,
            OpenFile::Window,
            Some(PathBuf::from(r"D:\日记\丙.hush")),
            no_stash,
        );
        assert_eq!(launch.windows, ["win-2", "win-5", "win-1"]);
        assert_eq!(launch.focus, "win-1");
        assert_eq!(
            launch.request,
            Some(("win-1".into(), PathBuf::from(r"D:\日记\丙.hush")))
        );
        assert!(session.window("win-1").is_some());
        assert_eq!(session.focused(), Some("win-1"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn last_session_launch_without_windows_starts_like_a_new_window() {
        let root = temp("launch-empty");
        let mut session = Session::load(root.clone());
        session.set_focused("win-9");
        let launch = session.plan_launch(Startup::LastSession, OpenFile::Tab, None, no_stash);
        assert_eq!(launch.windows, ["win-1"]);
        assert_eq!(session.window_tabs("win-1").len(), 1);
        // 记录的焦点窗口已不在会话中：焦点给第一个窗口。
        session.add_tab("win-4", tab("zzzz", None), None);
        session.set_focused("win-9");
        let launch = session.plan_launch(Startup::LastSession, OpenFile::Tab, None, no_stash);
        assert_eq!(launch.windows, ["win-1", "win-4"]);
        assert_eq!(launch.focus, "win-1");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn load_removes_orphans_and_keeps_referenced_copies() {
        let root = temp("orphans");
        let mut session = Session::load(root.clone());
        session.add_tab("win-1", tab("aaaa", None), None);
        session.save().unwrap();
        let tabs = root.join(TABS_DIR);
        fs::write(tabs.join("aaaa.hush"), b"x").unwrap();
        fs::write(tabs.join("aaaa.hush-journal"), b"x").unwrap();
        fs::write(tabs.join("zzzz.hush"), b"x").unwrap();
        fs::write(tabs.join("zzzz.hush-journal"), b"x").unwrap();
        fs::create_dir(tabs.join("子文件夹")).unwrap();
        let session = Session::load(root.clone());
        assert_eq!(ids(&session, "win-1"), ["aaaa"]);
        assert!(tabs.join("aaaa.hush").exists() && tabs.join("aaaa.hush-journal").exists());
        assert!(!tabs.join("zzzz.hush").exists() && !tabs.join("zzzz.hush-journal").exists());
        assert!(tabs.join("子文件夹").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_working_copy_with_a_stash_becomes_a_tab() {
        let root = temp("legacy");
        stashed_copy(&root.join(LEGACY_WORKING), "旧版暂存");
        fs::write(
            root.join(LEGACY_RECOVERY),
            r#"{"path":"D:\\日记\\旧.hush"}"#,
        )
        .unwrap();
        let session = Session::load(root.clone());
        let tabs = session.window_tabs("win-1");
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].path, Some(PathBuf::from(r"D:\日记\旧.hush")));
        let work = session.work_file(&tabs[0].id);
        let (_, opened) = Store::resume(work, None).unwrap();
        assert_eq!(
            opened.document,
            Diary {
                blocks: vec![Block::Line { text: "旧版暂存".into() }]
            }
        );
        assert!(!root.join(LEGACY_WORKING).exists());
        assert!(!root.join(LEGACY_RECOVERY).exists());
        // 迁移后的会话记录写回后再读，标签页仍在，工作副本不被当作孤儿删除。
        session.save().unwrap();
        let again = Session::load(root.clone());
        assert_eq!(again.window_tabs("win-1"), tabs);
        assert!(again.work_file(&tabs[0].id).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_working_copy_without_a_stash_is_deleted() {
        let root = temp("legacy-empty");
        Store::create(root.join(LEGACY_WORKING)).unwrap();
        fs::write(root.join(LEGACY_RECOVERY), r#"{"path":null}"#).unwrap();
        let session = Session::load(root.clone());
        assert!(session.window("win-1").is_none());
        assert!(!root.join(LEGACY_WORKING).exists());
        assert!(!root.join(LEGACY_RECOVERY).exists());
        // 只有 recovery.json 也删除。
        fs::write(root.join(LEGACY_RECOVERY), r#"{"path":null}"#).unwrap();
        Session::load(root.clone());
        assert!(!root.join(LEGACY_RECOVERY).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
