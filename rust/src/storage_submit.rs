use crate::{
    Result,
    bundles::{descriptor, set_descriptor, string_field, validate_adapter},
    documents, manifest, shards,
    storage_cli::Version,
};
use automerge::{
    ActorId, Automerge, ChangeHash, ObjId, ObjType, Prop, ROOT, ReadDoc, ScalarValue,
    transaction::{CommitOptions, Transactable},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Transaction, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const MAX_TEXT: usize = 1_000_000;

pub(crate) fn put_text(
    tx: &mut impl Transactable,
    owner: &ObjId,
    name: impl Into<Prop>,
    value: &str,
) -> Result<()> {
    let field = tx.put_object(owner, name, ObjType::Text)?;
    tx.splice_text(field, 0, 0, value)?;
    Ok(())
}

fn seed(room: &str, key: &str) -> Result<Automerge> {
    let hash = Sha256::digest(serde_json::to_vec(&json!({"room":room,"key":key}))?);
    let mut doc = Automerge::new().with_actor(ActorId::from(&hash[..16]));
    let mut tx = doc.transaction();
    tx.put(ROOT, "schema", 2_i64)?;
    put_text(&mut tx, &ROOT, "room", room)?;
    put_text(&mut tx, &ROOT, "document", key)?;
    for field in ["files", "messages", "comments", "adapterEvents", "events"] {
        tx.put_object(ROOT, field, ObjType::Map)?;
    }
    tx.commit_with(
        CommitOptions::default()
            .with_time(0)
            .with_message("shard-genesis"),
    );
    doc.set_actor(ActorId::random());
    Ok(doc)
}

fn id<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let id = string_field(value, key, 200)?;
    shards::validate_id(id, key)?;
    Ok(id)
}

pub(crate) fn path(input: &Value) -> Result<&str> {
    let path = string_field(input, "path", 4096)?;
    if path
        .chars()
        .any(|c| c <= '\u{1f}' || matches!(c, ':' | '\\'))
        || path.split('/').any(|piece| {
            piece.is_empty() || piece == "." || piece == ".." || piece.eq_ignore_ascii_case(".git")
        })
    {
        return Err("Unsafe file path".into());
    }
    Ok(path)
}

pub(crate) struct FileContent<'a> {
    pub(crate) kind: &'a str,
    pub(crate) mode: i64,
    pub(crate) text: &'a str,
    pub(crate) data: &'a str,
    pub(crate) target: &'a str,
}

impl<'a> FileContent<'a> {
    pub(crate) fn parse(input: &'a Value) -> Result<Self> {
        let mode = if input["mode"].is_null() {
            420
        } else {
            input["mode"]
                .as_i64()
                .filter(|mode| matches!(mode, 420 | 493))
                .ok_or("Invalid file mode")?
        };
        let kind = if input["kind"].is_null() {
            "text"
        } else {
            input["kind"].as_str().ok_or("Invalid file kind")?
        };
        let mut content = Self {
            kind,
            mode,
            text: "",
            data: "",
            target: "",
        };
        match kind {
            "text" => content.text = string_field(input, "text", MAX_TEXT)?,
            "binary" => {
                let value = string_field(input, "data", 1_400_000)?;
                let bytes = STANDARD.decode(value).map_err(|_| "Invalid binary data")?;
                if bytes.len() > MAX_TEXT || STANDARD.encode(bytes) != value {
                    return Err("Invalid binary data".into());
                }
                content.data = value;
            }
            "symlink" => {
                let value = string_field(input, "target", 4096)?;
                if value.is_empty() || value.contains('\0') {
                    return Err("Invalid symlink target".into());
                }
                content.target = value;
            }
            _ => return Err("Invalid file kind".into()),
        }
        Ok(content)
    }
}

pub(crate) fn object(doc: &impl ReadDoc, owner: &ObjId, name: &str) -> Result<ObjId> {
    doc.get(owner, name)?
        .map(|(_, id)| id)
        .ok_or_else(|| format!("Missing {name}").into())
}

pub(crate) fn text_at(doc: &impl ReadDoc, owner: &ObjId, name: &str) -> Result<String> {
    let (value, key) = doc.get(owner, name)?.ok_or("Missing text field")?;
    if let Some(text) = value.as_str() {
        return Ok(text.into());
    }
    Ok(doc.text(key)?)
}

fn field_nonnegative(input: &Value, name: &str) -> Result<usize> {
    input[name]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("Invalid {name}").into())
}

fn check_offset(utf16: &[u16], offset: usize) -> Result<()> {
    if offset > utf16.len() {
        return Err("Invalid text offset".into());
    }
    if utf16
        .get(offset)
        .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
    {
        return Err("Offset splits a Unicode surrogate pair".into());
    }
    Ok(())
}

pub(crate) fn file_cursor(
    doc: &impl ReadDoc,
    file_id: &str,
    input: &Value,
    require_live: bool,
) -> Result<(String, String)> {
    shards::validate_id(file_id, "fileId")?;
    let files = object(doc, &ROOT, "files")?;
    let file = object(doc, &files, file_id)?;
    if require_live
        && doc
            .get(&file, "deleted")?
            .and_then(|(value, _)| value.as_bool())
            == Some(true)
    {
        return Err("Unknown or deleted file".into());
    }
    let text = object(doc, &file, "text")?;
    let utf16: Vec<_> = doc.text(text.clone())?.encode_utf16().collect();
    let start = field_nonnegative(input, "start")?;
    let end = field_nonnegative(input, "end")?;
    check_offset(&utf16, start)?;
    check_offset(&utf16, end)?;
    if start > end {
        return Err("Invalid comment range".into());
    }
    let cursor = |offset| {
        let position = if offset == utf16.len() {
            automerge::CursorPosition::End
        } else {
            automerge::CursorPosition::Index(offset)
        };
        doc.get_cursor(text.clone(), position, None)
            .map(|cursor| cursor.to_string())
    };
    Ok((cursor(start)?, cursor(end)?))
}

pub(crate) fn put_json(
    tx: &mut impl Transactable,
    parent: &ObjId,
    prop: impl Into<Prop>,
    input: &Value,
) -> Result<()> {
    match input {
        Value::Object(fields) => {
            let target = tx.put_object(parent, prop, ObjType::Map)?;
            for (key, value) in fields {
                put_json(tx, &target, key.as_str(), value)?;
            }
        }
        Value::Array(values) => {
            let target = tx.put_object(parent, prop, ObjType::List)?;
            for (index, value) in values.iter().enumerate() {
                tx.insert(&target, index, ScalarValue::Null)?;
                put_json(tx, &target, index, value)?;
            }
        }
        Value::String(value) => put_text(tx, parent, prop, value)?,
        Value::Number(value) => match (value.as_i64(), value.as_u64(), value.as_f64()) {
            (Some(value), _, _) => tx.put(parent, prop, value)?,
            (_, Some(value), _) => tx.put(parent, prop, value)?,
            (_, _, Some(value)) => tx.put(parent, prop, value)?,
            _ => return Err("Unsupported JSON number".into()),
        },
        Value::Bool(value) => tx.put(parent, prop, *value)?,
        Value::Null => tx.put(parent, prop, ScalarValue::Null)?,
    }
    Ok(())
}

fn apply(
    doc: &mut Automerge,
    input: &Value,
    kind: &str,
    identifier: &str,
    event: &str,
    cursors: Option<(String, String)>,
) -> Result<()> {
    let mut tx = doc.transaction();
    apply_operation(&mut tx, input, kind, identifier, event, cursors)?;
    tx.commit_with(CommitOptions::default().with_message(event));
    Ok(())
}

pub(crate) fn apply_operation(
    tx: &mut impl Transactable,
    input: &Value,
    kind: &str,
    identifier: &str,
    event: &str,
    cursors: Option<(String, String)>,
) -> Result<()> {
    let field = match kind {
        "message.add" => "messages",
        "comment.add" => "comments",
        "adapter.record" => "adapterEvents",
        _ => "files",
    };
    let entities = if kind == "adapter.record" && tx.get(ROOT, field)?.is_none() {
        tx.put_object(ROOT, field, ObjType::Map)?
    } else {
        object(tx, &ROOT, field)?
    };
    let existing = tx.get(&entities, identifier)?.map(|(_, value)| value);
    if matches!(
        kind,
        "file.create" | "message.add" | "comment.add" | "adapter.record"
    ) && existing.is_some()
    {
        return Err("Operation ID already exists".into());
    }
    match kind {
        "message.add" => {
            let role = string_field(input, "role", 200)?;
            if !matches!(role, "user" | "assistant" | "tool" | "system") {
                return Err("Invalid message role".into());
            }
            let item = tx.put_object(&entities, identifier, ObjType::Map)?;
            put_text(tx, &item, "role", role)?;
            put_text(tx, &item, "text", string_field(input, "text", MAX_TEXT)?)?;
            put_text(tx, &item, "eventId", event)?;
        }
        "comment.add" => {
            let (start, end) = cursors.ok_or("Missing comment cursors")?;
            let item = tx.put_object(&entities, identifier, ObjType::Map)?;
            for (name, value) in [
                ("fileId", id(input, "fileId")?),
                ("text", string_field(input, "text", MAX_TEXT)?),
                ("eventId", event),
                ("start", &start),
                ("end", &end),
            ] {
                put_text(tx, &item, name, value)?;
            }
        }
        "adapter.record" => {
            validate_adapter(&input["event"], identifier)?;
            put_json(tx, &entities, identifier, &input["event"])?;
        }
        "file.create" => {
            let content = FileContent::parse(input)?;
            let item = tx.put_object(&entities, identifier, ObjType::Map)?;
            for (name, value) in [
                ("path", path(input)?),
                ("kind", content.kind),
                ("text", content.text),
                ("data", content.data),
                ("target", content.target),
                ("createdBy", event),
            ] {
                put_text(tx, &item, name, value)?;
            }
            tx.put(&item, "mode", content.mode)?;
            tx.put(&item, "deleted", false)?;
        }
        _ => {
            let file = existing.ok_or("Unknown file")?;
            let deleted = tx
                .get(&file, "deleted")?
                .and_then(|(value, _)| value.as_bool())
                == Some(true);
            if deleted && !matches!(kind, "file.delete" | "file.restore") {
                return Err("File is deleted".into());
            }
            match kind {
                "file.rename" => put_text(tx, &file, "path", path(input)?)?,
                "file.delete" | "file.restore" => {
                    tx.put(&file, "deleted", kind == "file.delete")?
                }
                "file.splice" => {
                    if tx.get(&file, "kind")?.is_some() && text_at(tx, &file, "kind")? != "text" {
                        return Err("File is not text".into());
                    }
                    let text = object(tx, &file, "text")?;
                    let content: Vec<_> = tx.text(text.clone())?.encode_utf16().collect();
                    let start = field_nonnegative(input, "index")?;
                    let delete = field_nonnegative(input, "deleteCount")?;
                    let end = start.checked_add(delete).ok_or("Invalid deletion range")?;
                    check_offset(&content, start)?;
                    check_offset(&content, end)?;
                    let inserted = string_field(input, "insert", MAX_TEXT)?;
                    if content.len() - delete + inserted.encode_utf16().count() > MAX_TEXT {
                        return Err("File too large".into());
                    }
                    tx.splice_text(&text, start, isize::try_from(delete)?, inserted)?;
                }
                "file.write" => {
                    let content = FileContent::parse(input)?;
                    let text = object(tx, &file, "text")?;
                    tx.update_text(&text, content.text)?;
                    for (name, value) in [
                        ("kind", content.kind),
                        ("data", content.data),
                        ("target", content.target),
                    ] {
                        if text_at(tx, &file, name).ok().as_deref() != Some(value)
                            || tx.get_all(&file, name)?.len() > 1
                        {
                            put_text(tx, &file, name, value)?;
                        }
                    }
                    if tx.get(&file, "mode")?.and_then(|(value, _)| value.as_i64())
                        != Some(content.mode)
                        || tx.get_all(&file, "mode")?.len() > 1
                    {
                        tx.put(&file, "mode", content.mode)?;
                    }
                }
                _ => return Err("Unknown operation type".into()),
            }
        }
    }
    Ok(())
}

struct Edit {
    doc: Automerge,
    before: Vec<ChangeHash>,
}

fn edit(db: &Transaction<'_>, version: &Version, key: &str) -> Result<Edit> {
    let entry = manifest::lookup_root(db, version.root.clone(), key)?;
    if entry.is_null() {
        return Ok(Edit {
            doc: seed(&version.room, key)?,
            before: Vec::new(),
        });
    }
    let heads: Vec<String> = serde_json::from_value(entry["descriptor"]["heads"].clone())?;
    let mut doc = documents::load(db, &version.room, key, &heads)?;
    let before = doc.get_heads();
    doc.set_actor(ActorId::random());
    Ok(Edit { doc, before })
}

pub(crate) struct Operation<'a> {
    pub(crate) kind: &'a str,
    pub(crate) input: &'a Value,
    pub(crate) id: &'a str,
    key: String,
}

impl<'a> Operation<'a> {
    pub(crate) fn parse(input: &'a Value) -> Result<Self> {
        let kind = string_field(input, "type", 200)?;
        let (prefix, id) = match kind {
            "file.create" | "file.rename" | "file.write" | "file.splice" | "file.delete"
            | "file.restore" => ("f", id(input, "fileId")?),
            "message.add" => ("m", id(input, "messageId")?),
            "comment.add" => ("c", id(input, "commentId")?),
            "adapter.record" => ("a", id(&input["event"], "eventId")?),
            _ => return Err("Unknown operation type".into()),
        };
        Ok(Self {
            kind,
            input,
            id,
            key: format!("{prefix}:{id}"),
        })
    }
}

// Receipts keep the input's field order for retries made by older clients.
pub(crate) fn compact(raw: &str) -> String {
    let mut encoded = String::with_capacity(raw.len());
    let (mut quoted, mut escaped) = (false, false);
    for ch in raw.chars() {
        if quoted || !matches!(ch, ' ' | '\r' | '\n' | '\t') {
            encoded.push(ch);
        }
        if escaped {
            escaped = false;
        } else if quoted && ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            quoted = !quoted;
        }
    }
    encoded
}

pub(crate) fn metadata(
    input: &Value,
    actor: &str,
    operations: &[Operation<'_>],
    event: &str,
    observed_at: &str,
) -> Result<Value> {
    let mut seen = BTreeSet::new();
    let file_ids: Vec<_> = operations
        .iter()
        .filter_map(|op| op.input["fileId"].as_str())
        .filter(|id| seen.insert(*id))
        .collect();
    let harness = if input["harness"].is_null() {
        "generic"
    } else {
        string_field(input, "harness", 200)?
    };
    let mut metadata = json!({"eventId":event,"actor":actor,"harness":harness,"observedAt":observed_at,
        "operationTypes":operations.iter().map(|op|op.kind).collect::<Vec<_>>(),"fileIds":file_ids,
        "messageIds":operations.iter().filter(|op|op.kind=="message.add").map(|op|op.id).collect::<Vec<_>>()});
    for key in [
        "sessionId",
        "turnId",
        "messageId",
        "toolCallId",
        "evidence",
        "gitCommit",
        "sourceEventId",
        "observedAfter",
    ] {
        if input.get(key).is_some() {
            metadata[key] = json!(string_field(input, key, 200)?);
        }
    }
    Ok(metadata)
}

pub fn submit(db: &Transaction<'_>, branch: &str, input: &Value, raw: &str) -> Result<Value> {
    let actor = id(input, "actor")?;
    let request_id = id(input, "requestId")?;
    let mut statement = db.prepare_cached(
        "SELECT input,result FROM shard_receipts WHERE branch=?1 AND request_id=?2",
    )?;
    let mut rows = statement.query(params![branch, request_id])?;
    if let Some(row) = rows.next()? {
        if manifest::decode(row.get_ref(0)?)? != *input {
            return Err("Request ID reused with different input".into());
        }
        return Ok(serde_json::from_str(&row.get::<_, String>(1)?)?);
    }
    let mut version = Version::open(db, branch, None)?;
    let mut expected: Vec<String> = serde_json::from_value(input["expectedHeads"].clone())
        .map_err(|_| "expectedHeads is required; read before writing")?;
    expected.sort_unstable();
    if expected != version.heads {
        return Err("Stale heads; read again or edit an offline branch and merge".into());
    }
    let operations = input["operations"]
        .as_array()
        .filter(|ops| !ops.is_empty() && ops.len() <= 10_000)
        .ok_or("Expected 1–10000 operations")?
        .iter()
        .map(Operation::parse)
        .collect::<Result<Vec<_>>>()?;
    let (event, observed_at) = shards::observation(db)?;
    let metadata = metadata(input, actor, &operations, &event, &observed_at)?;
    let mut remaining = BTreeMap::new();
    for op in &operations {
        *remaining.entry(op.key.as_str()).or_insert(0_usize) += 1;
    }
    let mut working: BTreeMap<&str, Edit> = BTreeMap::new();
    let mut updates = BTreeMap::new();
    for op in &operations {
        let key = op.key.as_str();
        if matches!(op.kind, "file.create" | "file.rename") {
            let descriptor =
                manifest::lookup_root(db, version.root.clone(), &format!("p:{}", path(op.input)?))?;
            if descriptor["descriptor"]["files"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|id| id != op.id)
            {
                return Err("Path already exists".into());
            }
        }
        let cursors = if op.kind == "comment.add" {
            let file = id(op.input, "fileId")?;
            let file_key = format!("f:{file}");
            let loaded;
            let document = if let Some(current) = working.get(file_key.as_str()) {
                &current.doc
            } else {
                loaded = edit(db, &version, &file_key)?;
                &loaded.doc
            };
            Some(file_cursor(document, file, op.input, true)?)
        } else {
            None
        };
        if let std::collections::btree_map::Entry::Vacant(entry) = working.entry(key) {
            entry.insert(edit(db, &version, key)?);
        }
        let entry = working.get_mut(key).ok_or("Missing working document")?;
        apply(&mut entry.doc, op.input, op.kind, op.id, &event, cursors)?;
        let left = remaining.get_mut(key).ok_or("Missing operation count")?;
        *left -= 1;
        if *left == 0
            || matches!(
                op.kind,
                "file.create" | "file.rename" | "file.delete" | "file.restore"
            )
        {
            let value = descriptor(key, &entry.doc)?;
            version.root = set_descriptor(db, version.root, key, value)?;
        }
        if *left == 0 {
            let entry = working.remove(key).ok_or("Missing completed document")?;
            documents::persist(db, &version.room, key, entry.doc.get_changes(&entry.before))?;
            documents::checkpoint_if_due(db, &version.room, key, &entry.doc)?;
            updates.insert(
                key.to_owned(),
                entry
                    .doc
                    .get_heads()
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            );
        }
    }
    let mut result = shards::publish_rooted_batch(
        db,
        &version.room,
        branch,
        &version.heads,
        version.root,
        metadata,
        updates.into_iter().collect(),
    )?;
    result["eventId"] = json!(event);
    db.execute(
        "INSERT INTO shard_receipts(branch,request_id,input,result) VALUES(?1,?2,?3,?4)",
        params![
            branch,
            request_id,
            manifest::encode(&compact(raw))?,
            serde_json::to_string(&result)?
        ],
    )?;
    Ok(result)
}
