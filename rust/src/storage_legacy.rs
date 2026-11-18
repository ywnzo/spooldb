use crate::{
    Result, bundles, documents, private_files, shards,
    storage_cli::{conflict_values, field, integer},
    storage_submit::{self, Operation, object, put_json, put_text, text_at},
};
use automerge::{
    ActorId, AutoSerde, Automerge, Change, ChangeHash, ObjType, ROOT, ReadDoc,
    transaction::{CommitOptions, Transactable},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS changes(
        seq INTEGER PRIMARY KEY, room TEXT NOT NULL, hash TEXT NOT NULL,
        deps TEXT NOT NULL, body BLOB NOT NULL, UNIQUE(room,hash));
    CREATE TABLE IF NOT EXISTS refs(name TEXT PRIMARY KEY,room TEXT NOT NULL,heads TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts(
        branch TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(branch,request_id));
";

fn lookup(db: &Transaction<'_>, branch: &str) -> Result<Option<(String, String)>> {
    shards::validate_id(branch, "branch")?;
    Ok(db
        .query_row(
            "SELECT room,heads FROM refs WHERE name=?1",
            [branch],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

fn hashes(heads: &[ChangeHash]) -> Vec<String> {
    heads.iter().map(ToString::to_string).collect()
}

fn load(db: &Transaction<'_>, branch: &str) -> Result<(String, Automerge)> {
    let (room, heads) = lookup(db, branch)?.ok_or("Unknown branch")?;
    let mut doc = Automerge::new();
    let mut query=db.prepare_cached(
        "WITH RECURSIVE reachable(hash) AS (
            SELECT value FROM json_each(?1)
            UNION SELECT dep.value FROM changes c JOIN reachable r ON c.hash=r.hash
              JOIN json_each(c.deps) dep WHERE c.room=?2
         )
         SELECT c.hash,c.body FROM changes c JOIN reachable r ON c.hash=r.hash WHERE c.room=?2 ORDER BY c.seq"
    )?;
    let mut rows = query.query(params![heads, room])?;
    while let Some(row) = rows.next()? {
        let stored: String = row.get(0)?;
        let change = Change::from_bytes(row.get(1)?)?;
        if change.hash().to_string() != stored {
            return Err("Corrupt stored history".into());
        }
        doc.apply_changes([change])?;
    }
    if doc.get_heads() != documents::parse_heads(&heads)? || !doc.get_missing_deps(&[]).is_empty() {
        return Err("Incomplete stored history".into());
    }
    if text_at(&doc, &ROOT, "room")? != room {
        return Err("Stored room identity differs from its branch".into());
    }
    Ok((room, doc))
}

fn at(doc: Automerge, heads: Option<&Value>) -> Result<Automerge> {
    if let Some(heads) = heads.filter(|heads| !heads.is_null()) {
        return Ok(doc.fork_at(&documents::parse_heads(&heads.to_string())?)?);
    }
    Ok(doc)
}

fn publish(
    db: &Transaction<'_>,
    branch: &str,
    room: &str,
    doc: &Automerge,
    prior: &[ChangeHash],
) -> Result<Value> {
    let mut insert = db
        .prepare_cached("INSERT OR IGNORE INTO changes(room,hash,deps,body) VALUES(?1,?2,?3,?4)")?;
    for change in doc.get_changes(prior) {
        insert.execute(params![
            room,
            change.hash().to_string(),
            serde_json::to_string(&hashes(change.deps()))?,
            change.raw_bytes()
        ])?;
    }
    let heads = hashes(&doc.get_heads());
    db.execute(
        "INSERT INTO refs(name,room,heads) VALUES(?1,?2,?3)
        ON CONFLICT(name) DO UPDATE SET heads=excluded.heads",
        params![branch, room, serde_json::to_string(&heads)?],
    )?;
    Ok(json!({"branch":branch,"room":room,"heads":heads}))
}

fn read(doc: &Automerge, room: &str, file_id: Option<&str>) -> Result<Value> {
    let data = serde_json::to_value(AutoSerde::from(doc))?;
    let files = object(doc, &ROOT, "files")?;
    let mut state = Vec::new();
    let mut conflicts = Vec::new();
    let mut paths = BTreeMap::new();
    for item in doc.map_range(&files, ..) {
        let id = item.key.to_string();
        let mut file = data["files"][&id].clone();
        let path = field(&file, "path")?.to_owned();
        if file["deleted"] != true
            && let Some(previous) = paths.insert(path.clone(), id.clone())
        {
            conflicts.push(json!({"type":"path-collision","path":path,"fileIds":[previous,id]}));
        }
        for key in ["path", "deleted", "kind", "mode", "data", "target"] {
            if let Some(values) = conflict_values(doc, &item.id(), key)? {
                conflicts.push(
                    json!({"type":"concurrent-metadata","fileId":id,"field":key,"values":values}),
                );
            }
        }
        file["fileId"] = json!(id);
        state.push(file);
    }
    let heads = hashes(&doc.get_heads());
    if let Some(id) = file_id {
        let file = state
            .into_iter()
            .find(|file| file["fileId"] == id)
            .ok_or("Unknown file")?;
        conflicts.retain(|conflict| {
            conflict["fileId"] == id
                || conflict["fileIds"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|value| value == id))
        });
        return Ok(json!({"room":room,"heads":heads,"file":file,"conflicts":conflicts}));
    }
    let adapters = data["adapterEvents"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    Ok(
        json!({"room":room,"heads":heads,"files":state,"messages":data["messages"],
        "comments":data["comments"],"adapterEvents":adapters,"conflicts":conflicts}),
    )
}

fn provenance(change: &Change) -> Result<Value> {
    change
        .message()
        .filter(|message| !message.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map(|value| value.unwrap_or(Value::Null))
        .map_err(Into::into)
}

fn trace(doc: &Automerge, file: &str) -> Result<Value> {
    let data = serde_json::to_value(AutoSerde::from(doc))?;
    if data["files"][file].is_null() {
        return Err("Unknown file".into());
    }
    let mut result = Vec::new();
    for change in doc.get_changes(&[]) {
        let provenance = provenance(&change)?;
        if !provenance["fileIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == file))
        {
            continue;
        }
        let mut seen = BTreeSet::new();
        let mut messages = Vec::new();
        for id in provenance["messageIds"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(provenance.get("messageId"))
            .filter_map(Value::as_str)
        {
            if !seen.insert(id) || data["messages"][id].is_null() {
                continue;
            }
            let mut message = data["messages"][id].clone();
            message["messageId"] = json!(id);
            messages.push(message);
        }
        result.push(json!({"changeId":change.hash().to_string(),"parents":hashes(change.deps()),"provenance":provenance,"messages":messages}));
    }
    Ok(json!(result))
}

fn history(db: &Transaction<'_>, room: &str, doc: &Automerge, options: &Value) -> Result<Value> {
    let after = integer(options, "after", 0, 0, 9_007_199_254_740_991)?;
    let limit = integer(options, "limit", 100, 1, 1000)?;
    let mut query = db.prepare_cached(
        "WITH RECURSIVE reachable(hash) AS (
            SELECT value FROM json_each(?1) UNION SELECT d.value FROM changes c
            JOIN reachable r ON c.hash=r.hash JOIN json_each(c.deps) d WHERE c.room=?2
         ) SELECT c.seq,c.body FROM changes c JOIN reachable r ON c.hash=r.hash
           WHERE c.room=?2 AND c.seq>?3 ORDER BY c.seq LIMIT ?4",
    )?;
    let mut rows = query.query(params![
        serde_json::to_string(&hashes(&doc.get_heads()))?,
        room,
        after as i64,
        limit as i64
    ])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        let change = Change::from_bytes(row.get(1)?)?;
        result.push(
            json!({"cursor":row.get::<_,i64>(0)?,"changeId":change.hash().to_string(),
            "parents":hashes(change.deps()),"provenance":provenance(&change)?}),
        );
    }
    Ok(json!(result))
}

fn resolve(doc: &Automerge, room: &str, input: &Value) -> Result<Value> {
    if input.get("room").is_some_and(|value| value != room) {
        return Err("Anchor belongs to another room".into());
    }
    let id = field(input, "fileId")?;
    shards::validate_id(id, "fileId")?;
    let files = object(doc, &ROOT, "files")?;
    let file = object(doc, &files, id)?;
    let text = object(doc, &file, "text")?;
    let cursor = |name| -> Result<usize> {
        Ok(doc.get_cursor_position(
            text.clone(),
            &automerge::Cursor::try_from(field(input, name)?)?,
            None,
        )?)
    };
    let (start, end) = (cursor("start")?, cursor("end")?);
    let utf16: Vec<_> = doc.text(text)?.encode_utf16().collect();
    let content = String::from_utf16_lossy(utf16.get(start..end).unwrap_or(&[]));
    let deleted = doc
        .get(&file, "deleted")?
        .and_then(|(value, _)| value.as_bool())
        .unwrap_or(false);
    Ok(
        json!({"fileId":id,"path":text_at(doc,&file,"path")?,"deleted":deleted,
        "start":start,"end":end,"text":content}),
    )
}

fn submit(db: &Transaction<'_>, branch: &str, input: &Value, raw: &str) -> Result<Value> {
    let actor = field(input, "actor")?;
    let request_id = field(input, "requestId")?;
    shards::validate_id(actor, "actor")?;
    shards::validate_id(request_id, "requestId")?;
    let operations = input["operations"]
        .as_array()
        .filter(|ops| !ops.is_empty() && ops.len() <= 10_000)
        .ok_or("Expected 1–10000 operations")?
        .iter()
        .map(Operation::parse)
        .collect::<Result<Vec<_>>>()?;
    let expected = documents::parse_heads(&input["expectedHeads"].to_string())
        .map_err(|_| "expectedHeads is required; read before writing")?;
    if let Some((original, result)) = db
        .query_row(
            "SELECT input,result FROM receipts WHERE branch=?1 AND request_id=?2",
            params![branch, request_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if serde_json::from_str::<Value>(&original)? != *input {
            return Err("Request ID reused with different input".into());
        }
        return Ok(serde_json::from_str(&result)?);
    }
    let (room, mut doc) = load(db, branch)?;
    let heads = doc.get_heads();
    if heads != expected {
        return Err("Stale heads; read again or edit an offline branch and merge".into());
    }
    let (event, observed) = shards::observation(db)?;
    let metadata = storage_submit::metadata(input, actor, &operations, &event, &observed)?;
    doc.set_actor(ActorId::random());
    let mut tx = doc.transaction();
    for op in operations {
        if matches!(op.kind, "file.create" | "file.rename") {
            let path = storage_submit::path(op.input)?;
            let collection = object(&tx, &ROOT, "files")?;
            for peer in tx.map_range(collection, ..) {
                if *peer.key == *op.id {
                    continue;
                }
                let peer = peer.id();
                if tx
                    .get(&peer, "deleted")?
                    .and_then(|(value, _)| value.as_bool())
                    != Some(true)
                    && text_at(&tx, &peer, "path")? == path
                {
                    return Err("Path already exists".into());
                }
            }
        }
        let cursors = if op.kind == "comment.add" {
            Some(storage_submit::file_cursor(
                &tx,
                field(op.input, "fileId")?,
                op.input,
                true,
            )?)
        } else {
            None
        };
        storage_submit::apply_operation(&mut tx, op.input, op.kind, op.id, &event, cursors)?;
    }
    let events = object(&tx, &ROOT, "events")?;
    put_json(&mut tx, &events, event.as_str(), &metadata)?;
    tx.commit_with(CommitOptions::default().with_message(serde_json::to_string(&metadata)?));
    let mut result = publish(db, branch, &room, &doc, &heads)?;
    result["eventId"] = json!(event);
    db.execute(
        "INSERT INTO receipts(branch,request_id,input,result) VALUES(?1,?2,?3,?4)",
        params![
            branch,
            request_id,
            storage_submit::compact(raw),
            serde_json::to_string(&result)?
        ],
    )?;
    Ok(result)
}

fn import(db: &Transaction<'_>, branch: &str, bundle: &Value) -> Result<Value> {
    let room = field(bundle, "room")?;
    shards::validate_id(room, "room")?;
    if bundle["protocol"] != "spool/1" || bundle["schema"] != 1 {
        return Err("Unsupported protocol".into());
    }
    let changes = bundle["changes"]
        .as_array()
        .filter(|changes| changes.len() <= 10_000)
        .ok_or("Invalid bundle")?;
    let mut doc = if lookup(db, branch)?.is_some() {
        let (existing, doc) = load(db, branch)?;
        if existing != room {
            return Err("Cannot import unrelated room".into());
        }
        doc
    } else {
        Automerge::new()
    };
    let prior = doc.get_heads();
    let advertised = documents::parse_heads(&bundle["heads"].to_string())?;
    for change in changes {
        let change = change.as_str().ok_or("Invalid encoded change")?;
        doc.apply_changes([Change::from_bytes(STANDARD.decode(change)?)?])?;
    }
    if !doc.get_missing_deps(&advertised).is_empty() {
        return Err("Missing causal dependencies or advertised heads".into());
    }
    let data = serde_json::to_value(AutoSerde::from(&doc))?;
    if data["schema"] != 1
        || data["room"] != room
        || ["files", "messages", "events", "comments"]
            .iter()
            .any(|key| !data[*key].is_object())
    {
        return Err("Invalid document".into());
    }
    for (id, file) in data["files"].as_object().ok_or("Invalid file map")? {
        shards::validate_id(id, "fileId")?;
        storage_submit::path(file)?;
        storage_submit::FileContent::parse(file)?;
    }
    if let Some(events) = data["adapterEvents"].as_object() {
        for (id, event) in events {
            bundles::validate_adapter(event, id)?;
        }
    }
    publish(db, branch, room, &doc, &prior)
}

pub fn execute(
    db: &Transaction<'_>,
    input: &Value,
    raw: Option<&serde_json::value::RawValue>,
) -> Result<Value> {
    let command = field(input, "command")?;
    let branch = input["branch"].as_str().unwrap_or("main");
    match command {
        "init" => {
            if lookup(db, branch)?.is_some() {
                return Err("Branch already exists".into());
            }
            let room = private_files::random_id()?;
            let mut doc = Automerge::new();
            let mut tx = doc.transaction();
            tx.put(ROOT, "schema", 1_i64)?;
            put_text(&mut tx, &ROOT, "room", &room)?;
            for key in ["files", "messages", "events", "comments"] {
                tx.put_object(ROOT, key, ObjType::Map)?;
            }
            tx.commit();
            publish(db, branch, &room, &doc, &[])
        }
        "refs" => {
            let mut query = db.prepare_cached("SELECT name,room,heads FROM refs ORDER BY name")?;
            let mut rows = query.query([])?;
            let mut result = Vec::new();
            while let Some(row) = rows.next()? {
                let heads: Value = serde_json::from_str(&row.get::<_, String>(2)?)?;
                result.push(json!({"branch":row.get::<_,String>(0)?,"room":row.get::<_,String>(1)?,"heads":heads}));
            }
            Ok(json!(result))
        }
        "submit" => submit(
            db,
            branch,
            &input["input"],
            raw.ok_or("Missing submission input")?.get(),
        ),
        "import" => import(db, branch, &input["bundle"]),
        "fork" => {
            let target = field(input, "target")?;
            if lookup(db, target)?.is_some() {
                return Err("Branch already exists".into());
            }
            let (room, doc) = load(db, field(input, "source")?)?;
            publish(db, target, &room, &at(doc, input.get("heads"))?, &[])
        }
        "merge" => {
            let target = field(input, "target")?;
            let (room, mut doc) = load(db, target)?;
            let (other_room, mut other) = load(db, field(input, "source")?)?;
            if room != other_room {
                return Err("Cannot merge unrelated rooms".into());
            }
            let heads = doc.get_heads();
            doc.merge(&mut other)?;
            publish(db, target, &room, &doc, &heads)
        }
        "read" | "file.read" | "history" | "trace" | "anchor" | "resolve" | "export" => {
            let (room, doc) = load(db, branch)?;
            let doc = at(doc, input.get("heads"))?;
            match command {
                "read" => read(&doc, &room, None),
                "file.read" => read(&doc, &room, Some(field(input, "fileId")?)),
                "history" => history(db, &room, &doc, &input["options"]),
                "trace" => trace(&doc, field(input, "fileId")?),
                "anchor" => {
                    let file = field(input, "fileId")?;
                    let (start, end) = storage_submit::file_cursor(&doc, file, input, false)?;
                    Ok(
                        json!({"room":room,"heads":hashes(&doc.get_heads()),"fileId":file,"start":start,"end":end}),
                    )
                }
                "resolve" => resolve(&doc, &room, &input["anchor"]),
                _ => {
                    let base = input
                        .get("since")
                        .map(|s| documents::parse_heads(&s.to_string()))
                        .transpose()?
                        .unwrap_or_default();
                    if !base.is_empty() {
                        doc.fork_at(&base)?;
                    }
                    let changes: Vec<_> = doc
                        .get_changes(&base)
                        .iter()
                        .map(|c| STANDARD.encode(c.raw_bytes()))
                        .collect();
                    Ok(
                        json!({"protocol":"spool/1","schema":1,"room":room,"heads":hashes(&doc.get_heads()),"changes":changes}),
                    )
                }
            }
        }
        _ => Err("Unknown legacy storage command".into()),
    }
}
