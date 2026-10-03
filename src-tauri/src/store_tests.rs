use crate::fsx::{read_diary, sidecar, unique_id};
use crate::model::{Block, Diary, Picture, ATTACHMENTS};
use crate::store::Store;
use std::{fs, path::PathBuf};

fn temp() -> PathBuf {
    let p = std::env::temp_dir().join(format!("linehush-test-{}", unique_id()));
    fs::create_dir_all(&p).unwrap();
    p
}
fn diary(text: &str) -> Diary {
    Diary {
        version: 1,
        blocks: text
            .split('\n')
            .map(|s| Block::Line { text: s.into() })
            .collect(),
    }
}
fn with_picture(name: &str) -> Diary {
    Diary {
        version: 1,
        blocks: vec![Block::Images {
            images: vec![Picture {
                path: format!("{ATTACHMENTS}/{name}"),
                name: name.into(),
                width: 1,
                height: 1,
            }],
        }],
    }
}
#[test]
fn save_roundtrip_and_backup_from_session_start() {
    let root = temp();
    let file = root.join("日记.linehush");
    let a = diary("中文\n\n末尾\n\n");
    let mut session = Store::new(root.join("app")).unwrap();
    session.save_as(&file, &a).unwrap();
    assert_eq!(read_diary(&file).unwrap(), a);
    let b = diary("第二版\n");
    session.save(&b).unwrap();
    assert_eq!(read_diary(&file).unwrap(), b);
    assert!(!sidecar(&file, ".bak").exists());
    // Reopening takes a backup of the version the session starts from; saves leave it alone.
    session.open(&file).unwrap();
    session.save(&diary("第三版")).unwrap();
    assert_eq!(read_diary(&sidecar(&file, ".bak")).unwrap(), b);
    assert_eq!(read_diary(&file).unwrap(), diary("第三版"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn restore_reopens_saved_file_and_keeps_unsaved_draft() {
    let root = temp();
    let file = root.join("日记.linehush");
    let mut session = Store::new(root.join("app")).unwrap();
    session.save_as(&file, &diary("已保存")).unwrap();
    let opened = Store::new(root.join("app")).unwrap().restore().unwrap();
    assert_eq!(opened.document, diary("已保存"));
    assert!(opened.path.is_some() && !opened.recovered);
    session.new_document().unwrap();
    session.save(&diary("草稿\n\n")).unwrap();
    let opened = Store::new(root.join("app")).unwrap().restore().unwrap();
    assert_eq!(opened.document, diary("草稿\n\n"));
    assert!(opened.path.is_none() && opened.recovered);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn read_enforces_only_serde_structure() {
    let root = temp();
    let file = root.join("x.linehush");
    let read = |json: &str| {
        fs::write(&file, json).unwrap();
        read_diary(&file)
    };
    let line = |text: &str| Block::Line { text: text.into() };
    // Unknown node types and unknown fields are rejected by serde.
    assert!(read(r#"{"version":1,"blocks":[{"type":"heading","text":"x"}]}"#).is_err());
    assert!(read(r#"{"version":1,"blocks":[{"type":"line","text":"x","bold":true}]}"#).is_err());
    assert!(read(r#"{"version":1,"blocks":[],"title":"x"}"#).is_err());
    // Version, emptiness and line breaks inside a line are no longer checked.
    let read_ok = |json: &str| read(json).unwrap();
    assert_eq!(
        read_ok(r#"{"version":1,"blocks":[{"type":"line","text":"a\rb"}]}"#),
        Diary {
            version: 1,
            blocks: vec![line("a\rb")]
        }
    );
    assert_eq!(
        read_ok(r#"{"version":2,"blocks":[{"type":"line","text":"ok"}]}"#),
        Diary {
            version: 2,
            blocks: vec![line("ok")]
        }
    );
    assert_eq!(
        read_ok(r#"{"version":1,"blocks":[]}"#),
        Diary {
            version: 1,
            blocks: vec![]
        }
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn failed_open_leaves_current_session_usable() {
    let root = temp();
    let file = root.join("a.linehush");
    let mut store = Store::new(root.join("app")).unwrap();
    store.save_as(&file, &diary("first")).unwrap();
    assert!(store.open(&root.join("missing")).is_err());
    store.save(&diary("second")).unwrap();
    assert_eq!(read_diary(&file).unwrap(), diary("second"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn save_as_adds_extension_and_copies_referenced_images() {
    let root = temp();
    let mut store = Store::new(root.join("app")).unwrap();
    let folder = store.base_dir.join(ATTACHMENTS);
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("a.png"), b"a").unwrap();
    fs::write(folder.join("unused.png"), b"unused").unwrap();
    let out = root.join("out");
    fs::create_dir(&out).unwrap();
    let opened = store
        .save_as(&out.join("日记"), &with_picture("a.png"))
        .unwrap();
    assert_eq!(opened.path.unwrap().file_name().unwrap(), "日记.linehush");
    assert!(out.join(ATTACHMENTS).join("a.png").exists());
    assert!(!out.join(ATTACHMENTS).join("unused.png").exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn html_export_copies_only_referenced_images() {
    let root = temp();
    let store = Store::new(root.join("app")).unwrap();
    let folder = store.base_dir.join(ATTACHMENTS);
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("a.png"), b"a").unwrap();
    fs::write(folder.join("private.png"), b"private").unwrap();
    let out = root.join("export");
    fs::create_dir(&out).unwrap();
    store
        .export(
            &out.join("diary.html"),
            "html",
            true,
            &with_picture("a.png"),
        )
        .unwrap();
    assert!(out.join(ATTACHMENTS).join("a.png").exists());
    assert!(!out.join(ATTACHMENTS).join("private.png").exists());
    fs::remove_dir_all(root).unwrap();
}
