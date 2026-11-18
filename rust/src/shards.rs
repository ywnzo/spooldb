use crate::{Result, manifest};
use rusqlite::{Transaction, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub fn create_room(db: &Transaction<'_>, room: &str, branch: &str) -> Result<Value> {
    validate_id(room, "room")?;
    validate_id(branch, "branch")?;

    db.execute(
        "INSERT INTO shard_refs(name,room,heads,root) VALUES(?1,?2,'[]',NULL)",
        params![branch, room],
    )?;
    publish_batch(db, room, branch, &[], None, Value::Null, Vec::new())
}

pub fn publish_batch(
    db: &Transaction<'_>,
    room: &str,
    branch: &str,
    parents: &[String],
    mut root: Option<String>,
    metadata: Value,
    updates: Vec<(String, Vec<String>)>,
) -> Result<Value> {
    for (key, heads) in &updates {
        root = manifest::set(db, root.as_deref(), key, Some(json!({"heads": heads})))?;
    }
    publish_rooted_batch(db, room, branch, parents, root, metadata, updates)
}

pub(crate) fn publish_rooted_batch(
    db: &Transaction<'_>,
    room: &str,
    branch: &str,
    parents: &[String],
    root: Option<String>,
    metadata: Value,
    updates: Vec<(String, Vec<String>)>,
) -> Result<Value> {
    let batch = json!({
        "schema": 2, "room": room, "parents": parents, "root": root,
        "metadata": metadata, "updates": updates,
    });
    let body = serde_json::to_string(&batch)?;
    let heads = vec![format!("{:x}", Sha256::digest(body.as_bytes()))];
    let frontier = serde_json::to_string(&heads)?;

    db.execute(
        "UPDATE shard_refs SET heads=?3,root=?4 WHERE name=?1 AND room=?2",
        params![branch, room, frontier, root],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO shard_batches(room,id,parents,root,body)
         VALUES(?1,?2,?3,?4,?5)",
        params![
            room,
            heads[0],
            serde_json::to_string(parents)?,
            root,
            manifest::encode(&body)?
        ],
    )?;
    for id in metadata["fileIds"].as_array().into_iter().flatten() {
        let id = id.as_str().ok_or("Invalid batch file ID")?;
        db.execute(
            "INSERT OR IGNORE INTO shard_batch_files(room,file_id,batch) VALUES(?1,?2,?3)",
            params![room, id, heads[0]],
        )?;
    }
    db.execute(
        "INSERT OR IGNORE INTO shard_versions(room,frontier,root) VALUES(?1,?2,?3)",
        params![room, frontier, root],
    )?;
    Ok(json!({"branch": branch, "room": room, "heads": heads}))
}

pub(crate) fn validate_id(value: &str, label: &str) -> Result<()> {
    if value.len() <= 200
        && let Some((first, rest)) = value.as_bytes().split_first()
        && first.is_ascii_alphanumeric()
        && rest
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        Ok(())
    } else {
        Err(format!("Invalid {label}").into())
    }
}

pub fn append_message(
    db: &Transaction<'_>,
    room: &str,
    branch: &str,
    input: &Value,
) -> Result<Value> {
    let id = input["messageId"].as_str().ok_or("Invalid message ID")?;
    validate_id(id, "messageId")?;
    let role = input["role"]
        .as_str()
        .filter(|role| matches!(*role, "user" | "assistant" | "tool" | "system"))
        .ok_or("Invalid message role")?;
    let text = input["text"]
        .as_str()
        .filter(|text| text.encode_utf16().count() <= 1_000_000)
        .ok_or("Invalid message text")?;
    let actor = input["actor"].as_str().ok_or("Invalid actor")?;
    validate_id(actor, "actor")?;

    let (heads, root): (String, Option<String>) = db.query_row(
        "SELECT heads,root FROM shard_refs WHERE name=?1 AND room=?2",
        params![branch, room],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let parents: Vec<String> = serde_json::from_str(&heads)?;
    let mut expected: Vec<String> = serde_json::from_value(input["expectedHeads"].clone())?;
    expected.sort_unstable();
    if parents != expected {
        return Err("Stale heads; read again before writing".into());
    }
    let key = format!("m:{id}");
    if !manifest::lookup_root(db, root.clone(), &key)?.is_null() {
        return Err("Message ID already exists".into());
    }
    let (event, observed_at) = observation(db)?;
    let frontier = crate::documents::insert_message(db, room, id, role, text, &event)?;
    let mut metadata = json!({
        "eventId": event, "actor": actor, "harness": "generic",
        "observedAt": observed_at, "operationTypes": ["message.add"],
        "fileIds": [], "messageIds": [id],
    });
    for field in [
        "harness",
        "sessionId",
        "evidence",
        "turnId",
        "provenanceMessageId",
        "sourceEventId",
    ] {
        if let Some(value) = input.get(field) {
            let value = value
                .as_str()
                .filter(|value| value.encode_utf16().count() <= 200)
                .ok_or("Invalid message provenance")?;
            metadata[if field == "provenanceMessageId" {
                "messageId"
            } else {
                field
            }] = json!(value);
        }
    }
    let mut result = publish_batch(
        db,
        room,
        branch,
        &parents,
        root,
        metadata,
        vec![(key, frontier)],
    )?;
    result["eventId"] = json!(event);
    Ok(result)
}

pub fn observation(db: &Transaction<'_>) -> rusqlite::Result<(String, String)> {
    db.query_row(
        "SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) ||
          '-4' || substr(lower(hex(randomblob(2))),2) || '-8' ||
          substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
          strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}
