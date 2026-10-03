use crate::images;
use crate::model::{Block, Diary, ExportImage, Picture};
use crate::store::Store;
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
    store.add_image(&picture.id, bytes, thumbnail).unwrap();
    picture
}
fn rows(file: &Path, table: &str) -> i64 {
    Connection::open(file)
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
/// The working copy of the session started by `session(root)`.
fn working(root: &Path) -> PathBuf {
    root.join("app").join("working.hush")
}
/// Opens `file` in a separate session, as the next launch would.
fn reopen(file: &Path) -> Diary {
    let root = temp();
    let document = Store::new(root.clone())
        .unwrap()
        .open(file)
        .unwrap()
        .document;
    fs::remove_dir_all(root).unwrap();
    document
}
fn session(root: &Path) -> Store {
    let mut store = Store::new(root.join("app")).unwrap();
    store.restore().unwrap();
    store
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
    assert_eq!(pragma("user_version"), 1);
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
fn concurrent_thumbnail_requests_decode_once() {
    let root = temp();
    let file = root.join("并发.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("")).unwrap();
    let bytes = photo(8, 64);
    let pic = import(&mut store, &bytes);
    store.save(&with_pictures("", &[&pic])).unwrap();
    // A fresh session has nothing cached.
    let mut other = Store::new(root.join("other")).unwrap();
    other.open(&file).unwrap();
    let other = Mutex::new(other);
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
    assert_eq!(builds.load(Ordering::SeqCst), 1);
    let expected = images::thumbnail(&bytes).unwrap();
    assert!(thumbs.iter().all(|t| *t == expected));
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
    let mut other = Store::new(root.join("other")).unwrap();
    other.open(&file).unwrap();
    assert!(other.image(&pic.id).is_err());
    drop(other);
    // This session reads the image from the working copy.
    assert_eq!(store.image(&pic.id).unwrap(), bytes);

    store.save(&edited).unwrap();
    assert_eq!(reopen(&file), edited);
    assert_eq!(rows(&file, "images"), 1);
    let mut other = Store::new(root.join("other")).unwrap();
    other.open(&file).unwrap();
    assert_eq!(other.image(&pic.id).unwrap(), bytes);
    drop(other);
    // The working copy is empty again.
    assert_eq!(rows(&working(&root), "doc"), 0);
    assert_eq!(rows(&working(&root), "images"), 0);
    // Mid-session the image survives even after the saved body stops referencing it.
    store.save(&diary("删掉了")).unwrap();
    assert_eq!(store.image(&pic.id).unwrap(), bytes);
    assert_eq!(rows(&file, "images"), 1);
    drop(store);
    let opened = Store::new(root.join("app")).unwrap().restore().unwrap();
    assert!(!opened.recovered);
    assert_eq!(opened.document, diary("删掉了"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn unsaved_changes_survive_a_crash() {
    let root = temp();
    let file = root.join("崩溃.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("已保存")).unwrap();
    drop(store);
    // Nothing stashed: the file is reopened as saved.
    let mut store = Store::new(root.join("app")).unwrap();
    let opened = store.restore().unwrap();
    assert!(opened.path.unwrap().ends_with("崩溃.hush") && !opened.recovered);
    assert_eq!(opened.document, diary("已保存"));
    let bytes = photo(3, 64);
    let pic = import(&mut store, &bytes);
    let edited = with_pictures("崩溃前\n\n", &[&pic]);
    store.stash(&edited).unwrap();
    // A crash: nothing else runs before the next launch.
    drop(store);
    let mut store = Store::new(root.join("app")).unwrap();
    let opened = store.restore().unwrap();
    assert!(opened.path.unwrap().ends_with("崩溃.hush") && opened.recovered);
    assert_eq!(opened.document, edited);
    assert_eq!(store.image(&pic.id).unwrap(), bytes);
    assert_eq!(reopen(&file), diary("已保存"));
    // Saving after the restart completes the recovered edit.
    store.save(&edited).unwrap();
    assert_eq!(reopen(&file), edited);
    drop(store);
    let mut other = Store::new(root.join("other")).unwrap();
    other.open(&file).unwrap();
    assert_eq!(other.image(&pic.id).unwrap(), bytes);
    drop(other);
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
    store.close().unwrap();
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
    store.close().unwrap();
    assert_eq!(reopen(&file), saved);
    let small = fs::metadata(&file).unwrap().len();
    assert!(small + big.len() as u64 / 2 < full, "{small} vs {full}");
    assert_eq!(rows(&file, "images"), 1);
    assert!(store.image(&big_pic.id).is_err());
    assert!(store.image(&extra_pic.id).is_err());
    assert_eq!(store.image(&kept_pic.id).unwrap(), kept);
    drop(store);
    let opened = Store::new(root.join("app")).unwrap().restore().unwrap();
    assert!(!opened.recovered);
    assert_eq!(opened.document, saved);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn switching_documents_discards_unsaved_changes_and_cleans_the_file() {
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
    let opened = store.new_document().unwrap();
    assert!(opened.path.is_none() && !opened.recovered);
    assert_eq!(rows(&a, "images"), 0);
    assert_eq!(reopen(&a), diary("a"));
    assert_eq!(rows(&working(&root), "doc"), 0);
    assert_eq!(rows(&working(&root), "images"), 0);

    store.save_as(&b, &diary("b")).unwrap();
    store.stash(&diary("b 没保存")).unwrap();
    let opened = store.open(&a).unwrap();
    assert!(!opened.recovered);
    assert_eq!(opened.document, diary("a"));
    assert_eq!(reopen(&b), diary("b"));
    drop(store);
    let opened = Store::new(root.join("app")).unwrap().restore().unwrap();
    assert!(opened.path.unwrap().ends_with("a.hush") && !opened.recovered);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn draft_is_restored_then_moved_into_save_as_target() {
    let root = temp();
    // A fresh, untouched draft is not reported as recovered.
    let opened = Store::new(root.join("app")).unwrap().restore().unwrap();
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
    let mut store = Store::new(root.join("app")).unwrap();
    let opened = store.restore().unwrap();
    assert!(opened.path.is_none() && opened.recovered);
    assert_eq!(opened.document, doc);
    assert_eq!(store.image(&pic.id).unwrap(), bytes);

    let out = root.join("out");
    fs::create_dir(&out).unwrap();
    let opened = store.save_as(&out.join("日记"), &doc).unwrap();
    let file = opened.path.unwrap();
    assert_eq!(file.file_name().unwrap(), "日记.hush");
    // The draft now lives in the file.
    assert_eq!(rows(&working(&root), "doc"), 0);
    assert_eq!(rows(&working(&root), "images"), 0);
    let mut other = Store::new(root.join("other")).unwrap();
    assert_eq!(other.open(&file).unwrap().document, doc);
    assert_eq!(other.image(&pic.id).unwrap(), bytes);
    drop(other);
    store.save(&diary("另存后继续写")).unwrap();
    drop(store);
    let mut store = Store::new(root.join("app")).unwrap();
    let opened = store.restore().unwrap();
    assert!(opened.path.is_some() && !opened.recovered);
    assert_eq!(opened.document, diary("另存后继续写"));
    assert_eq!(store.image(&pic.id).unwrap(), bytes);
    drop(store);
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
    let mut other = Store::new(root.join("other")).unwrap();
    assert_eq!(other.open(&b).unwrap().document, doc);
    assert_eq!(other.image(&old_pic.id).unwrap(), old);
    assert_eq!(other.image(&new_pic.id).unwrap(), new);
    drop(other);
    // The old file keeps its last saved state.
    assert_eq!(reopen(&a), with_pictures("a", &[&old_pic]));
    assert_eq!(rows(&a, "images"), 1);
    assert_eq!(rows(&working(&root), "doc"), 0);
    assert_eq!(rows(&working(&root), "images"), 0);
    drop(store);
    let opened = Store::new(root.join("app")).unwrap().restore().unwrap();
    assert!(opened.path.unwrap().ends_with("b.hush") && !opened.recovered);
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
    let mut other = Store::new(root.join("other")).unwrap();
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
    // Emptiness and line breaks inside a line are not checked.
    assert_eq!(
        read(r#"{"blocks":[{"type":"line","text":"a\rb"}]}"#).unwrap(),
        Diary {
            blocks: vec![Block::Line {
                text: "a\rb".into()
            }]
        }
    );
    assert_eq!(read(r#"{"blocks":[]}"#).unwrap(), Diary { blocks: vec![] });
    drop(store);
    drop(other);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn failed_open_leaves_current_session_usable() {
    let root = temp();
    let file = root.join("a.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("first")).unwrap();
    assert!(store.open(&root.join("missing.hush")).is_err());
    assert!(!root.join("missing.hush").exists());
    let not_hush = root.join("plain.hush");
    fs::write(&not_hush, "not sqlite").unwrap();
    assert!(store.open(&not_hush).is_err());
    store.save(&diary("second")).unwrap();
    assert_eq!(reopen(&file), diary("second"));
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn missing_recovered_file_falls_back_to_a_draft() {
    let root = temp();
    let file = root.join("gone.hush");
    let mut store = session(&root);
    store.save_as(&file, &diary("x")).unwrap();
    drop(store);
    fs::remove_file(&file).unwrap();
    let mut store = Store::new(root.join("app")).unwrap();
    assert!(store.restore().is_err());
    store.stash(&diary("继续写")).unwrap();
    let opened = Store::new(root.join("app")).unwrap().restore().unwrap();
    assert!(opened.path.is_none() && opened.recovered);
    assert_eq!(opened.document, diary("继续写"));
    // A broken recovery.json counts as missing.
    fs::write(root.join("app").join("recovery.json"), "{").unwrap();
    let opened = Store::new(root.join("app")).unwrap().restore().unwrap();
    assert_eq!(opened.document, diary("继续写"));
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn unsaved_changes_survive_a_crash_after_their_file_is_moved() {
    let root = temp();
    let file = root.join("搬走.hush");
    let mut store = session(&root);
    let saved_pic = import(&mut store, &photo(5, 64));
    store
        .save_as(&file, &with_pictures("已保存", &[&saved_pic]))
        .unwrap();
    let bytes = photo(6, 64);
    let pic = import(&mut store, &bytes);
    let edited = with_pictures("崩溃前\n\n", &[&pic]);
    store.stash(&edited).unwrap();
    // A crash, then the file is moved away before the next launch.
    drop(store);
    fs::rename(&file, root.join("别处.hush")).unwrap();
    let mut store = Store::new(root.join("app")).unwrap();
    let opened = store.restore().unwrap();
    assert!(opened.path.is_none() && opened.recovered);
    assert_eq!(opened.document, edited);
    let notice = opened.notice.unwrap();
    assert!(
        notice.contains("未保存的修改已作为未命名文档恢复") && notice.contains("搬走.hush"),
        "{notice}"
    );
    assert_eq!(store.image(&pic.id).unwrap(), bytes);
    // Images that only the moved file held are gone from this document.
    assert!(store.image(&saved_pic.id).is_err());
    let recovery = fs::read_to_string(root.join("app").join("recovery.json")).unwrap();
    assert_eq!(recovery, r#"{"path":null}"#);
    // The recovered draft is saved like any other.
    let target = root.join("新.hush");
    store.save_as(&target, &edited).unwrap();
    assert_eq!(reopen(&target), edited);
    drop(store);
    let mut other = Store::new(root.join("other")).unwrap();
    other.open(&target).unwrap();
    assert_eq!(other.image(&pic.id).unwrap(), bytes);
    drop(other);
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
