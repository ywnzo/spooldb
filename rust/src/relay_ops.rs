use crate::{Result, relay};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, time::Duration};

pub fn credential(id: &str, room: &str, role: &str) -> Result<Value> {
    if !relay::valid_room(id) || !relay::valid_room(room) || !matches!(role, "read" | "write") {
        return Err("Credential requires a valid principal, room and read or write access".into());
    }
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes)?;
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    Ok(json!({"token":token,"credential":{"id":id,"tokenHash":token_hash,"rooms":{room:role}}}))
}

pub fn backup(database: &Path, target: &Path) -> Result<Value> {
    let source = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.busy_timeout(Duration::from_secs(5))?;
    let target = std::path::absolute(target)?;
    let target_arg = target.to_str().ok_or("Backup path is not UTF-8")?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    drop(options.open(&target)?);
    let snapshot = (|| -> Result<Value> {
        source.execute("VACUUM INTO ?1", [target_arg])?;
        let copy = Connection::open_with_flags(&target, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut refs = copy.prepare("SELECT name,room,heads FROM shard_refs ORDER BY name")?;
        let mut rows = refs.query([])?;
        let mut heads = Vec::new();
        while let Some(row) = rows.next()? {
            heads.push(json!({
                "branch":row.get::<_, String>(0)?,"room":row.get::<_, String>(1)?,
                "heads":serde_json::from_str::<Value>(&row.get::<_, String>(2)?)?
            }));
        }
        fs::File::open(&target)?.sync_all()?;
        #[cfg(unix)]
        fs::File::open(target.parent().ok_or("Missing backup directory")?)?.sync_all()?;
        Ok(json!({"path":target,"heads":heads}))
    })();
    if snapshot.is_err() {
        let _ = fs::remove_file(target);
    }
    snapshot
}
