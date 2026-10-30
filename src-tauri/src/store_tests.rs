use crate::images;
use crate::model::{Block, Diary, ExportImage, MediaKind, Picture};
use crate::store::{Opened, Store};
use image::{DynamicImage, ImageFormat, RgbImage};
use rusqlite::Connection;
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Barrier, Mutex,
    },
    thread,
    time::Duration,
};

fn temp() -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let p = std::env::temp_dir().join(format!(
        "linehush-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}
fn diary(text: &str) -> Diary {
    Diary {
        blocks: text
            .split('\n')
            .map(|s| Block::Line { text: s.into() })
            .collect(),
    }
}
fn with_pictures(text: &str, pictures: &[&Picture]) -> Diary {
    let mut doc = diary(text);
    doc.blocks.push(Block::Images {
        images: pictures.iter().map(|&p| p.clone()).collect(),
    });
    doc
}
/// A photo-like JPEG (noise, so it does not compress away) with bytes after the
/// end marker, which any re-encoding would drop.
fn photo(seed: u32, side: u32) -> Vec<u8> {
    let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    let img = RgbImage::from_fn(side, side, |_, _| {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        image::Rgb([state as u8, (state >> 8) as u8, (state >> 16) as u8])
    });
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(img)
        .write_to(&mut out, ImageFormat::Jpeg)
        .unwrap();
    let mut bytes = out.into_inner();
    bytes.extend_from_slice(b"trailing metadata");
    bytes
}
/// What the import_image command does, minus the IPC.
fn import(store: &mut Store, bytes: &[u8]) -> Picture {
    let (picture, thumbnail) = images::prepare(bytes).unwrap();
    store.add_image(&picture.id, bytes, Some(thumbnail)).unwrap();
    picture
}
fn rows(file: &Path, table: &str) -> i64 {
    Connection::open(file)
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
/// The working copy of the tab started by `session(root)`.
fn working(root: &Path) -> PathBuf {
    root.join("app").join("tabs").join("0123456789abcdef.hush")
}
/// Opens `file` in a separate tab of another session, as the next launch would.
fn reopen(file: &Path) -> Diary {
    let root = temp();
    let document = Store::open_new(root.join("w.hush"), file)
        .unwrap()
        .1
        .document;
    fs::remove_dir_all(root).unwrap();
    document
}
/// Another tab showing `file`, with its own working copy under `root`.
fn other(root: &Path, file: &Path) -> Store {
    Store::open_new(root.join("other").join("w.hush"), file)
        .unwrap()
        .0
}
/// A new tab: an empty unnamed document.
fn session(root: &Path) -> Store {
    Store::create(working(root)).unwrap()
}
/// The tab a launch after a crash loads from the working copy of `session(root)`.
fn load(root: &Path, path: Option<&Path>) -> (Store, Opened) {
    let (store, opened, error) = Store::load(working(root), path).unwrap();
    assert_eq!(error, None);
    (store, opened)
}

#[test]
fn blank_lines_round_trip_and_header_is_set() {
    let root = temp();
    let file = root.join("日记.hush");
    let a = diary("中文\n\n\n末尾\n\n");
    let mut store = session(&root);
    let opened = store.save_as(&file, &a).unwrap();
    assert!(opened.path.unwrap().ends_with("日记.hush"));
    assert_eq!(reopen(&file), a);
    let b = diary("\n第二版\n\n");
    store.save(&b).unwrap();
    assert_eq!(reopen(&file), b);
    // No backup and no journal is left next to the file.
    let names: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    let conn = Connection::open(&file).unwrap();
    let pragma = |name: &str| -> i64 {
        conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))
            .unwrap()
    };
    // VACUUM INTO must carry the header values over to the saved file.
    assert_eq!(pragma("application_id"), 0x4855_5348);
    assert_eq!(pragma("user_version"), 2);
    assert_eq!(pragma("auto_vacuum"), 2);
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
    drop(conn);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn originals_are_kept_byte_for_byte_and_stored_once() {
    let root = temp();
    let file = root.join("图.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("")).unwrap();
    let bytes = photo(1, 64);
    let pic = import(&mut store, &bytes);
    assert_eq!((pic.width, pic.height), (64, 64));
    assert_eq!(import(&mut store, &bytes), pic);
    // Imports wait in the working copy until the next save.
    assert_eq!(rows(&working(&root), "images"), 1);
    assert_eq!(rows(&file, "images"), 0);
    assert_eq!(store.image(&pic.id).unwrap(), bytes);
    store.save(&with_pictures("", &[&pic])).unwrap();
    assert_eq!(rows(&file, "images"), 1);
    assert_eq!(store.image(&pic.id).unwrap(), bytes);
    let out = root.join("原图.jpg");
    store.export_image(&pic.id, &out).unwrap();
    assert_eq!(fs::read(&out).unwrap(), bytes);
    // The import already cached the thumbnail.
    let store = Mutex::new(store);
    let cached = Store::thumbnail(&store, &pic.id, |_| panic!("decoded again")).unwrap();
    assert_eq!(cached, images::thumbnail(&bytes).unwrap());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn thumbnails_are_built_without_the_lock_and_then_cached() {
    let root = temp();
    let file = root.join("并发.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("")).unwrap();
    let bytes = photo(8, 64);
    let pic = import(&mut store, &bytes);
    store.save(&with_pictures("", &[&pic])).unwrap();
    // A fresh tab has nothing cached. Concurrent requests may each build it.
    let other = Mutex::new(other(&root, &file));
    let builds = AtomicU32::new(0);
    let start = Barrier::new(4);
    let thumbs: Vec<_> = thread::scope(|s| {
        let requests: Vec<_> = (0..4)
            .map(|_| {
                s.spawn(|| {
                    start.wait();
                    Store::thumbnail(&other, &pic.id, |source| {
                        builds.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(100));
                        images::thumbnail(source)
                    })
                    .unwrap()
                })
            })
            .collect();
        requests.into_iter().map(|r| r.join().unwrap()).collect()
    });
    assert!((1..=4).contains(&builds.load(Ordering::SeqCst)));
    let expected = images::thumbnail(&bytes).unwrap();
    assert!(thumbs.iter().all(|t| *t == expected));
    // Afterwards it comes from the cache.
    let cached = Store::thumbnail(&other, &pic.id, |_| panic!("decoded again")).unwrap();
    assert_eq!(cached, expected);
    drop(store);
    drop(other);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn file_changes_only_when_saved() {
    let root = temp();
    let file = root.join("a.hush");
    let mut store = session(&root);
    let saved = diary("已保存");
    store.save_as(&file, &saved).unwrap();
    let before = fs::read(&file).unwrap();
    let bytes = photo(2, 64);
    let pic = import(&mut store, &bytes);
    let edited = with_pictures("未保存\n", &[&pic]);
    store.stash(&edited).unwrap();
    // Neither the stash nor the import touched the file.
    assert_eq!(fs::read(&file).unwrap(), before);
    assert_eq!(reopen(&file), saved);
    assert!(other(&root, &file).image(&pic.id).is_err());
    // This tab reads the image from the working copy.
    assert_eq!(store.image(&pic.id).unwrap(), bytes);

    store.save(&edited).unwrap();
    assert_eq!(reopen(&file), edited);
    assert_eq!(rows(&file, "images"), 1);
    assert_eq!(other(&root, &file).image(&pic.id).unwrap(), bytes);
    // The working copy is empty again.
    assert_eq!(rows(&working(&root), "doc"), 0);
    assert_eq!(rows(&working(&root), "images"), 0);
    // Mid-session the image survives even after the saved body stops referencing it.
    store.save(&diary("删掉了")).unwrap();
    assert_eq!(store.image(&pic.id).unwrap(), bytes);
    assert_eq!(rows(&file, "images"), 1);
    drop(store);
    assert_eq!(reopen(&file), diary("删掉了"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn unsaved_changes_survive_a_crash_even_after_their_file_is_moved() {
    let root = temp();
    let file = root.join("崩溃.hush");
    let mut store = session(&root);
    let path = store.save_as(&file, &diary("已保存")).unwrap().path.unwrap();
    let bytes = photo(3, 64);
    let pic = import(&mut store, &bytes);
    let edited = with_pictures("崩溃前\n\n", &[&pic]);
    store.stash(&edited).unwrap();
    // A crash: nothing else runs before the next launch, which finds the stash
    // and pairs it with the file session.json names.
    drop(store);
    assert!(Store::has_stash(&working(&root), true));
    let (mut store, opened) = load(&root, Some(&path));
    assert!(opened.path.unwrap().ends_with("崩溃.hush") && opened.recovered);
    assert!(opened.notice.is_none());
    assert_eq!(opened.document, edited);
    assert_eq!(store.path(), Some(path.as_path()));
    assert_eq!(store.image(&pic.id).unwrap(), bytes);
    assert_eq!(reopen(&file), diary("已保存"));
    // Saving after the restart completes the recovered edit.
    store.save(&edited).unwrap();
    assert_eq!(reopen(&file), edited);
    drop(store);
    assert_eq!(other(&root, &file).image(&pic.id).unwrap(), bytes);

    // Another crash, then the file is moved away before the next launch.
    let file = root.join("搬走.hush");
    let mut store = session(&root);
    let saved_pic = import(&mut store, &photo(5, 64));
    let path = store
        .save_as(&file, &with_pictures("已保存", &[&saved_pic]))
        .unwrap()
        .path
        .unwrap();
    let bytes = photo(6, 64);
    let pic = import(&mut store, &bytes);
    let edited = with_pictures("崩溃前\n\n", &[&pic]);
    store.stash(&edited).unwrap();
    drop(store);
    fs::rename(&file, root.join("别处.hush")).unwrap();
    // Not a failed open: the stash is restored as an unnamed document, with a notice.
    let (mut store, opened) = load(&root, Some(&path));
    assert!(opened.path.is_none() && opened.recovered && store.path().is_none());
    assert_eq!(opened.document, edited);
    let notice = opened.notice.unwrap();
    assert!(
        notice.contains("未保存的修改已作为未命名文档恢复") && notice.contains("搬走.hush"),
        "{notice}"
    );
    assert_eq!(store.image(&pic.id).unwrap(), bytes);
    // Images that only the moved file held are gone from this document.
    assert!(store.image(&saved_pic.id).is_err());
    // The recovered draft is saved like any other.
    let target = root.join("新.hush");
    store.save_as(&target, &edited).unwrap();
    assert_eq!(reopen(&target), edited);
    drop(store);
    assert_eq!(other(&root, &target).image(&pic.id).unwrap(), bytes);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn close_discards_unsaved_changes_and_drops_unreferenced_images() {
    let root = temp();
    let file = root.join("大图.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("")).unwrap();
    let big = photo(4, 1200);
    let kept = photo(5, 64);
    let big_pic = import(&mut store, &big);
    let kept_pic = import(&mut store, &kept);
    store
        .save(&with_pictures("", &[&big_pic, &kept_pic]))
        .unwrap();
    let full = fs::metadata(&file).unwrap().len();
    assert!(full > big.len() as u64);
    let saved = with_pictures("", &[&kept_pic]);
    store.save(&saved).unwrap();
    assert_eq!(rows(&file, "images"), 2);
    let extra = photo(6, 64);
    let extra_pic = import(&mut store, &extra);
    store
        .stash(&with_pictures("没保存", &[&kept_pic, &extra_pic]))
        .unwrap();
    assert_eq!(store.close(), None);
    assert_eq!(reopen(&file), saved);
    let small = fs::metadata(&file).unwrap().len();
    assert!(small + big.len() as u64 / 2 < full, "{small} vs {full}");
    assert_eq!(rows(&file, "images"), 1);
    // The working copy is deleted and the closed tab no longer usable.
    assert!(!working(&root).exists());
    assert!(!Store::has_stash(&working(&root), true));
    assert!(store.image(&kept_pic.id).is_err());
    drop(store);
    let other = other(&root, &file);
    assert!(other.image(&big_pic.id).is_err());
    assert!(other.image(&extra_pic.id).is_err());
    assert_eq!(other.image(&kept_pic.id).unwrap(), kept);
    drop(other);
    fs::remove_dir_all(root).unwrap();
}
/// Damages the saved body behind the back of an open tab.
fn damage_body(file: &Path) {
    Connection::open(file)
        .unwrap()
        .execute("UPDATE doc SET body = 'x'", [])
        .unwrap();
}
#[test]
fn opening_another_file_in_the_tab_discards_unsaved_changes_and_cleans_the_file() {
    let root = temp();
    let a = root.join("a.hush");
    let b = root.join("b.hush");
    let mut store = session(&root);
    store.save_as(&a, &diary("a")).unwrap();
    let pic = import(&mut store, &photo(9, 64));
    store.save(&with_pictures("a", &[&pic])).unwrap();
    store.save(&diary("a")).unwrap();
    let extra = import(&mut store, &photo(10, 64));
    store.stash(&with_pictures("没保存", &[&extra])).unwrap();
    Store::create(root.join("w2.hush"))
        .unwrap()
        .save_as(&b, &diary("b"))
        .unwrap();
    // A clean switch has nothing to report.
    let opened = store.open(&b).unwrap();
    assert!(!opened.recovered && opened.notice.is_none());
    assert_eq!(opened.document, diary("b"));
    assert_eq!(rows(&a, "images"), 0);
    assert_eq!(reopen(&a), diary("a"));
    assert_eq!(rows(&working(&root), "doc"), 0);
    assert_eq!(rows(&working(&root), "images"), 0);

    // Leaving a file that was damaged meanwhile still succeeds, with a notice.
    store.open(&a).unwrap();
    store.stash(&diary("不保存")).unwrap();
    damage_body(&a);
    let opened = store.open(&b).unwrap();
    let notice = opened.notice.unwrap();
    assert!(
        notice.starts_with("上一个文件的未引用图片未能清理："),
        "{notice}"
    );
    assert!(!opened.recovered);
    assert_eq!(opened.document, diary("b"));
    assert!(opened.path.unwrap().ends_with("b.hush"));
    assert_eq!(rows(&working(&root), "doc"), 0);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn new_tabs_start_empty_and_a_failed_open_leaves_nothing() {
    let root = temp();
    let store = session(&root);
    let current = store.current().unwrap();
    assert!(current.path.is_none() && !current.recovered);
    assert_eq!(current.document, Diary::empty());
    assert_eq!(rows(&working(&root), "doc"), 0);
    drop(store);
    let work = root.join("tabs").join("x.hush");
    assert!(Store::open_new(work.clone(), &root.join("缺失.hush")).is_err());
    assert!(!work.exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn current_returns_the_stash_or_the_saved_body() {
    let root = temp();
    let file = root.join("现状.hush");
    let mut store = session(&root);
    store.stash(&diary("")).unwrap();
    // An unnamed tab whose stash is empty has nothing unsaved.
    assert!(!store.current().unwrap().recovered);
    store.save_as(&file, &diary("已保存")).unwrap();
    let current = store.current().unwrap();
    assert_eq!(current.document, diary("已保存"));
    assert!(!current.recovered && current.path.unwrap().ends_with("现状.hush"));
    store.stash(&diary("改了")).unwrap();
    let current = store.current().unwrap();
    assert_eq!(current.document, diary("改了"));
    assert!(current.recovered);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn draft_is_restored_then_moved_into_save_as_target() {
    let root = temp();
    // Without a working copy the tab is a fresh, untouched draft.
    let (_, opened) = load(&root, None);
    assert!(opened.path.is_none() && !opened.recovered);
    assert_eq!(opened.document, Diary::empty());
    let mut store = session(&root);
    let bytes = photo(3, 64);
    let pic = import(&mut store, &bytes);
    let doc = with_pictures("草稿\n\n", &[&pic]);
    store.stash(&doc).unwrap();
    // An unnamed document can only be saved through save_as.
    assert!(store.save(&doc).is_err());
    drop(store);
    assert!(Store::has_stash(&working(&root), false));
    let (mut store, opened) = load(&root, None);
    assert!(opened.path.is_none() && opened.recovered);
    assert_eq!(opened.document, doc);
    assert_eq!(store.image(&pic.id).unwrap(), bytes);

    let out = root.join("out");
    fs::create_dir(&out).unwrap();
    let opened = store.save_as(&out.join("日记"), &doc).unwrap();
    let file = opened.path.unwrap();
    assert_eq!(file.file_name().unwrap(), "日记.hush");
    assert_eq!(Store::save_as_target(&out.join("日记")).unwrap(), file);
    // The draft now lives in the file.
    assert_eq!(rows(&working(&root), "doc"), 0);
    assert_eq!(rows(&working(&root), "images"), 0);
    let mut other_tab = Store::create(root.join("other").join("w.hush")).unwrap();
    assert_eq!(other_tab.open(&file).unwrap().document, doc);
    assert_eq!(other_tab.image(&pic.id).unwrap(), bytes);
    drop(other_tab);
    store.save(&diary("另存后继续写")).unwrap();
    drop(store);
    assert_eq!(reopen(&file), diary("另存后继续写"));
    assert_eq!(other(&root, &file).image(&pic.id).unwrap(), bytes);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn save_as_from_a_file_carries_saved_and_unsaved_images() {
    let root = temp();
    let a = root.join("a.hush");
    let b = root.join("b.hush");
    let mut store = session(&root);
    store.save_as(&a, &diary("")).unwrap();
    let old = photo(11, 64);
    let old_pic = import(&mut store, &old);
    store.save(&with_pictures("a", &[&old_pic])).unwrap();
    let new = photo(12, 64);
    let new_pic = import(&mut store, &new);
    let doc = with_pictures("b", &[&old_pic, &new_pic]);
    store.stash(&doc).unwrap();
    let opened = store.save_as(&b, &doc).unwrap();
    assert!(opened.path.unwrap().ends_with("b.hush") && !opened.recovered);
    assert_eq!(rows(&b, "images"), 2);
    assert_eq!(reopen(&b), doc);
    let other = other(&root, &b);
    assert_eq!(other.image(&old_pic.id).unwrap(), old);
    assert_eq!(other.image(&new_pic.id).unwrap(), new);
    drop(other);
    // The old file keeps its last saved state.
    assert_eq!(reopen(&a), with_pictures("a", &[&old_pic]));
    assert_eq!(rows(&a, "images"), 1);
    assert_eq!(rows(&working(&root), "doc"), 0);
    assert_eq!(rows(&working(&root), "images"), 0);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn save_as_leaves_the_old_file_and_replaces_the_target() {
    let root = temp();
    let a = root.join("a.hush");
    let b = root.join("b.hush");
    let mut store = session(&root);
    store.save_as(&b, &diary("旧的 b")).unwrap();
    store.save_as(&a, &diary("a")).unwrap();
    store.save_as(&b, &diary("新的 b")).unwrap();
    assert_eq!(reopen(&a), diary("a"));
    assert_eq!(reopen(&b), diary("新的 b"));
    // Saving as the open file itself just saves.
    store.save_as(&b, &diary("同一个")).unwrap();
    assert_eq!(reopen(&b), diary("同一个"));
    assert!(!root.join("b.hush.tmp").exists());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn open_enforces_only_serde_structure() {
    let root = temp();
    let file = root.join("x.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("first")).unwrap();
    let mut other = Store::create(root.join("other").join("w.hush")).unwrap();
    let mut read = |json: &str| {
        Connection::open(&file)
            .unwrap()
            .execute("UPDATE doc SET body = ?1", [json])
            .unwrap();
        other.open(&file).map(|o| o.document)
    };
    // Unknown node types and unknown fields are rejected by serde.
    assert!(read(r#"{"blocks":[{"type":"heading","text":"x"}]}"#).is_err());
    assert!(read(r#"{"blocks":[{"type":"line","text":"x","bold":true}]}"#).is_err());
    assert!(read(r#"{"blocks":[],"version":1}"#).is_err());
    assert!(read(
        r#"{"blocks":[{"type":"images","images":[{"id":"a","name":"","width":1,"height":1,"path":"x"}]}]}"#
    )
    .is_err());
    drop(store);
    drop(other);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_failed_open_names_the_cause_and_leaves_the_document_usable() {
    let root = temp();
    let file = root.join("a.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("first")).unwrap();
    let missing = store.open(&root.join("缺失.hush")).err().unwrap();
    assert!(
        missing.starts_with("无法打开 ") && missing.contains("：文件不存在（"),
        "{missing}"
    );
    assert!(!root.join("缺失.hush").exists());
    let short = root.join("plain.hush");
    fs::write(&short, "not sqlite").unwrap();
    assert!(store.open(&short).is_err());
    let text = root.join("文本.hush");
    fs::write(
        &text,
        "这不是 SQLite 文件，长度也足够填满文件头需要的一百个字节以上。这不是 SQLite 文件。",
    )
    .unwrap();
    let error = store.open(&text).err().unwrap();
    assert!(
        error.contains("：不是有效的 .hush 文件或文件已损坏"),
        "{error}"
    );
    // The canonical path is shown without its `\\?\` prefix.
    assert!(
        error.starts_with("无法打开 ") && !error.contains(r"\?\"),
        "{error}"
    );
    // A SQLite file of some other program.
    let foreign = root.join("别的.hush");
    Connection::open(&foreign)
        .unwrap()
        .execute_batch("CREATE TABLE notes (x)")
        .unwrap();
    let error = store.open(&foreign).err().unwrap();
    assert!(
        error.ends_with("：不是有效的 .hush 文件或文件已损坏"),
        "{error}"
    );
    // The open file is still in use.
    store.save(&diary("second")).unwrap();
    assert_eq!(reopen(&file), diary("second"));

    // Saving to a file that became read-only.
    let file = root.join("只读.hush");
    store.save_as(&file, &diary("")).unwrap();
    drop(store);
    let mut permissions = fs::metadata(&file).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&file, permissions.clone()).unwrap();
    let (mut store, _) = Store::open_new(working(&root), &file).unwrap();
    let error = store.save(&diary("改")).unwrap_err();
    assert!(error.starts_with("没有写入权限或文件无法访问（"), "{error}");
    drop(store);
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(&file, permissions).unwrap();
    fs::remove_dir_all(root).unwrap();
}
/// “打开上一会话中的内容”：上次关闭时留下的标签页，按 `Store::load` 载入。
#[test]
fn last_session_tabs_resume_stashes_reopen_files_and_fall_back_to_untitled() {
    let root = temp();
    let tabs = root.join("tabs");
    let file = root.join("已保存.hush");
    let path = Store::create(tabs.join("a.hush"))
        .unwrap()
        .save_as(&file, &diary("文件里的"))
        .unwrap()
        .path
        .unwrap();

    // 有暂存（关闭时 flush 落盘的修改）：接上暂存，配回原文件，标记未保存。
    let store = Store::open_new(tabs.join("b.hush"), &path).unwrap().0;
    store.stash(&diary("没保存的修改")).unwrap();
    drop(store);
    let (store, opened, error) = Store::load(tabs.join("b.hush"), Some(&path)).unwrap();
    assert_eq!(error, None);
    assert!(opened.recovered && opened.notice.is_none());
    assert_eq!(opened.path.as_deref(), Some(path.as_path()));
    assert_eq!(opened.document, diary("没保存的修改"));
    assert_eq!(store.path(), Some(path.as_path()));
    drop(store);

    // 无标题的草稿：有内容就恢复为未保存；空的草稿是一个新的空标签页。
    let draft = Store::create(tabs.join("c.hush")).unwrap();
    draft.stash(&diary("草稿")).unwrap();
    drop(draft);
    let (_, opened, error) = Store::load(tabs.join("c.hush"), None).unwrap();
    assert_eq!(error, None);
    assert!(opened.recovered && opened.path.is_none());
    assert_eq!(opened.document, diary("草稿"));
    let empty = Store::create(tabs.join("d.hush")).unwrap();
    empty.stash(&Diary::empty()).unwrap();
    drop(empty);
    let (_, opened, error) = Store::load(tabs.join("d.hush"), None).unwrap();
    assert!(error.is_none() && !opened.recovered && opened.path.is_none());
    assert_eq!(opened.document, Diary::empty());

    // 没有暂存（连工作副本都没有）：重新打开文件，内容是文件里的，没有未保存标记。
    let (store, opened, error) = Store::load(tabs.join("e.hush"), Some(&path)).unwrap();
    assert_eq!(error, None);
    assert!(!opened.recovered);
    assert_eq!(opened.document, diary("文件里的"));
    assert_eq!(store.path(), Some(path.as_path()));
    drop(store);

    // 没有暂存且文件已改名：空的“无标题”标签页，并说明原因。
    fs::rename(&file, root.join("改名了.hush")).unwrap();
    let (store, opened, error) = Store::load(tabs.join("e.hush"), Some(&path)).unwrap();
    let error = error.expect("应说明文件打不开");
    assert!(error.contains("已保存.hush"), "{error}");
    assert!(!opened.recovered && opened.path.is_none() && store.path().is_none());
    assert_eq!(opened.document, Diary::empty());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
/// “打开上一会话中的内容”关闭最后一个窗口时，内容与已保存相同的标签页丢掉暂存：
/// 下次启动重新打开文件，不带未保存标记；导入过的图片留在工作副本里直到被重置。
#[test]
fn a_discarded_stash_is_not_restored_as_unsaved_changes() {
    let root = temp();
    let tabs = root.join("tabs");
    let file = root.join("原样.hush");
    let path = Store::create(tabs.join("a.hush"))
        .unwrap()
        .save_as(&file, &diary("原样"))
        .unwrap()
        .path
        .unwrap();
    let (mut store, _) = Store::open_new(tabs.join("b.hush"), &path).unwrap();
    // 改了又撤销回原样：暂存的仍是一份正文（与文件相同），导入的图片也还在。
    let picture = import(&mut store, &photo(11, 64));
    store.stash(&with_pictures("改过", &[&picture])).unwrap();
    store.stash(&diary("原样")).unwrap();
    assert!(Store::has_stash(&tabs.join("b.hush"), true));
    store.discard_stash().unwrap();
    // 没有暂存时再丢一次也不出错。
    store.discard_stash().unwrap();
    assert!(store.current().unwrap().document == diary("原样"));
    assert!(!store.current().unwrap().recovered);
    drop(store);
    // 只有导入过的图片、没有暂存正文，不算未保存的修改。
    assert!(!Store::has_stash(&tabs.join("b.hush"), true));
    let (store, opened, error) = Store::load(tabs.join("b.hush"), Some(&path)).unwrap();
    assert_eq!(error, None);
    assert!(!opened.recovered && opened.notice.is_none());
    assert_eq!(opened.document, diary("原样"));
    assert_eq!(store.path(), Some(path.as_path()));
    // 重新打开文件时工作副本被重置，没保存的图片不会留下。
    assert_eq!(rows(&tabs.join("b.hush"), "images"), 0);
    drop(store);
    assert_eq!(reopen(&file), diary("原样"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn export_writes_content_and_listed_originals() {
    let root = temp();
    let mut store = session(&root);
    let a = photo(6, 64);
    let private = photo(7, 64);
    let pic = import(&mut store, &a);
    import(&mut store, &private);
    let out = root.join("export");
    fs::create_dir(&out).unwrap();
    let images = [ExportImage {
        id: pic.id.clone(),
        file: "照片.jpg".into(),
    }];
    store
        .export(&out.join("diary.html"), "<p>html</p>", &images)
        .unwrap();
    assert_eq!(
        fs::read_to_string(out.join("diary.html")).unwrap(),
        "<p>html</p>"
    );
    assert_eq!(fs::read(out.join("附件").join("照片.jpg")).unwrap(), a);
    assert_eq!(fs::read_dir(out.join("附件")).unwrap().count(), 1);
    // Existing files are not overwritten; TXT export copies nothing.
    fs::write(out.join("附件").join("照片.jpg"), b"mine").unwrap();
    store
        .export(&out.join("diary.html"), "again", &images)
        .unwrap();
    assert_eq!(
        fs::read(out.join("附件").join("照片.jpg")).unwrap(),
        b"mine"
    );
    store.export(&root.join("diary.txt"), "文本", &[]).unwrap();
    assert_eq!(fs::read_to_string(root.join("diary.txt")).unwrap(), "文本");
    assert!(!root.join("附件").exists());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn close_succeeds_when_the_file_cannot_be_cleaned() {
    let root = temp();
    let file = root.join("损坏.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("")).unwrap();
    let pic = import(&mut store, &photo(13, 64));
    store.save(&with_pictures("", &[&pic])).unwrap();
    store.stash(&diary("不保存")).unwrap();
    damage_body(&file);
    let warning = store.close().unwrap();
    assert!(warning.starts_with("未引用图片未能清理："), "{warning}");
    // The unsaved changes are still discarded.
    assert!(!working(&root).exists());
    assert_eq!(rows(&file, "images"), 1);

    // The whole file replaced by garbage, as a failing drive might leave it.
    drop(store);
    fs::remove_dir_all(&root).unwrap();
    let root = temp();
    let other = root.join("乱码.hush");
    let mut store = session(&root);
    store.save_as(&other, &diary("")).unwrap();
    store.stash(&diary("不保存")).unwrap();
    fs::write(&other, vec![0x5a; 8192]).unwrap();
    let warning = store.close().unwrap();
    assert!(
        warning.contains("不是有效的 .hush 文件或文件已损坏"),
        "{warning}"
    );
    assert!(!working(&root).exists());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn close_succeeds_when_the_working_copy_cannot_be_discarded() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = temp();
    let mut store = session(&root);
    store.save_as(&root.join("a.hush"), &diary("")).unwrap();
    store.stash(&diary("不保存")).unwrap();
    // Another program holding the working copy without delete sharing blocks its removal.
    const FILE_SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    let holder = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ_WRITE)
        .open(working(&root))
        .unwrap();
    let warning = store.close().unwrap();
    assert!(warning.starts_with("未保存的修改未能丢弃："), "{warning}");
    drop(holder);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

/// Bytes that start like an MP4 and do not compress away; nothing decodes them.
fn clip(seed: u32, len: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    let mut bytes = b"\0\0\0\x20ftypisom\0\0\x02\0".to_vec();
    while bytes.len() < len {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        bytes.push(state as u8);
    }
    bytes
}
/// What the import_media command does, minus the IPC.
fn import_clip(store: &mut Store, bytes: &[u8], kind: MediaKind) -> Picture {
    let id = images::hash(bytes);
    store.add_image(&id, bytes, None).unwrap();
    Picture {
        id,
        name: "片段.mp4".into(),
        width: 640,
        height: 360,
        kind,
        duration: Some(3.5),
    }
}
/// A small PNG standing in for the cover the front end draws.
fn cover(shade: u8) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(4, 3, image::Rgb([shade, 0, 0])))
        .write_to(&mut out, ImageFormat::Png)
        .unwrap();
    out.into_inner()
}
fn user_version(file: &Path) -> i64 {
    Connection::open(file)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}
fn has_posters(file: &Path) -> bool {
    Connection::open(file)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'posters'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
        == 1
}
/// A file (or working copy) as LineHush 0.9.0 wrote it: format v1, no posters table.
fn write_v1(path: &Path, body: Option<&Diary>, originals: &[&[u8]]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "PRAGMA auto_vacuum = INCREMENTAL;
         PRAGMA application_id = 1213551432;
         PRAGMA user_version = 1;
         CREATE TABLE doc (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
         CREATE TABLE images (id TEXT PRIMARY KEY, data BLOB NOT NULL);",
    )
    .unwrap();
    if let Some(body) = body {
        conn.execute(
            "INSERT INTO doc (id, body) VALUES (1, ?1)",
            [serde_json::to_string(body).unwrap()],
        )
        .unwrap();
    }
    for bytes in originals {
        conn.execute(
            "INSERT INTO images (id, data) VALUES (?1, ?2)",
            rusqlite::params![images::hash(bytes), bytes],
        )
        .unwrap();
    }
}

#[test]
fn media_are_saved_byte_for_byte_and_read_by_range() {
    let root = temp();
    let file = root.join("视频.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("")).unwrap();
    let bytes = clip(1, 300_000);
    let pic = import_clip(&mut store, &bytes, MediaKind::Video);
    let audio_bytes = clip(2, 5_000);
    let audio = import_clip(&mut store, &audio_bytes, MediaKind::Audio);
    // Ranges from the working copy; a range past the end is cut short.
    let len = bytes.len() as u64;
    assert_eq!(store.image_len(&pic.id).unwrap(), Some(len));
    assert_eq!(store.image_range(&pic.id, 0, 16).unwrap().unwrap(), bytes[..16]);
    assert_eq!(
        store.image_range(&pic.id, 1000, 70_000).unwrap().unwrap(),
        bytes[1000..71_000]
    );
    assert_eq!(
        store.image_range(&pic.id, len - 10, 100).unwrap().unwrap(),
        bytes[bytes.len() - 10..]
    );
    assert_eq!(store.image_range(&pic.id, len, 100).unwrap(), Some(Vec::new()));
    assert_eq!(store.image_len("missing").unwrap(), None);
    assert_eq!(store.image_range("missing", 0, 16).unwrap(), None);
    assert_eq!(images::sniff_media_mime(&bytes[..16]), "video/mp4");

    let poster = cover(200);
    store.add_poster(&pic.id, &poster).unwrap();
    assert_eq!(rows(&working(&root), "posters"), 1);
    let doc = with_pictures("视频", &[&pic, &audio]);
    store.save(&doc).unwrap();
    // The originals go into the file as they are, the cover with them.
    let stored: Vec<u8> = Connection::open(&file)
        .unwrap()
        .query_row("SELECT data FROM images WHERE id = ?1", [&pic.id], |r| r.get(0))
        .unwrap();
    assert_eq!(stored, bytes);
    assert_eq!(rows(&file, "images"), 2);
    assert_eq!(rows(&file, "posters"), 1);
    assert_eq!(rows(&working(&root), "posters"), 0);
    assert_eq!(reopen(&file), doc);
    let body: String = Connection::open(&file)
        .unwrap()
        .query_row("SELECT body FROM doc", [], |r| r.get(0))
        .unwrap();
    assert!(body.contains(r#""kind":"video","duration":3.5"#), "{body}");

    // Another tab reads ranges and the cover from the file; the cover is the
    // video's thumbnail, never decoded from the original.
    let reader = Mutex::new(other(&root, &file));
    assert_eq!(
        reader.lock().unwrap().image_range(&pic.id, 299_990, 10).unwrap().unwrap(),
        bytes[299_990..]
    );
    assert_eq!(reader.lock().unwrap().image_len(&audio.id).unwrap(), Some(5_000));
    let thumb = Store::thumbnail(&reader, &pic.id, |_| panic!("decoded")).unwrap();
    assert_eq!(thumb, poster);
    assert_eq!(reader.lock().unwrap().poster(&audio.id).unwrap(), None);
    drop(reader);

    // Save as carries the originals and the cover; leaving the file drops both
    // once the saved body no longer references them.
    let copy = root.join("副本.hush");
    store.save_as(&copy, &doc).unwrap();
    assert_eq!(rows(&copy, "images"), 2);
    assert_eq!(rows(&copy, "posters"), 1);
    let only_audio = with_pictures("", &[&audio]);
    store.save(&only_audio).unwrap();
    assert_eq!(store.close(), None);
    assert_eq!(rows(&copy, "images"), 1);
    assert_eq!(rows(&copy, "posters"), 0);
    assert_eq!(reopen(&copy), only_audio);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn covers_imported_into_an_unnamed_draft_go_into_its_first_file() {
    let root = temp();
    let mut store = session(&root);
    let bytes = clip(3, 20_000);
    let pic = import_clip(&mut store, &bytes, MediaKind::Video);
    store.add_poster(&pic.id, &cover(10)).unwrap();
    let doc = with_pictures("", &[&pic]);
    let file = root.join("草稿.hush");
    store.save_as(&file, &doc).unwrap();
    assert_eq!(rows(&file, "posters"), 1);
    assert_eq!(user_version(&file), 2);
    drop(store);
    let reader = Mutex::new(other(&root, &file));
    assert_eq!(
        Store::thumbnail(&reader, &pic.id, |_| panic!("decoded")).unwrap(),
        cover(10)
    );
    drop(reader);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn v1_files_are_upgraded_by_their_first_save_only() {
    let root = temp();
    let photo_bytes = photo(9, 64);
    let (photo_pic, _) = images::prepare(&photo_bytes).unwrap();
    let saved = with_pictures("旧文件", &[&photo_pic]);
    let file = root.join("旧.hush");
    write_v1(&file, Some(&saved), &[&photo_bytes]);
    // Opening, reading and leaving a v1 file does not change its format.
    let before = fs::read(&file).unwrap();
    let reader = Mutex::new(other(&root, &file));
    let thumb = Store::thumbnail(&reader, &photo_pic.id, images::thumbnail).unwrap();
    assert_eq!(thumb, images::thumbnail(&photo_bytes).unwrap());
    assert_eq!(reader.lock().unwrap().poster(&photo_pic.id).unwrap(), None);
    assert_eq!(reader.lock().unwrap().close(), None);
    drop(reader);
    assert_eq!(fs::read(&file).unwrap(), before);
    assert_eq!(user_version(&file), 1);

    // A crash of 0.9.0 left a v1 working copy with unsaved changes; saving it
    // upgrades the file, though the working copy has no covers to bring along.
    let edited = with_pictures("改过\n", &[&photo_pic]);
    write_v1(&working(&root), Some(&edited), &[]);
    let (mut store, opened) = load(&root, Some(&file));
    assert_eq!(opened.document, edited);
    store.save(&edited).unwrap();
    assert_eq!(user_version(&file), 2);
    assert!(has_posters(&file));
    assert_eq!(rows(&file, "posters"), 0);
    assert_eq!(reopen(&file), edited);
    drop(store);

    // A v1 working copy of a draft (another session) takes a cover too, and
    // save as upgrades the copy.
    let draft_root = temp();
    write_v1(&working(&draft_root), Some(&diary("草稿")), &[]);
    let (mut store, _) = load(&draft_root, None);
    let bytes = clip(4, 10_000);
    let pic = import_clip(&mut store, &bytes, MediaKind::Video);
    store.add_poster(&pic.id, &cover(30)).unwrap();
    let target = root.join("新.hush");
    let doc = with_pictures("草稿", &[&pic]);
    store.save_as(&target, &doc).unwrap();
    assert_eq!(user_version(&target), 2);
    assert_eq!(rows(&target, "posters"), 1);
    assert_eq!(reopen(&target), doc);
    drop(store);
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(draft_root).unwrap();
}
