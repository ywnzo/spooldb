use crate::{
    memory_mutation::Backend,
    memory_record::valid_event,
    memory_write::{Fault, bad, git_reference},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub type Result<T> = std::result::Result<T, Fault>;
fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string()))
}
fn id(principal: &str, source: &str) -> String {
    format!("captured-{}", digest(&json!([principal, source])))
}
fn valid_text(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= max)
}
fn short(s: &str, n: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(n).collect::<Vec<_>>())
}

pub fn schema(db: &impl Backend) -> Result<()> {
    for statement in [
        "CREATE TABLE IF NOT EXISTS conversation_tombstones(room TEXT,kind TEXT,key_hash TEXT,PRIMARY KEY(room,kind,key_hash))",
        "CREATE TABLE IF NOT EXISTS conversation_deletion_receipts(room TEXT,request_id TEXT,input_hash TEXT,result TEXT,PRIMARY KEY(room,request_id))",
        "CREATE TABLE IF NOT EXISTS team_source_private(room TEXT,principal TEXT,id TEXT,PRIMARY KEY(room,principal,id))",
        "CREATE TABLE IF NOT EXISTS team_ingest(room TEXT,principal TEXT,request_id TEXT,hash TEXT,result TEXT,PRIMARY KEY(room,principal,request_id))",
    ] {
        db.execute(statement, &[])?;
    }
    Ok(())
}

fn shared_file(file: &Value) -> Result<Value> {
    if file.get("fileId").is_some() || file.get("heads").is_some() {
        let mut value = json!({"legacySnapshotReference":true});
        if let Some(path) = file.get("path") {
            value["path"] = path.clone();
        }
        git_reference(&value)
    } else {
        git_reference(file)
    }
}

struct Record<'a> {
    local_id: &'a str,
    role: &'a str,
    text: &'a str,
    provenance: &'a Value,
    event: Option<Value>,
}

fn validate(record: &Value) -> Result<Record<'_>> {
    if record["kind"] != "message" {
        return Err(Fault(
            426,
            "GIT_ONLY",
            "Source files are not accepted. Update your client; code stays in Git.".to_owned(),
        ));
    }
    let invalid = || bad("SOURCE_MESSAGE", "Invalid captured conversation");
    let fields = record.as_object().ok_or_else(invalid)?;
    if !fields
        .keys()
        .all(|key| matches!(key.as_str(), "kind" | "id" | "role" | "text" | "provenance"))
        || !valid_text(&record["id"], 200)
    {
        return Err(invalid());
    }
    let role = record["role"]
        .as_str()
        .filter(|s| matches!(*s, "user" | "assistant" | "system" | "tool"))
        .ok_or_else(invalid)?;
    let text = record["text"]
        .as_str()
        .filter(|s| s.encode_utf16().count() <= 500_000)
        .ok_or_else(invalid)?;
    let mut event = None;
    if role == "system"
        && let Ok(candidate) = serde_json::from_str::<Value>(text)
        && candidate["protocol"] == "spool-memory/1"
    {
        if !valid_event(&candidate) {
            return Err(bad("SOURCE_MEMORY", "Invalid structured memory record"));
        }
        for file in candidate["files"].as_array().into_iter().flatten() {
            shared_file(file)?;
        }
        if let Some(git) = candidate.get("git") {
            shared_file(git)?;
        }
        event = Some(candidate);
    }
    let provenance = &record["provenance"];
    if fields.contains_key("provenance")
        && !provenance.as_object().is_some_and(|fields| {
            valid_text(&provenance["sessionId"], 200)
                && fields.iter().all(|(key, value)| {
                    matches!(
                        key.as_str(),
                        "sessionId" | "turnId" | "itemId" | "harness" | "source"
                    ) && valid_text(value, 200)
                })
        })
    {
        return Err(bad("SOURCE_MESSAGE", "Invalid conversation provenance"));
    }
    Ok(Record {
        local_id: record["id"].as_str().unwrap_or_default(),
        role,
        text,
        provenance,
        event,
    })
}

fn category(event: Option<&Value>) -> &'static str {
    match event.and_then(|v| v["kind"].as_str()) {
        Some("finding" | "blocker") => "findings",
        Some("task") => "tasks",
        Some("decision") => "decisions",
        Some("handoff") => "handoffs",
        _ => "conversations",
    }
}

fn blocked(record: &Record<'_>, sharing: &Value) -> bool {
    sharing[category(record.event.as_ref())]==false || sharing["conversations"]==false &&
        record.event.as_ref().and_then(|value|value["text"].as_str()).is_some_and(|text|
            text.starts_with("Current request (source text, not verified findings):\n") ||
            text.starts_with("Automatic lifecycle checkpoint; agent-authored next steps and verification were not supplied."))
}

fn map_event(mut event: Value, principal: &str) -> Result<Value> {
    let actor = event.get("actor").map_or("undefined".to_owned(), |actor| {
        actor
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| actor.to_string())
    });
    event["actor"] = json!(format!("{principal}/{}", short(&actor, 100)));
    if let Some(task) = event["taskId"].as_str().filter(|s| !s.is_empty()) {
        event["taskId"] = json!(short(&format!("{principal}.{task}"), 160));
    }
    for field in ["refs", "resolveIds"] {
        if field == "refs" || event.get(field).is_some() {
            event[field] = json!(
                event[field]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|key| id(principal, key))
                    .collect::<Vec<_>>()
            );
        }
    }
    event["files"] = json!(
        event["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(shared_file)
            .collect::<Result<Vec<_>>>()?
    );
    if let Some(changes) = event
        .get_mut("lifecycleChanges")
        .and_then(Value::as_array_mut)
    {
        for change in changes {
            for field in ["targetId", "replacementId"] {
                if let Some(target) = change[field].as_str() {
                    change[field] = json!(id(principal, target));
                }
            }
        }
    }
    if let Some(git) = event.get("git") {
        event["git"] = shared_file(git)?;
    }
    event["importedFromLocal"] = json!(true);
    if !valid_event(&event) {
        return Err(bad(
            "SOURCE_MEMORY",
            "Invalid mapped structured memory record",
        ));
    }
    Ok(event)
}

pub fn ingest(
    db: &impl Backend,
    room: &str,
    principal: &str,
    input: &Value,
    sharing: &Value,
    wire_digest: Option<&str>,
) -> Result<Value> {
    let fingerprint = digest(&input["records"]);
    let records = input["records"]
        .as_array()
        .filter(|records| !records.is_empty() && records.len() <= 50)
        .ok_or_else(|| bad("SOURCE_LIMIT", "Expected 1–50 conversation records"))?;
    let records = records.iter().map(validate).collect::<Result<Vec<_>>>()?;
    let request = input["requestId"]
        .as_str()
        .filter(|_| valid_text(&input["requestId"], 200))
        .ok_or_else(|| bad("REQUEST_ID", "Request ID required"))?;
    schema(db)?;
    let old=db.query("SELECT json_array(hash,result) FROM team_ingest WHERE room=?1 AND principal=?2 AND request_id=?3",
        &[room,principal,request])?;
    if let Some(old) = old.first() {
        let (hash, result): (String, Value) = serde_json::from_str(old)
            .map_err(|_| bad("SOURCE_MESSAGE", "Invalid stored receipt"))?;
        if hash != fingerprint && wire_digest != Some(&hash) {
            return Err(Fault(
                409,
                "REQUEST_CONFLICT",
                "Conversation retry changed".to_owned(),
            ));
        }
        return result
            .as_str()
            .and_then(|v| serde_json::from_str(v).ok())
            .ok_or_else(|| bad("SOURCE_MESSAGE", "Invalid stored receipt"));
    }
    let mut heads = db.heads(room)?;
    let mut skipped = 0;
    let mut operations = 0;
    let count = records.len();
    for record in records {
        let stored_id = id(principal, record.local_id);
        if record.event.is_none()
            && !db
                .query(
                    "SELECT key_hash FROM conversation_tombstones WHERE room=?1 AND (
                (kind='message' AND key_hash=?2) OR (kind='session' AND key_hash=?3))",
                    &[
                        room,
                        &digest(&json!(stored_id)),
                        &digest(&record.provenance["sessionId"]),
                    ],
                )?
                .is_empty()
        {
            skipped += 1;
            continue;
        }
        let exists = !db
            .query(
                "SELECT id FROM memory_docs WHERE room=?1 AND id=?2",
                &[room, &stored_id],
            )?
            .is_empty();
        if blocked(&record, sharing) {
            if !exists {
                db.execute(
                    "INSERT OR IGNORE INTO team_source_private VALUES(?1,?2,?3)",
                    &[room, principal, record.local_id],
                )?;
            }
            skipped += 1;
            continue;
        }
        if !db
            .query(
                "SELECT id FROM team_source_private WHERE room=?1 AND principal=?2 AND id=?3",
                &[room, principal, record.local_id],
            )?
            .is_empty()
        {
            skipped += 1;
            continue;
        }
        if record.provenance.is_object() {
            let mut origin = record.provenance.clone();
            origin["principal"] = json!(principal);
            db.execute("INSERT INTO conversation_origins VALUES(?1,?2,?3) ON CONFLICT(room,id) DO UPDATE SET data=excluded.data",
                &[room,&stored_id,&origin.to_string()])?;
        }
        if exists {
            continue;
        }
        let text = record
            .event
            .map(|event| map_event(event, principal).map(|event| event.to_string()))
            .transpose()?
            .unwrap_or_else(|| record.text.to_owned());
        let mut message = json!({"actor":principal,"messageId":stored_id,"role":record.role,"text":text,
            "expectedHeads":heads,"harness":record.provenance["harness"].as_str().unwrap_or("team-capture"),
            "sessionId":record.provenance["sessionId"].as_str().unwrap_or(principal),"evidence":"machine-captured-conversation"});
        // Shard metadata uses messageId for the originating harness item, while
        // messageId on the append command identifies the stored shard.
        for (field, key) in [
            ("turnId", "turnId"),
            ("provenanceMessageId", "itemId"),
            ("sourceEventId", "source"),
        ] {
            if let Some(value) = record.provenance.get(key) {
                message[field] = value.clone();
            }
        }
        let output = db.publish(room, &message)?;
        heads = serde_json::from_value(output["heads"].clone())
            .map_err(|_| bad("INVALID_FRONTIER", "Invalid published frontier"))?;
        operations += 1;
    }
    let output = json!({"room":room,"sourcePrefix":format!("@machines/{principal}/"),"accepted":count-skipped,
        "skipped":skipped,"operations":operations});
    db.execute(
        "INSERT INTO team_ingest VALUES(?1,?2,?3,?4,?5)",
        &[
            room,
            principal,
            request,
            wire_digest.unwrap_or(&fingerprint),
            &output.to_string(),
        ],
    )?;
    Ok(output)
}

pub fn wire_digest(raw: &[u8]) -> Option<String> {
    // Hash the original compact records JSON to match pre-Rust receipt hashes.
    #[derive(serde::Deserialize)]
    struct Page<'a> {
        #[serde(borrow)]
        records: &'a serde_json::value::RawValue,
    }
    let page: Page = serde_json::from_slice(raw).ok()?;
    let mut compact = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for c in page.records.get().chars() {
        if quoted {
            compact.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if !c.is_ascii_whitespace() {
            compact.push(c);
            if c == '"' {
                quoted = true;
            }
        }
    }
    Some(format!("{:x}", Sha256::digest(compact.as_bytes())))
}
