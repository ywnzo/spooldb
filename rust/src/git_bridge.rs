use crate::{Result, private_files, storage_cli, storage_submit};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{OptionalExtension, Transaction, params};
use rustix::fs::{self as fd_fs, AtFlags, FileType, Mode, OFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::to_raw_value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Read,
    os::{
        fd::{AsFd, OwnedFd},
        unix::fs::MetadataExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS sources(root TEXT PRIMARY KEY, branch TEXT NOT NULL, disk_branch TEXT NOT NULL, git_commit TEXT);
    CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, plan TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS source_exclusions(root TEXT PRIMARY KEY, paths TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_scans(root TEXT PRIMARY KEY, signature TEXT NOT NULL, disk_heads TEXT NOT NULL);
";
const MAX_FILE_BYTES: usize = 1_000_000;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Entry {
    pub(crate) kind: String,
    pub(crate) mode: u32,
    pub(crate) text: String,
    pub(crate) data: String,
    pub(crate) target: String,
}

fn git(root: &Path, args: &[&str]) -> Result<String> {
    const LIMIT: usize = 16_000_000;
    let mut child = Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
        ])
        .arg(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()?;
    let output = child
        .stdout
        .take()
        .ok_or("Git output stream is unavailable")?;
    let reader = thread::spawn(move || {
        let mut result = Vec::new();
        output.take((LIMIT + 1) as u64).read_to_end(&mut result)?;
        Ok::<_, std::io::Error>(result)
    });
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Git scan timed out".into());
        }
        thread::sleep(Duration::from_millis(5));
    };
    let bytes = reader.join().map_err(|_| "Git output reader failed")??;
    if bytes.len() > LIMIT {
        return Err("Git scan output exceeds limit".into());
    }
    if !status.success() {
        return Err("Git could not scan the checkout".into());
    }
    Ok(String::from_utf8(bytes)?)
}

pub(crate) fn safe_path(name: &str) -> Result<()> {
    storage_submit::path(&json!({"path":name}))?;
    if name
        .split('/')
        .any(|part| part.to_ascii_lowercase().starts_with(".spool"))
    {
        return Err("Reserved bridge path".into());
    }
    Ok(())
}

pub(crate) fn open_directory(path: &Path) -> Result<OwnedFd> {
    Ok(fd_fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?)
}

pub(crate) fn parent(
    root: &impl AsFd,
    name: &str,
    create: bool,
) -> Result<Option<(OwnedFd, String)>> {
    safe_path(name)?;
    let mut pieces = name.rsplitn(2, '/');
    let filename = pieces.next().ok_or("Invalid file path")?.to_owned();
    let mut current = fd_fs::openat(
        root,
        ".",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    for part in pieces.next().into_iter().flat_map(|dir| dir.split('/')) {
        let open = || {
            fd_fs::openat(
                &current,
                part,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
        };
        current = match open() {
            Ok(value) => value,
            Err(rustix::io::Errno::NOENT) if create => {
                match fd_fs::mkdirat(&current, part, Mode::from_bits_truncate(0o700)) {
                    Ok(()) => fd_fs::fsync(&current)?,
                    Err(rustix::io::Errno::EXIST) => {}
                    Err(error) => return Err(error.into()),
                }
                open()?
            }
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(_) => return Err(format!("Unsafe parent: {name}").into()),
        };
    }
    Ok(Some((current, filename)))
}

pub(crate) fn read_entry(parent: &impl AsFd, name: &str) -> Result<Option<Entry>> {
    let expected = match fd_fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => stat,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mode = if expected.st_mode & 0o111 != 0 {
        493
    } else {
        420
    };
    let mut entry = Entry {
        kind: "text".into(),
        mode,
        text: String::new(),
        data: String::new(),
        target: String::new(),
    };
    match FileType::from_raw_mode(expected.st_mode) {
        FileType::Symlink => {
            let target = fd_fs::readlinkat(parent, name, Vec::new())?;
            entry.target = target.into_string()?;
            if entry.target.is_empty() || entry.target.encode_utf16().count() > 4096 {
                return Err(format!("Invalid symlink target: {name}").into());
            }
            entry.kind = "symlink".into();
            entry.mode = 420;
        }
        FileType::RegularFile => {
            if expected.st_size < 0 || expected.st_size as u64 > MAX_FILE_BYTES as u64 {
                return Err(format!("File exceeds 1 MB: {name}").into());
            }
            let mut file = File::from(fd_fs::openat(
                parent,
                name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )?);
            let before = file.metadata()?;
            if !before.is_file()
                || before.ino() != expected.st_ino as u64
                || before.dev() != expected.st_dev as u64
            {
                return Err(format!("File changed during scan: {name}").into());
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take((MAX_FILE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            let after = file.metadata()?;
            if bytes.len() > MAX_FILE_BYTES
                || before.len() != after.len()
                || before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
            {
                return Err(format!("File changed during scan: {name}").into());
            }
            match String::from_utf8(bytes) {
                Ok(text) if !text.contains('\0') => entry.text = text,
                Ok(text) => {
                    entry.kind = "binary".into();
                    entry.data = STANDARD.encode(text.as_bytes());
                }
                Err(error) => {
                    entry.kind = "binary".into();
                    entry.data = STANDARD.encode(error.as_bytes());
                }
            }
        }
        _ => return Err(format!("Unsupported filesystem entry: {name}").into()),
    }
    Ok(Some(entry))
}

fn secret_path(name: &str) -> bool {
    let file = name
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    ((file == ".env" || file.starts_with(".env."))
        && ![".example", ".sample", ".template"]
            .iter()
            .any(|suffix| file.ends_with(suffix)))
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|suffix| file.ends_with(suffix))
        || matches!(file.as_str(), "id_rsa" | "id_ed25519")
}

fn contains_path(parent: &str, name: &str) -> bool {
    name == parent
        || name
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

struct Scan {
    root: PathBuf,
    entries: BTreeMap<String, Entry>,
    excluded: Vec<Value>,
    commit: Option<String>,
}

fn scan(tx: &Transaction<'_>, database: &Path, root: &Path) -> Result<Scan> {
    let root = fs::canonicalize(root)?;
    let fd = open_directory(&root)?;
    let canonical_git = fs::canonicalize(git(&root, &["rev-parse", "--show-toplevel"])?.trim())?;
    if canonical_git != root {
        return Err("Choose the top-level Git checkout".into());
    }
    let exclusions: Vec<String> = tx
        .query_row(
            "SELECT paths FROM source_exclusions WHERE root=?1",
            [root.to_str().ok_or("Invalid checkout path")?],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|raw| serde_json::from_str(&raw))
        .transpose()?
        .unwrap_or_default();
    let stage = git(&root, &["ls-files", "--stage", "-z"])?;
    let mut submodules = BTreeSet::new();
    for line in stage.split('\0').filter(|line| !line.is_empty()) {
        let (spec, name) = line.split_once('\t').ok_or("Invalid Git index entry")?;
        let fields: Vec<_> = spec.split(' ').collect();
        if fields.len() != 3 || fields[2] != "0" {
            return Err("Resolve Git index conflicts before capturing".into());
        }
        if fields[0] == "160000" {
            submodules.insert(name);
        }
    }
    let listed = git(
        &root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    let paths: Vec<_> = listed.split('\0').filter(|name| !name.is_empty()).collect();
    if paths.len() > 10_000 {
        return Err("Checkout exceeds 10000 listed paths".into());
    }
    let database = if database == Path::new(":memory:") {
        None
    } else {
        Some(fs::canonicalize(database)?)
    };
    let live_database = database.as_ref().map(|path| {
        [
            path.clone(),
            PathBuf::from(format!("{}-wal", path.display())),
            PathBuf::from(format!("{}-shm", path.display())),
        ]
    });
    let mut result = Scan {
        root,
        entries: BTreeMap::new(),
        excluded: Vec::new(),
        commit: None,
    };
    let mut bytes = 2;
    for name in paths.into_iter().collect::<BTreeSet<_>>() {
        let reason = if submodules.iter().any(|parent| contains_path(parent, name)) {
            Some("git-submodule-reference")
        } else if exclusions.iter().any(|parent| contains_path(parent, name)) {
            Some("configured-exclusion")
        } else if secret_path(name)
            || name
                .split('/')
                .any(|part| part.to_ascii_lowercase().starts_with(".spool"))
            || live_database
                .as_ref()
                .is_some_and(|paths| paths.contains(&result.root.join(name)))
        {
            Some("local-state-or-secret-pattern")
        } else {
            None
        };
        if let Some(reason) = reason {
            result.excluded.push(json!({"path":name,"reason":reason}));
        } else if let Some((dir, file)) = parent(&fd, name, false)?
            && let Some(entry) = read_entry(&dir, &file)?
        {
            bytes += serde_json::to_vec(name)?.len() + serde_json::to_vec(&entry)?.len() + 2;
            if bytes > 12_000_000 {
                return Err("Checkout snapshot exceeds 12 MB".into());
            }
            result.entries.insert(name.to_owned(), entry);
        }
    }
    result.commit = git(&result.root, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .map(|value| value.trim().to_owned());
    Ok(result)
}

pub(crate) fn storage(tx: &Transaction<'_>, legacy: bool, request: Value) -> Result<Value> {
    let raw = request.get("input").map(to_raw_value).transpose()?;
    storage_cli::execute_layout(tx, legacy, &request, raw.as_deref())
}

fn sources(tx: &Transaction<'_>) -> Result<Value> {
    let mut query =
        tx.prepare_cached("SELECT root,branch,disk_branch,git_commit FROM sources ORDER BY root")?;
    let rows=query.query_map([],|row|Ok(json!({
        "root":row.get::<_,String>(0)?,"branch":row.get::<_,String>(1)?,"diskBranch":row.get::<_,String>(2)?,
        "gitCommit":row.get::<_,Option<String>>(3)?
    })))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!(rows))
}

fn operations(entries: &BTreeMap<String, Entry>, state: &Value) -> Result<Vec<Value>> {
    let mut live = BTreeMap::new();
    for file in state["files"]
        .as_array()
        .ok_or("Invalid branch files")?
        .iter()
        .filter(|file| file["deleted"] != true)
    {
        let name = storage_cli::field(file, "path")?;
        let id = storage_cli::field(file, "fileId")?;
        let entry: Entry = serde_json::from_value(file.clone())?;
        live.insert(name, (id, entry));
    }
    let mut removed_by_content: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for (path, (id, entry)) in live
        .iter()
        .filter(|(path, _)| !entries.contains_key(**path))
    {
        removed_by_content
            .entry(entry)
            .or_default()
            .push((*path, *id));
    }
    let mut added_counts = BTreeMap::new();
    for (_, entry) in entries
        .iter()
        .filter(|(path, _)| !live.contains_key(path.as_str()))
    {
        *added_counts.entry(entry).or_insert(0) += 1;
    }
    let mut renamed = BTreeMap::new();
    let mut renamed_ids = BTreeSet::new();
    for (path, entry) in entries
        .iter()
        .filter(|(path, _)| !live.contains_key(path.as_str()))
    {
        if let Some(candidates) = removed_by_content.get(entry)
            && candidates.len() == 1
            && added_counts.get(entry) == Some(&1)
        {
            renamed.insert(path, candidates[0].1);
            renamed_ids.insert(candidates[0].1);
        }
    }
    let mut result = Vec::new();
    for (_, (id, _)) in live
        .iter()
        .filter(|(path, (id, _))| !entries.contains_key(**path) && !renamed_ids.contains(id))
    {
        result.push(json!({"type":"file.delete","fileId":id}));
    }
    for (path, entry) in entries {
        if let Some(id) = renamed.get(path) {
            result.push(json!({"type":"file.rename","fileId":id,"path":path}));
            continue;
        }
        let mut payload = serde_json::to_value(entry)?;
        if let Some((id, previous)) = live.get(path.as_str()) {
            if previous == entry {
                continue;
            }
            payload["type"] = json!("file.write");
            payload["fileId"] = json!(id);
        } else {
            payload["type"] = json!("file.create");
            payload["fileId"] = json!(private_files::random_id()?);
            payload["path"] = json!(path);
        }
        result.push(payload);
    }
    Ok(result)
}

pub fn run(tx: &Transaction<'_>, legacy: bool, database: &Path, input: &Value) -> Result<Value> {
    let command = storage_cli::field(input, "command")?;
    if command == "git.sources" {
        return sources(tx);
    }
    let scan = scan(tx, database, Path::new(storage_cli::field(input, "root")?))?;
    let root = scan.root.to_str().ok_or("Invalid checkout path")?;
    let known = tx
        .query_row(
            "SELECT branch,disk_branch FROM sources WHERE root=?1",
            [root],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let (branch, disk) = if command == "git.attach" {
        if known.is_some() {
            return Err("Checkout already attached".into());
        }
        let branch = input["branch"].as_str().unwrap_or("main");
        let refs = storage(tx, legacy, json!({"command":"refs"}))?;
        if !refs
            .as_array()
            .ok_or("Invalid branch list")?
            .iter()
            .any(|entry| entry["branch"] == branch)
        {
            storage(tx, legacy, json!({"command":"init","branch":branch}))?;
        }
        let state = storage(tx, legacy, json!({"command":"read","branch":branch}))?;
        if state["files"]
            .as_array()
            .is_none_or(|files| !files.is_empty())
        {
            return Err("Initial Git import requires an empty branch".into());
        }
        let disk = format!("disk-{}", private_files::random_id()?);
        storage(
            tx,
            legacy,
            json!({"command":"fork","source":branch,"target":disk}),
        )?;
        tx.execute(
            "INSERT INTO sources(root,branch,disk_branch,git_commit) VALUES(?1,?2,?3,?4)",
            params![root, branch, disk, scan.commit],
        )?;
        (branch.to_owned(), disk)
    } else {
        known.ok_or("Checkout is not attached")?
    };
    let signature = format!("{:x}", Sha256::digest(serde_json::to_vec(&scan.entries)?));
    let refs = storage(tx, legacy, json!({"command":"refs"}))?;
    let refs = refs.as_array().ok_or("Invalid branch list")?;
    let heads = |name: &str| -> Result<Value> {
        Ok(refs
            .iter()
            .find(|entry| entry["branch"] == name)
            .ok_or("Unknown branch")?["heads"]
            .clone())
    };
    let disk_heads = heads(&disk)?;
    let mut target_heads = heads(&branch)?;
    let saved = tx
        .query_row(
            "SELECT signature,disk_heads FROM source_scans WHERE root=?1",
            [root],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let count = if saved.as_ref().is_some_and(|(previous, prior_heads)| {
        previous == &signature && prior_heads == &disk_heads.to_string()
    }) {
        0
    } else {
        let state = storage(tx, legacy, json!({"command":"read","branch":disk}))?;
        let edits = operations(&scan.entries, &state)?;
        let count = edits.len();
        let mut disk_updated = disk_heads;
        if count > 0 {
            let mut request = json!({"actor":"unknown","harness":"filesystem","evidence":"observed-disk-snapshot",
                "requestId":private_files::random_id()?,"expectedHeads":disk_updated,"operations":edits});
            for key in [
                "sessionId",
                "turnId",
                "toolCallId",
                "messageId",
                "observedAfter",
            ] {
                if let Some(value) = input["context"].get(key) {
                    request[key] = value.clone();
                }
            }
            if let Some(commit) = &scan.commit {
                request["gitCommit"] = json!(commit);
            }
            let result = storage(
                tx,
                legacy,
                json!({"command":"submit","branch":disk,"input":request}),
            )?;
            disk_updated = result["heads"].clone();
            target_heads = storage(
                tx,
                legacy,
                json!({"command":"merge","target":branch,"source":disk}),
            )?["heads"]
                .clone();
        }
        tx.execute("INSERT INTO source_scans(root,signature,disk_heads) VALUES(?1,?2,?3)
            ON CONFLICT(root) DO UPDATE SET signature=excluded.signature,disk_heads=excluded.disk_heads",
            params![root,signature,disk_updated.to_string()])?;
        count
    };
    tx.execute(
        "UPDATE sources SET git_commit=?2 WHERE root=?1",
        params![root, scan.commit],
    )?;
    Ok(
        json!({"branch":branch,"heads":target_heads,"diskBranch":disk,"operations":count,
        "files":scan.entries.len(),"gitCommit":scan.commit,"excluded":scan.excluded}),
    )
}
