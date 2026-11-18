pub(crate) use crate::private_files::{private_dir, random_id, save, write_private};
use crate::{Result, memory_index, project_binding, relay_ops, shards};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{Value, json};
use std::{fs, io::ErrorKind, path::Path};

fn read_registry(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(data) if data.len() <= 4_000_000 => Ok(Some(data)),
        Ok(_) => Err("Project registry exceeds byte limit".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn initialize(cwd: &Path) -> Result<Value> {
    let root = project_binding::repository_root(cwd)?;
    let state = std::path::absolute(project_binding::state_root()?)?;
    if state.starts_with(&root) || root.starts_with(&state) {
        return Err("Choose a Git repository outside SpoolDB state".into());
    }
    fs::create_dir_all(state.parent().ok_or("Invalid SpoolDB state path")?)?;
    if !state.exists() {
        match private_dir(&state) {
            Ok(()) => {}
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists) => {}
            Err(error) => return Err(error),
        }
    }
    let state = fs::canonicalize(&state)?;
    if state.starts_with(&root) || root.starts_with(&state) {
        return Err("Choose a Git repository outside SpoolDB state".into());
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("project-init.lock"))?;
    lock.lock()?;
    if let Ok(binding) = project_binding::resolve(&root) {
        return Ok(json!({"project":binding.info(),"existing":true}));
    }
    project_binding::allow_local_init(&state, &root)?;
    let primary = if state.join("project.json").is_file() {
        state.clone()
    } else {
        state.join("p")
    };
    let first = !primary.join("project.json").try_exists()?;
    if first && primary.try_exists()? {
        return Err("The existing project directory is missing its configuration".into());
    }
    let room = random_id()?;
    let registry_path = primary.join("projects.json");
    let mut registry = None;
    let destination = if first {
        primary.clone()
    } else {
        let primary = fs::canonicalize(&primary)?;
        if !primary.starts_with(&state) {
            return Err("Project data is outside SpoolDB state".into());
        }
        let primary_config: Value =
            serde_json::from_slice(&fs::read(primary.join("project.json"))?)?;
        let first_root = primary_config["root"]
            .as_str()
            .ok_or("Primary root is missing")?;
        let first_id = primary_config["room"]
            .as_str()
            .ok_or("Primary project ID is missing")?;
        let name = Path::new(first_root)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(first_id);
        if fs::canonicalize(first_root).is_ok_and(|path| path == root) {
            return Err(
                "Repair the existing project binding before initializing this repository".into(),
            );
        }
        let original = read_registry(&registry_path)?;
        let mut value: Value = match &original {
            Some(data) => serde_json::from_slice(data)?,
            None => json!({"projects":[]}),
        };
        let projects = value["projects"]
            .as_array_mut()
            .ok_or("Invalid SpoolDB project registry")?;
        if projects.iter().any(|project| {
            project["root"]
                .as_str()
                .is_some_and(|path| fs::canonicalize(path).is_ok_and(|path| path == root))
        }) {
            return Err(
                "Repair the existing project binding before initializing this repository".into(),
            );
        }
        if !projects.iter().any(|project| project["id"] == first_id) {
            projects.insert(
                0,
                json!({"id":first_id,"root":first_root,"name":name,"dir":primary}),
            );
        }
        let container = primary.join("projects");
        if !container.try_exists()? {
            private_dir(&container)?;
        }
        let container = fs::canonicalize(container)?;
        if !container.starts_with(&primary) {
            return Err("Project directory is outside SpoolDB state".into());
        }
        let target = container.join(&room);
        projects.push(json!({"id":room,"root":root,"name":root.file_name(),"dir":target}));
        registry = Some((original, value));
        target
    };
    let staging = state.join(format!(".project-init-{room}"));
    private_dir(&staging)?;
    let result = (|| -> Result<()> {
        let writer = relay_ops::credential("capture", &room, "write")?;
        let reader = relay_ops::credential("review", &room, "read")?;
        save(
            &staging.join("project.json"),
            &json!({"version":1,"root":root,"room":room,
            "exclude":[],"captureFiles":false,"credentials":[writer["credential"],reader["credential"]]}),
        )?;
        save(
            &staging.join("tokens.json"),
            &json!({"writer":writer["token"],"reader":reader["token"]}),
        )?;
        let mut db = Connection::open(staging.join("capture.sqlite"))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(include_str!("../shared/shard_schema.sql"))?;
        shards::create_room(&tx, &room, "working")?;
        tx.execute(
            "INSERT INTO shard_refs(name,room,heads,root)
            SELECT 'main',room,heads,root FROM shard_refs WHERE name='working'",
            [],
        )?;
        tx.commit()?;
        let mut db = Connection::open(staging.join("relay.sqlite"))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(include_str!("../shared/shard_schema.sql"))?;
        tx.execute_batch(memory_index::SCHEMA)?;
        shards::create_room(&tx, &room, &format!("relay-{room}"))?;
        tx.commit()?;
        drop(db);
        if destination.try_exists()? {
            return Err("Project destination already exists".into());
        }
        fs::rename(&staging, &destination)?;
        if let Some((original, registry)) = registry {
            let candidate = primary.join(format!(".projects-{room}.json"));
            let registered = (|| -> Result<()> {
                save(&candidate, &registry)?;
                if read_registry(&registry_path)? != original {
                    return Err(
                        "Project registry changed concurrently; retry initialization".into(),
                    );
                }
                fs::rename(&candidate, &registry_path)?;
                Ok(())
            })();
            if registered.is_err() {
                let _ = fs::remove_file(candidate);
                let _ = fs::remove_dir_all(&destination);
            }
            registered?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result?;
    Ok(
        json!({"project":{"root":root,"room":room,"projectId":room,"mode":"local"},"existing":false}),
    )
}
