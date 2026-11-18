use crate::{Result, shards};
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub source: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub item_id: String,
    pub role: String,
    pub text: String,
    pub harness: String,
}

pub fn store(database: &Path, branch: &str, messages: &[Message]) -> Result<Value> {
    shards::validate_id(branch, "branch")?;
    if messages.len() > 1000 {
        return Err("Capture page exceeds message limit".into());
    }
    let mut db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(5))?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS native_message_receipts(id TEXT PRIMARY KEY)")?;
    let (room, raw): (String, String) = tx.query_row(
        "SELECT room,heads FROM shard_refs WHERE name=?1",
        [branch],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut heads: Value = serde_json::from_str(&raw)?;
    let mut stored = 0;
    for message in messages {
        let nonempty = |s: &str| !s.is_empty() && s.encode_utf16().count() <= 200;
        if !matches!(message.source.as_str(), "codex-history" | "zed-acp")
            || !matches!(message.role.as_str(), "assistant" | "user")
            || !nonempty(&message.session_id)
            || !nonempty(&message.item_id)
            || message.turn_id.as_ref().is_some_and(|turn| !nonempty(turn))
            || message.text.encode_utf16().count() > 500_000
        {
            return Err("Invalid captured message".into());
        }
        let receipt = format!(
            "{:x}",
            Sha256::digest(
                json!([
                    message.source,
                    message.session_id,
                    message.item_id,
                    message.role,
                    message.text
                ])
                .to_string()
                .as_bytes()
            )
        );
        if tx.execute(
            "INSERT OR IGNORE INTO native_message_receipts(id) VALUES(?1)",
            params![receipt],
        )? == 0
        {
            continue;
        }
        let source_prefix = "codex-history:";
        let session_prefix: String = message
            .session_id
            .chars()
            .scan(source_prefix.len(), |length, ch| {
                *length += ch.len_utf16();
                (*length <= 200).then_some(ch)
            })
            .collect();
        let mut input = json!({"actor":message.harness,"harness":message.harness,
            "messageId":format!("native-{receipt}"),"role":message.role,"text":message.text,
            "sessionId":message.session_id,"provenanceMessageId":message.item_id,
            "sourceEventId":format!("{source_prefix}{session_prefix}"),"evidence":"codex-saved-history",
            "expectedHeads":heads});
        if let Some(turn) = &message.turn_id {
            input["turnId"] = json!(turn);
        }
        heads = shards::append_message(&tx, &room, branch, &input)?["heads"].clone();
        stored += 1;
    }
    tx.commit()?;
    Ok(json!({"stored":stored,"room":room,"heads":heads}))
}

pub fn publish_local(directory: &Path, room: &str) -> Result<Value> {
    use crate::bundles;
    use rusqlite::OptionalExtension;
    let mut capture = Connection::open_with_flags(
        directory.join("capture.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut relay = Connection::open_with_flags(
        directory.join("relay.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )?;
    for db in [&capture, &relay] {
        db.busy_timeout(Duration::from_secs(5))?;
    }
    let source = capture.transaction()?;
    let actual_room: String = source.query_row(
        "SELECT room FROM shard_refs WHERE name='working'",
        [],
        |row| row.get(0),
    )?;
    if actual_room != room {
        return Err("Capture room differs from the local project".into());
    }
    relay.execute_batch("CREATE TABLE IF NOT EXISTS native_capture_cursors(room TEXT PRIMARY KEY,heads TEXT NOT NULL)")?;
    for count in 0..1000 {
        let target = relay.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored: Option<String> = target
            .query_row(
                "SELECT heads FROM native_capture_cursors WHERE room=?1",
                [room],
                |row| row.get(0),
            )
            .optional()?;
        let since: Vec<String> = stored
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_default();
        let page = bundles::export_page(&source, room, "working", &since, None, 4 * 1024 * 1024)?;
        let bundle = &page["bundle"];
        if bundle.is_null() {
            return Ok(json!({"pages":count,"heads":page["heads"]}));
        }
        bundles::import(&target, &format!("relay-{room}"), bundle)?;
        target.execute("INSERT INTO native_capture_cursors VALUES(?1,?2) ON CONFLICT(room) DO UPDATE SET heads=excluded.heads",
            params![room,bundle["heads"].to_string()])?;
        target.commit()?;
        if page["more"] == false {
            return Ok(json!({"pages":count+1,"heads":page["heads"]}));
        }
    }
    Err("Capture publish page budget reached; run again to resume".into())
}
