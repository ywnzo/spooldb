use crate::{Result, private_files, project_paths};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub(crate) fn metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn regular_json(path: &Path) -> Result<Option<Value>> {
    match metadata(path)? {
        Some(meta) if meta.is_file() => project_paths::optional_json(path),
        Some(_) => Err(format!("Expected a regular file at {}", path.display()).into()),
        None => Ok(None),
    }
}

pub(crate) fn uuid(name: &str) -> bool {
    name.len() == 36
        && name.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                matches!(byte, b'0'..=b'9' | b'a'..=b'f')
            }
        })
}

fn backup_time(path: &Path, name: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>> {
    let time = if let Some(meta) = regular_json(&path.join("backup.json"))? {
        if meta["managedBy"] != "SpoolDB"
            || meta["kind"] != "relay-update-backup"
            || meta["id"] != name
        {
            return Err("Unrecognized backup metadata".into());
        }
        DateTime::parse_from_rfc3339(meta["createdAt"].as_str().ok_or("Invalid backup date")?)?
            .with_timezone(&Utc)
    } else {
        let owners_path = path.join("owners.json");
        let owners = regular_json(&owners_path)?.ok_or("Unrecognized backup directory")?;
        let entries = owners.as_array().ok_or("Unrecognized ownership manifest")?;
        if !metadata(&path.join("data"))?.is_some_and(|data| data.is_dir())
            || entries
                .first()
                .and_then(|entry| entry.get(0))
                .and_then(Value::as_str)
                != Some("")
            || !entries.iter().all(|entry| {
                entry.as_array().is_some_and(|fields| {
                    fields.len() == 3
                        && fields[0]
                            .as_str()
                            .is_some_and(|path| path.split('/').all(|part| part != ".."))
                        && fields[1].is_u64()
                        && fields[2].is_u64()
                })
            })
        {
            return Err("Unrecognized ownership manifest".into());
        }
        DateTime::from(fs::symlink_metadata(owners_path)?.modified()?)
    };
    if time > now {
        return Err("Invalid backup date".into());
    }
    Ok(time)
}

fn prune(root: &Path, state: &Value, dry_run: bool, now: DateTime<Utc>) -> Result<Value> {
    let configured = &state["backupRetention"];
    let setting = |name: &str, default, limit| {
        configured
            .get(name)
            .map_or(Some(default), Value::as_u64)
            .filter(|value| (1..=limit).contains(value))
            .ok_or("Backup retention requires keep=1–100 and maxAgeDays=1–3650")
    };
    let keep = setting("keep", 3, 100)? as usize;
    let age = setting("maxAgeDays", 30, 3650)? as i64;
    let base = root.join("relay-backups");
    let mut protected = BTreeSet::new();
    for file in ["last-relay-update.json", "relay-update-journal.json"] {
        if let Some(reference) = regular_json(&root.join(file))? {
            let path = PathBuf::from(
                reference["backup"]
                    .as_str()
                    .ok_or("Invalid backup reference")?,
            );
            if path.parent() != Some(base.as_path()) {
                return Err(format!("Invalid backup reference in {file}").into());
            }
            protected.insert(path);
        }
    }
    let mut result = json!({"policy":{"keep":keep,"maxAgeDays":age},"dryRun":dry_run,
        "removed":[],"retained":[],"skipped":[],"errors":[]});
    let Some(folder) = metadata(&base)? else {
        return Ok(result);
    };
    if !folder.is_dir() {
        return Err("Backup storage must be a real directory".into());
    }
    let mut backups = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();
    let mut entries = fs::read_dir(&base)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !uuid(&name) || !entry.file_type()?.is_dir() {
            skipped.push(name);
            continue;
        }
        let path = entry.path();
        match backup_time(&path, &name, now) {
            Ok(time) => backups.push((time, name, path)),
            Err(error) => {
                errors.push(json!({"name":name,"error":error.to_string()}));
                skipped.push(name);
            }
        }
    }
    backups.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut removed = Vec::new();
    let mut retained = Vec::new();
    for (index, (time, name, path)) in backups.into_iter().enumerate() {
        let protect = protected.contains(&path);
        if protect || (index < keep && now - time <= chrono::Duration::days(age)) {
            retained.push(json!({"name":name,"protected":protect}));
        } else if !dry_run && let Err(error) = fs::remove_dir_all(path) {
            errors.push(json!({"name":name,"error":error.to_string()}));
        } else {
            removed.push(name);
        }
    }
    result["removed"] = json!(removed);
    result["retained"] = json!(retained);
    result["skipped"] = json!(skipped);
    result["errors"] = json!(errors);
    Ok(result)
}

pub fn maintain_backups(config: &Path, dry_run: bool) -> Result<Value> {
    let config = std::path::absolute(config)?;
    let root = config
        .parent()
        .ok_or("Missing relay configuration directory")?;
    if regular_json(&config)?.is_none_or(|config| config["managedBy"] != "SpoolDB") {
        return Err("Backup cleanup requires a managed container installation".into());
    }
    let path = root.join("relay-updates.json");
    let mut state = regular_json(&path)?.unwrap_or_else(|| json!({}));
    if !state.is_object() {
        return Err("Invalid relay update settings".into());
    }
    let now = DateTime::<Utc>::from(SystemTime::now());
    let mut result = prune(root, &state, dry_run, now)
        .unwrap_or_else(|error| json!({"errors":[{"error":error.to_string()}]}));
    if !dry_run {
        let mut report = result.clone();
        report["checkedAt"] = json!(now.to_rfc3339_opts(SecondsFormat::Millis, true));
        state["backupCleanup"] = report;
        if let Err(error) = private_files::save_atomic(&path, &state) {
            result["errors"]
                .as_array_mut()
                .expect("cleanup has error array")
                .push(json!({"error":format!("Could not record cleanup: {error}")}));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pruning_respects_rollback_references_and_dry_run() -> Result<()> {
        let root =
            std::env::temp_dir().join(format!("spool-retention-{}", private_files::random_id()?));
        private_files::private_dir(&root)?;
        let outcome = (|| -> Result<()> {
            let base = root.join("relay-backups");
            private_files::private_dir(&base)?;
            let old = base.join("00000000-0000-0000-0000-000000000001");
            let protected = base.join("00000000-0000-0000-0000-000000000002");
            for backup in [&old, &protected] {
                private_files::private_dir(backup)?;
                private_files::save(
                    &backup.join("backup.json"),
                    &json!({
                        "managedBy":"SpoolDB","kind":"relay-update-backup",
                        "id":backup.file_name().and_then(|name| name.to_str()),"createdAt":"2026-01-01T00:00:00Z"
                    }),
                )?;
            }
            let link = base.join("00000000-0000-0000-0000-000000000003");
            std::os::unix::fs::symlink(&protected, &link)?;
            let journal = root.join("relay-update-journal.json");
            let now = DateTime::parse_from_rfc3339("2026-05-01T00:00:00Z")?.with_timezone(&Utc);
            private_files::save(&journal, &json!({"backup":root.join("outside")}))?;
            assert!(prune(&root, &json!({}), false, now).is_err());
            assert!(old.is_dir());
            private_files::save_atomic(&journal, &json!({"backup":protected}))?;
            let state = json!({"backupRetention":{"keep":1,"maxAgeDays":30}});
            let preview = prune(&root, &state, true, now)?;
            assert_eq!(
                preview["removed"],
                json!([old.file_name().and_then(|name| name.to_str())])
            );
            assert_eq!(preview["retained"][0]["protected"], true);
            assert_eq!(
                preview["skipped"],
                json!([link.file_name().and_then(|name| name.to_str())])
            );
            assert!(old.is_dir());
            let applied = prune(&root, &state, false, now)?;
            assert_eq!(applied["removed"], preview["removed"]);
            assert!(!old.exists() && protected.is_dir() && link.is_symlink());
            Ok(())
        })();
        fs::remove_dir_all(root)?;
        outcome
    }
}
