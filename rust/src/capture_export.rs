use crate::{
    Result, documents, manifest, memory_index, memory_record,
    relay_client::{Client, ConnectionOptions},
};
use automerge::AutoSerde;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

pub(crate) fn private_key(grant: &ConnectionOptions) -> String {
    hash(&json!(["private-memory-v1", grant.url, grant.room]))
}

fn record(
    tx: &Transaction<'_>,
    room: &str,
    key: &str,
    descriptor: &Value,
) -> Result<(Value, &'static str, bool)> {
    let heads = serde_json::from_value::<Vec<String>>(descriptor["heads"].clone())?;
    let doc = documents::load(tx, room, key, &heads)?;
    let data = serde_json::to_value(AutoSerde::from(&doc))?;
    let id = key.strip_prefix("m:").ok_or("Invalid message key")?;
    let item = &data["messages"][id];
    let role = item["role"].as_str().ok_or("Missing message role")?;
    let text = item["text"].as_str().ok_or("Missing message text")?;
    let mut category = "conversations";
    let mut excerpt = false;
    let mut shared_text = text.to_owned();
    if role == "system"
        && let Ok(mut event) = serde_json::from_str::<Value>(text)
        && memory_record::valid_event(&event)
    {
        category = match event["kind"].as_str() {
            Some("task") => "tasks",
            Some("handoff") => "handoffs",
            Some("decision") => "decisions",
            Some("finding" | "blocker") => "findings",
            _ => "conversations",
        };
        excerpt = event["text"].as_str().is_some_and(|text| {
            text.starts_with("Current request (source text, not verified findings):\n")
            || text.starts_with("Automatic lifecycle checkpoint; agent-authored next steps and verification were not supplied.")
        });
        if let Some(files) = event["files"].as_array_mut() {
            for file in files {
                if file.get("fileId").is_some() || file.get("heads").is_some() {
                    *file = json!({"path":file["path"],"legacySnapshotReference":true});
                }
            }
        }
        shared_text = event.to_string();
    }
    let mut value = json!({"kind":"message","id":id,"role":role,"text":shared_text});
    let meta: Option<String> = tx
        .query_row(
            "SELECT data FROM memory_provenance WHERE room=?1 AND event_id=?2",
            params![room, item["eventId"].as_str()],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(meta) = meta {
        let meta: Value = serde_json::from_str(&meta)?;
        if let Some(session) = meta["sessionId"].as_str() {
            let source = if meta["sourceEventId"]
                .as_str()
                .is_some_and(|value| value.starts_with("codex-history:"))
            {
                "codex-history"
            } else {
                "local-capture"
            };
            let mut provenance = json!({"sessionId":session,
                "harness":meta["harness"].as_str().unwrap_or("generic"),"source":source});
            for (target, source) in [("turnId", "turnId"), ("itemId", "messageId")] {
                if let Some(value) = meta[source].as_str() {
                    provenance[target] = json!(value);
                }
            }
            value["provenance"] = provenance;
        }
    }
    Ok((value, category, excerpt))
}

pub fn export(directory: &Path, room: &str, grant: &ConnectionOptions) -> Result<Value> {
    let client = Client::new(grant.clone())?;
    let state = client.request("state", None)?;
    let sharing = &state["sharing"];
    if [
        "conversations",
        "tasks",
        "handoffs",
        "findings",
        "decisions",
    ]
    .iter()
    .any(|key| !sharing[key].is_boolean())
    {
        return Err("Relay did not provide a complete sharing policy".into());
    }
    let mut db = Connection::open_with_flags(
        directory.join("relay.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS team_private(remote TEXT,id TEXT,PRIMARY KEY(remote,id));
        CREATE TABLE IF NOT EXISTS team_export(remote TEXT,id TEXT,fingerprint TEXT,PRIMARY KEY(remote,id));")?;
    let private_key = private_key(grant);
    let export_key = hash(&json!([
        "memory-provenance-v2",
        grant.url,
        grant.room,
        grant.token
    ]));
    let mut sent = 0;
    let mut pages = 0;
    let mut retained = 0;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(memory_index::SCHEMA)?;
    let heads = memory_index::refresh(&tx, room)?;
    let root: Option<String> = tx.query_row(
        "SELECT root FROM shard_refs WHERE name=?1 AND room=?2",
        params![format!("relay-{room}"), room],
        |row| row.get(0),
    )?;
    let entries = manifest::entries(&tx, root)?;
    tx.commit()?;
    let mut offset = 0;
    while offset < entries.len() {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut records = Vec::new();
        let mut markers = Vec::new();
        let mut bytes = 0;
        while let Some((key, descriptor)) = entries.get(offset) {
            let fingerprint = hash(descriptor);
            offset += 1;
            if !key.starts_with("m:")
                || tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM team_private
                WHERE remote=?1 AND id=?3 UNION ALL SELECT 1 FROM team_export
                WHERE remote=?2 AND id=?3 AND fingerprint=?4)",
                    params![private_key, export_key, key, fingerprint],
                    |row| row.get::<_, bool>(0),
                )?
            {
                continue;
            }
            let (record, category, excerpt) = record(&tx, room, key, descriptor)?;
            if sharing[category] != true || (excerpt && sharing["conversations"] != true) {
                tx.execute(
                    "INSERT OR IGNORE INTO team_private VALUES(?1,?2)",
                    params![private_key, key],
                )?;
                retained += 1;
                continue;
            }
            let size = record.to_string().len();
            if !records.is_empty() && (records.len() == 50 || bytes + size > 1_500_000) {
                offset -= 1;
                break;
            }
            bytes += size;
            markers.push((key, fingerprint));
            records.push(record);
        }
        tx.commit()?;
        if records.is_empty() {
            continue;
        }
        let request_id = hash(&json!(records));
        let response = client.request(
            "source",
            Some(&json!({"records":records,"requestId":request_id})),
        )?;
        let accepted = response["accepted"]
            .as_u64()
            .ok_or("Invalid export receipt")?;
        let skipped = response["skipped"]
            .as_u64()
            .ok_or("Invalid export receipt")?;
        if accepted.checked_add(skipped) != Some(records.len() as u64) {
            return Err("Relay did not acknowledge every captured record".into());
        }
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (key, fingerprint) in markers {
            tx.execute(
                "INSERT INTO team_export VALUES(?1,?2,?3)
                ON CONFLICT(remote,id) DO UPDATE SET fingerprint=excluded.fingerprint",
                params![export_key, key, fingerprint],
            )?;
        }
        tx.commit()?;
        sent += accepted;
        pages += 1;
    }
    Ok(
        json!({"room":grant.room,"localHeads":heads,"pages":pages,"accepted":sent,"retainedLocally":retained}),
    )
}
