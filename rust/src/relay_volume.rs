use crate::{Result, private_files};
use std::{
    collections::BTreeMap,
    fs,
    io::{ErrorKind, Read},
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt, lchown, symlink},
    path::{Component, Path, PathBuf},
};

const GATE: &str = ".spool-update-gate";
type Owners = BTreeMap<PathBuf, (u32, u32)>;

fn tree(root: &Path, path: &Path, keep_models: bool, entries: &mut Owners) -> Result<()> {
    let full = root.join(path);
    let meta = fs::symlink_metadata(&full)?;
    let kind = meta.file_type();
    if kind.is_socket() {
        return Ok(());
    }
    if !kind.is_file() && !kind.is_dir() && !kind.is_symlink() {
        return Err("Unexpected special file in relay volume".into());
    }
    entries.insert(path.to_path_buf(), (meta.uid(), meta.gid()));
    if kind.is_dir() {
        for item in fs::read_dir(full)? {
            let item = item?;
            if keep_models && path.as_os_str().is_empty() && item.file_name() == "models" {
                continue;
            }
            tree(root, &path.join(item.file_name()), keep_models, entries)?;
        }
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

fn copy_entries(source: &Path, destination: &Path, owners: &Owners, restore: bool) -> Result<()> {
    for (relative, (uid, gid)) in owners {
        let from = source.join(relative);
        let to = destination.join(relative);
        let metadata = fs::symlink_metadata(&from)?;
        if metadata.is_dir() {
            if !relative.as_os_str().is_empty() {
                fs::create_dir(&to)?;
            }
        } else if metadata.is_symlink() {
            symlink(fs::read_link(&from)?, &to)?;
        } else {
            fs::copy(&from, &to)?;
            fs::File::open(&to)?.sync_all()?;
        }
        if restore {
            lchown(&to, Some(*uid), Some(*gid))?;
        }
        if !metadata.is_symlink() {
            fs::set_permissions(&to, fs::Permissions::from_mode(metadata.mode() & 0o7777))?;
        }
    }
    for path in owners.keys().rev() {
        let dir = destination.join(path);
        if fs::symlink_metadata(&dir)?.is_dir() {
            sync_directory(&dir)?;
        }
    }
    Ok(())
}

fn read_owners(backup: &Path) -> Result<Owners> {
    let mut data = Vec::new();
    fs::File::open(backup.join("owners.json"))?
        .take(16_000_001)
        .read_to_end(&mut data)?;
    if data.len() > 16_000_000 {
        return Err("Relay volume ownership data exceeds limit".into());
    }
    let rows: Vec<(String, u32, u32)> = serde_json::from_slice(&data)?;
    let mut result = Owners::new();
    for (key, uid, gid) in rows {
        let path = Path::new(key.trim_start_matches('/'));
        if path
            .components()
            .any(|piece| !matches!(piece, Component::Normal(_)))
            || path.starts_with("models")
        {
            return Err("Invalid backup ownership path".into());
        }
        if result.insert(path.to_owned(), (uid, gid)).is_some() {
            return Err("Duplicate backup ownership path".into());
        }
    }
    Ok(result)
}

fn snapshot(data: &Path, backup: &Path) -> Result<()> {
    let saved = backup.join("data");
    let owners_file = backup.join("owners.json");
    if saved.try_exists()? || owners_file.try_exists()? {
        return Err("A relay backup already exists at this location".into());
    }
    let mut owners = Owners::new();
    tree(data, Path::new(""), true, &mut owners)?;
    let staged = backup.join(format!(".snapshot-{}", private_files::random_id()?));
    private_files::private_dir(&staged)?;
    let result = (|| -> Result<()> {
        copy_entries(data, &staged, &owners, false)?;
        fs::rename(&staged, &saved)?;
        let rows = owners
            .iter()
            .map(|(relative, (uid, gid))| -> Result<_> {
                let name = relative.to_str().ok_or("Non-UTF-8 relay storage path")?;
                Ok((
                    if name.is_empty() {
                        String::new()
                    } else {
                        format!("/{name}")
                    },
                    *uid,
                    *gid,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        private_files::save_atomic(&owners_file, &serde_json::to_value(rows)?)?;
        sync_directory(backup)?;
        private_files::write_private(&data.join(GATE), b"1")?;
        sync_directory(data)?;
        Ok(())
    })();
    if staged.is_dir() {
        let _ = fs::remove_dir_all(staged);
    }
    result
}

fn restore(data: &Path, backup: &Path) -> Result<()> {
    let source = backup.join("data");
    let metadata = fs::symlink_metadata(&source)?;
    if !metadata.is_dir() {
        return Err("Invalid relay backup directory".into());
    }
    let owners = read_owners(backup)?;
    let mut actual = Owners::new();
    tree(&source, Path::new(""), false, &mut actual)?;
    if owners.keys().ne(actual.keys()) {
        return Err("Relay backup contents differ from its ownership manifest".into());
    }
    for item in fs::read_dir(data)? {
        let item = item?;
        if item.file_name() == "models" {
            continue;
        }
        if item.file_type()?.is_dir() {
            fs::remove_dir_all(item.path())?;
        } else {
            fs::remove_file(item.path())?;
        }
    }
    copy_entries(&source, data, &owners, true)
}

pub fn run(action: &str, data: &Path, backup: &Path) -> Result<()> {
    if !fs::symlink_metadata(data)?.is_dir() || !fs::symlink_metadata(backup)?.is_dir() {
        return Err("Relay data and backup paths must be directories".into());
    }
    let data = fs::canonicalize(data)?;
    let backup = fs::canonicalize(backup)?;
    if data.starts_with(&backup) || backup.starts_with(&data) {
        return Err("Relay data and backup directories must be separate".into());
    }
    match action {
        "snapshot" => snapshot(&data, &backup),
        "restore" => restore(&data, &backup),
        "commit" => match fs::remove_file(data.join(GATE)) {
            Ok(()) => sync_directory(&data),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        },
        _ => Err("Choose volume snapshot, restore, or commit".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_restores_memory_and_preserves_the_model_cache() -> Result<()> {
        let root =
            std::env::temp_dir().join(format!("spool-volume-{}", private_files::random_id()?));
        private_files::private_dir(&root)?;
        let result = (|| -> Result<()> {
            let data = root.join("volume");
            let backup = root.join("backup");
            for path in [&data, &backup, &data.join("models"), &data.join("nested")] {
                private_files::private_dir(path)?;
            }
            fs::write(data.join("shared.sqlite"), "original")?;
            fs::write(data.join("nested").join("setting"), "saved")?;
            fs::set_permissions(
                data.join("nested").join("setting"),
                fs::Permissions::from_mode(0o640),
            )?;
            symlink("shared.sqlite", data.join("shortcut"))?;
            fs::write(data.join("models").join("model"), "cached")?;
            run("snapshot", &data, &backup)?;
            assert!(data.join(GATE).exists());
            assert!(!backup.join("data/models").exists());
            assert!(read_owners(&backup)?.contains_key(Path::new("nested/setting")));
            fs::write(data.join("shared.sqlite"), "candidate")?;
            fs::write(data.join("candidate-only"), "new")?;
            fs::write(data.join("models").join("model"), "new cache")?;
            run("restore", &data, &backup)?;
            assert_eq!(fs::read_to_string(data.join("shared.sqlite"))?, "original");
            assert_eq!(
                fs::read_to_string(data.join("models").join("model"))?,
                "new cache"
            );
            assert_eq!(
                fs::read_link(data.join("shortcut"))?,
                Path::new("shared.sqlite")
            );
            assert_eq!(
                fs::metadata(data.join("nested").join("setting"))?.mode() & 0o777,
                0o640
            );
            assert!(!data.join("candidate-only").exists());
            assert!(!data.join(GATE).exists());
            run("commit", &data, &backup)?;
            fs::write(backup.join("owners.json"), b"[[\"/../unrelated\",0,0]]")?;
            assert!(run("restore", &data, &backup).is_err());
            assert_eq!(fs::read_to_string(data.join("shared.sqlite"))?, "original");
            Ok(())
        })();
        let _ = fs::remove_dir_all(root);
        result
    }
}
