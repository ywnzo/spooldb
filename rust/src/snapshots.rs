use crate::{
    Result,
    git_bridge::{Entry, open_directory, parent, read_entry, safe_path},
    private_files, storage_cli, storage_submit,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use rustix::fs::{self as fd_fs, AtFlags, FileType, Mode, OFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Write},
    os::fd::AsFd,
    path::{Path, PathBuf},
};
use unicode_normalization_alignments::UnicodeNormalization;

const MARKER: &str = ".spool-snapshot.json";
const PRIVATE_FILE: Mode = Mode::from_bits_truncate(0o600);

#[derive(Serialize, Deserialize)]
struct PlannedFile {
    path: String,
    #[serde(flatten)]
    entry: Entry,
}

#[derive(Serialize, Deserialize)]
struct Plan {
    branch: String,
    room: String,
    heads: Vec<String>,
    files: Vec<PlannedFile>,
}

fn portable(name: &str) -> String {
    name.nfc()
        .map(|(character, _)| character)
        .collect::<String>()
        .to_lowercase()
}

fn validate(plan: &Plan) -> Result<()> {
    let mut names = BTreeSet::new();
    let mut casing = BTreeMap::new();
    for file in &plan.files {
        safe_path(&file.path)?;
        storage_submit::FileContent::parse(&serde_json::to_value(&file.entry)?)?;
        if !names.insert(portable(&file.path)) {
            return Err("Case or Unicode path collision".into());
        }
        for prefix in file
            .path
            .match_indices('/')
            .map(|(at, _)| &file.path[..at])
            .chain(std::iter::once(file.path.as_str()))
        {
            if casing
                .insert(portable(prefix), prefix)
                .is_some_and(|prior| prior != prefix)
            {
                return Err("Case or Unicode directory collision".into());
            }
        }
        if file.entry.kind == "symlink" {
            let target = &file.entry.target;
            if target.starts_with('/')
                || target.contains('\\')
                || target
                    .split('/')
                    .any(|piece| piece == ".." || piece.eq_ignore_ascii_case(".git"))
            {
                return Err(format!("Unsafe symlink target: {}", file.path).into());
            }
        }
    }
    for name in &names {
        if name
            .match_indices('/')
            .any(|(at, _)| names.contains(&name[..at]))
        {
            return Err("File/directory path collision".into());
        }
    }
    Ok(())
}

fn write_exclusive(parent: &impl AsFd, name: &str, bytes: &[u8], mode: Mode) -> Result<()> {
    let fd = fd_fs::openat(
        parent,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        PRIVATE_FILE,
    )?;
    let mut file = File::from(fd);
    file.write_all(bytes)?;
    fd_fs::fchmod(&file, mode)?;
    file.sync_all()?;
    Ok(())
}

fn plan_state(state: &Value, branch: &str) -> Result<Plan> {
    let mut files = Vec::new();
    for file in state["files"]
        .as_array()
        .ok_or("Invalid branch files")?
        .iter()
        .filter(|file| file["deleted"] != true)
    {
        let path = storage_cli::field(file, "path")?.to_owned();
        let content = storage_submit::FileContent::parse(file)?;
        files.push(PlannedFile {
            path,
            entry: Entry {
                kind: content.kind.into(),
                mode: u32::try_from(content.mode)?,
                text: content.text.into(),
                data: content.data.into(),
                target: content.target.into(),
            },
        });
    }
    Ok(Plan {
        branch: branch.into(),
        room: storage_cli::field(state, "room")?.into(),
        heads: serde_json::from_value(state["heads"].clone())?,
        files,
    })
}

fn create(db: &mut Connection, legacy: bool, request: &Value) -> Result<Value> {
    let branch = request["branch"].as_str().unwrap_or("main");
    let mut input = json!({"command":"read","branch":branch});
    if let Some(heads) = request.get("heads") {
        input["heads"] = heads.clone();
    }
    let target = std::path::absolute(storage_cli::field(request, "target")?)?;
    let directory = fs::canonicalize(target.parent().ok_or("Invalid snapshot destination")?)?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid snapshot name")?;
    let root = directory.join(name);
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = storage_cli::execute_layout(&tx, legacy, &input, None)?;
    if state["conflicts"]
        .as_array()
        .is_none_or(|conflicts| !conflicts.is_empty())
    {
        return Err("Resolve recorded conflicts before materialization".into());
    }
    let plan = plan_state(&state, branch)?;
    validate(&plan)?;
    {
        let mut query = tx.prepare_cached("SELECT root FROM sources ORDER BY root")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let source = PathBuf::from(row.get::<_, String>(0)?);
            if root.starts_with(&source) || source.starts_with(&root) {
                return Err("Snapshot must be separate from attached source checkouts".into());
            }
        }
    }
    let id = private_files::random_id()?;
    let parent = open_directory(&directory)?;
    fd_fs::mkdirat(&parent, name, Mode::from_bits_truncate(0o700))?;
    let output = fd_fs::openat(
        &parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    write_exclusive(
        &output,
        MARKER,
        &serde_json::to_vec(&json!({"id":id,"room":plan.room,"heads":plan.heads}))?,
        PRIVATE_FILE,
    )?;
    fd_fs::fsync(&output)?;
    fd_fs::fsync(&parent)?;
    tx.execute(
        "INSERT INTO snapshots(id,root,plan) VALUES(?1,?2,?3)",
        params![
            id,
            root.to_str().ok_or("Invalid snapshot directory")?,
            serde_json::to_string(&plan)?
        ],
    )?;
    tx.commit()?;
    recover(db, &id)
}

fn same_disk(actual: &Entry, expected: &Entry) -> bool {
    if actual.kind == "symlink" || expected.kind == "symlink" {
        return actual.kind == expected.kind && actual.target == expected.target;
    }
    let bytes = |entry: &Entry| {
        if entry.kind == "binary" {
            STANDARD.decode(&entry.data).ok()
        } else {
            Some(entry.text.as_bytes().to_vec())
        }
    };
    actual.mode == expected.mode && bytes(actual) == bytes(expected)
}

fn recover(db: &mut Connection, id: &str) -> Result<Value> {
    crate::shards::validate_id(id, "snapshot ID")?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (root, encoded, complete): (String, String, bool) = tx
        .query_row(
            "SELECT root,plan,complete FROM snapshots WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or("Unknown snapshot")?;
    let plan: Plan = serde_json::from_str(&encoded)?;
    validate(&plan)?;
    let root_path = Path::new(&root);
    if fs::canonicalize(root_path)? != root_path {
        return Err("Snapshot root changed".into());
    }
    let output = open_directory(root_path)?;
    let marker = File::from(fd_fs::openat(
        &output,
        MARKER,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )?);
    if !marker.metadata()?.is_file() {
        return Err("Invalid snapshot ownership marker".into());
    }
    let mut marker_body = Vec::new();
    marker.take(64 * 1024).read_to_end(&mut marker_body)?;
    let marker: Value = serde_json::from_slice(&marker_body)?;
    if marker["id"] != id || marker["room"] != plan.room || marker["heads"] != json!(plan.heads) {
        return Err("Snapshot ownership marker changed".into());
    }
    for file in &plan.files {
        let Some((directory, name)) = parent(&output, &file.path, !complete)? else {
            return Err(format!("Completed snapshot has missing file: {}", file.path).into());
        };
        if let Some(actual) = read_entry(&directory, &name)? {
            if !same_disk(&actual, &file.entry) {
                return Err(format!("Snapshot has local edits: {}", file.path).into());
            }
            continue;
        }
        if complete {
            return Err(format!("Completed snapshot has missing file: {}", file.path).into());
        }
        if file.entry.kind == "symlink" {
            fd_fs::symlinkat(file.entry.target.as_str(), &directory, name.as_str())?;
        } else {
            let temp = format!(".spool-temp-{id}");
            match fd_fs::statat(&directory, temp.as_str(), AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) if FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile => {
                    fd_fs::unlinkat(&directory, temp.as_str(), AtFlags::empty())?;
                }
                Ok(_) => return Err("Unsafe snapshot staging file".into()),
                Err(rustix::io::Errno::NOENT) => {}
                Err(error) => return Err(error.into()),
            }
            let bytes = if file.entry.kind == "binary" {
                STANDARD.decode(&file.entry.data)?
            } else {
                file.entry.text.as_bytes().to_vec()
            };
            write_exclusive(
                &directory,
                &temp,
                &bytes,
                Mode::from_bits_truncate(file.entry.mode),
            )?;
            fd_fs::linkat(
                &directory,
                temp.as_str(),
                &directory,
                name.as_str(),
                AtFlags::empty(),
            )?;
            fd_fs::unlinkat(&directory, temp.as_str(), AtFlags::empty())?;
        }
        fd_fs::fsync(&directory)?;
    }
    tx.execute("UPDATE snapshots SET complete=1 WHERE id=?1", [id])?;
    tx.commit()?;
    Ok(
        json!({"id":id,"root":root,"branch":plan.branch,"heads":plan.heads,"files":plan.files.len(),"complete":true}),
    )
}

pub fn run(db: &mut Connection, legacy: bool, input: &Value) -> Result<Value> {
    match input["command"].as_str() {
        Some("snapshot.create") => create(db, legacy, input),
        Some("snapshot.recover") => recover(db, storage_cli::field(input, "snapshotId")?),
        Some("snapshot.list") => {
            let mut query =
                db.prepare_cached("SELECT id,root,complete FROM snapshots ORDER BY rowid")?;
            let items=query.query_map([],|row|Ok(json!({
                "id":row.get::<_,String>(0)?,"root":row.get::<_,String>(1)?,"complete":row.get::<_,i64>(2)?
            })))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(json!(items))
        }
        _ => Err("Unknown snapshot command".into()),
    }
}
