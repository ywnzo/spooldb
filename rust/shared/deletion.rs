use crate::{
    memory_mutation::Backend,
    memory_write::{Fault, bad},
    source,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

type Result<T> = std::result::Result<T, Fault>;
fn internal<E>(_: E) -> Fault {
    Fault(500, "INTERNAL", "Relay unavailable".to_owned())
}
fn hash(value: Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string()))
}

pub trait History: Backend {
    fn message(&self, room: &str, id: &str) -> Result<Value>;
    fn memory_layout(&self, room: &str) -> Result<bool>;
    fn reset(&self, room: &str) -> Result<Vec<String>>;
    fn finish_replay(&self, room: &str) -> Result<()>;
    fn retain(&self, room: &str, input: &Value) -> Result<Value> {
        self.publish(room, input)
    }
}

#[derive(Deserialize)]
struct Card {
    id: String,
    kind: String,
    data: Value,
    origin: Option<String>,
}

fn reset_tables(db: &impl Backend, room: &str) -> Result<()> {
    db.execute(
        "DELETE FROM shard_receipts WHERE branch IN (SELECT name FROM shard_refs WHERE room=?1)",
        &[room],
    )?;
    for table in [
        "shard_refs",
        "shard_batches",
        "shard_versions",
        "shard_batch_files",
        "shard_changes",
        "shard_doc_stats",
        "shard_checkpoints",
        "memory_docs",
        "memory_state",
        "memory_vectors",
        "memory_vector_progress",
        "memory_index",
        "memory_provenance",
        "memory_write_receipts",
        "conversation_origins",
        "team_ingest",
        "relay_audit",
        "relay_review_branches",
        "relay_review_publications",
        "memory_fts",
    ] {
        if !db
            .query(
                "SELECT name FROM sqlite_master WHERE name=?1 AND type='table'",
                &[table],
            )?
            .is_empty()
        {
            db.execute(&format!("DELETE FROM {table} WHERE room=?1"), &[room])?;
        }
    }
    Ok(())
}

pub fn run(db: &impl History, room: &str, input: &Value) -> Result<Value> {
    source::schema(db)?;
    let confirm = input["confirm"] == true;
    let fingerprint = hash(json!([input["sessionId"], input["deletionToken"]]));
    let request = if confirm {
        let id = input["requestId"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 120
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            })
            .ok_or_else(|| bad("REQUEST_ID", "Deletion needs a retry key"))?;
        let prior = db.query(
            "SELECT json_array(input_hash,result) FROM conversation_deletion_receipts
            WHERE room=?1 AND request_id=?2",
            &[room, id],
        )?;
        if let Some(prior) = prior.first() {
            let (prior_hash, result): (String, String) =
                serde_json::from_str(prior).map_err(internal)?;
            if prior_hash != fingerprint {
                return Err(Fault(
                    409,
                    "REQUEST_CONFLICT",
                    "Deletion retry changed".to_owned(),
                ));
            }
            return serde_json::from_str(&result).map_err(internal);
        }
        Some(id)
    } else {
        None
    };
    let session = input
        .get("sessionId")
        .map(|value| {
            value
                .as_str()
                .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 200)
                .ok_or_else(|| {
                    bad(
                        "DELETE_SCOPE",
                        "Choose a conversation session or all conversations",
                    )
                })
        })
        .transpose()?;
    let heads = db.heads(room)?;
    let rows = db
        .query(
            "SELECT json_object('id',d.id,'kind',d.kind,'data',json(d.data),'origin',o.data)
         FROM memory_docs d LEFT JOIN conversation_origins o ON d.room=o.room AND d.id=o.id
         WHERE d.room=?1 ORDER BY d.seq,d.rowid",
            &[room],
        )?
        .iter()
        .map(|row| serde_json::from_str::<Card>(row).map_err(internal))
        .collect::<Result<Vec<_>>>()?;
    let origins = rows
        .iter()
        .map(|row| {
            row.origin
                .as_ref()
                .map(|origin| serde_json::from_str::<Value>(origin).map_err(internal))
                .transpose()
        })
        .collect::<Result<Vec<_>>>()?;
    let removed = rows
        .iter()
        .zip(&origins)
        .filter(|(row, origin)| {
            row.kind == "conversation"
                && session.is_none_or(|session| {
                    origin.as_ref().and_then(|o| o["sessionId"].as_str()) == Some(session)
                })
        })
        .collect::<Vec<_>>();
    let ids = removed
        .iter()
        .map(|(row, _)| row.id.as_str())
        .collect::<Vec<_>>();
    let token = hash(json!([room, heads, session, ids]));
    let scope = session.unwrap_or("all");
    if !confirm {
        return Ok(
            json!({"room":room,"preview":true,"messages":ids.len(),"retained":rows.len()-ids.len(),
            "deletionToken":token,"scope":scope,"notice":"Deletes shared conversations and their retrievable history. Other memory and local Codex chats stay. Previously downloaded copies and independent backups cannot be recalled."}),
        );
    }
    if input["deletionToken"] != token {
        return Err(Fault(
            409,
            "DELETE_CONFLICT",
            "Project memory changed; preview the deletion again".to_owned(),
        ));
    }
    if !db.memory_layout(room)? {
        return Err(Fault(409,"DELETE_LAYOUT","This project has legacy code history; migrate it to memory-only storage before deletion".to_owned()));
    }
    let removed_ids: BTreeSet<_> = ids.into_iter().collect();
    if !removed_ids.is_empty() {
        let records = rows
            .iter()
            .filter(|row| !removed_ids.contains(row.id.as_str()))
            .map(|row| db.message(room, &row.id).map(|message| (row, message)))
            .collect::<Result<Vec<_>>>()?;
        for (row, origin) in &removed {
            db.execute(
                "INSERT OR IGNORE INTO conversation_tombstones VALUES(?1,'message',?2)",
                &[room, &hash(json!(row.id))],
            )?;
            if let Some(session) = origin
                .as_ref()
                .and_then(|o| o["sessionId"].as_str())
                .filter(|id| !id.is_empty())
            {
                db.execute(
                    "INSERT OR IGNORE INTO conversation_tombstones VALUES(?1,'session',?2)",
                    &[room, &hash(json!(session))],
                )?;
            }
        }
        reset_tables(db, room)?;
        let mut heads = db.reset(room)?;
        for (row, message) in records {
            let source = &row.data["source"];
            let actor = source["actor"].as_str().unwrap_or("retained-memory");
            let output=db.retain(room,&json!({
                "actor":actor,"messageId":row.id,"role":message["role"],"text":message["text"],
                "expectedHeads":heads,"harness":source["harness"].as_str().unwrap_or("conversation-cleanup"),
                "evidence":"retained-memory",
            }))?;
            heads = serde_json::from_value(output["heads"].clone()).map_err(internal)?;
            if let Some(origin) = &row.origin {
                db.execute(
                    "INSERT INTO conversation_origins VALUES(?1,?2,?3)",
                    &[room, &row.id, origin],
                )?;
            }
        }
        db.finish_replay(room)?;
    }
    let result = json!({"room":room,"deleted":true,"removed":removed_ids.len(),"retained":rows.len()-removed_ids.len(),
        "scope":scope,"notice":"Shared conversation history removed. Deleted messages and sessions are blocked from capture re-upload. Local chats and independent backups are unchanged."});
    db.execute(
        "INSERT INTO conversation_deletion_receipts VALUES(?1,?2,?3,?4)",
        &[
            room,
            request.unwrap_or_default(),
            &fingerprint,
            &result.to_string(),
        ],
    )?;
    Ok(result)
}
