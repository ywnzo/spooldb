use crate::{
    bundle_export::{self, ExportStore},
    memory_mutation::Backend,
    memory_write::{Fault, bad},
};
use automerge::{AutoSerde, ReadDoc};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

type Result<T> = std::result::Result<T, Fault>;
fn internal<E>(_: E) -> Fault {
    Fault(500, "INTERNAL", "Review unavailable".to_owned())
}
fn missing(code: &'static str, text: &str) -> Fault {
    Fault(404, code, text.to_owned())
}
const LIMIT: u64 = 9_007_199_254_740_991;

const SCHEMA: [&str; 2] = [
    "CREATE TABLE IF NOT EXISTS relay_review_branches(room TEXT NOT NULL,name TEXT NOT NULL,heads TEXT NOT NULL,revision INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(room,name))",
    "CREATE TABLE IF NOT EXISTS relay_review_publications(room TEXT NOT NULL,principal TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(room,principal,request_id))",
];

pub fn initialize(db: &impl Backend) -> Result<()> {
    for statement in SCHEMA {
        db.execute(statement, &[])?;
    }
    Ok(())
}

fn page(value: &Value, default: u64, min: u64, max: u64) -> Option<u64> {
    if value.is_null() {
        Some(default)
    } else {
        value.as_u64().filter(|n| *n >= min && *n <= max)
    }
}
fn heads(value: &Value, required: bool) -> Result<Vec<String>> {
    let parsed: Vec<String> = serde_json::from_value(value.clone())
        .map_err(|_| bad("INVALID_FRONTIER", "Expected causal heads"))?;
    if parsed.len() > 128
        || required && parsed.is_empty()
        || !parsed.iter().all(|h| {
            h.len() == 64
                && h.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err(bad("INVALID_FRONTIER", "Expected causal heads"));
    }
    Ok(parsed)
}
fn branch_name(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| {
            s.len() <= 128
                && s.as_bytes().split_first().is_some_and(|(first, tail)| {
                    first.is_ascii_alphanumeric()
                        && tail
                            .iter()
                            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(b))
                })
        })
        .ok_or_else(|| bad("INVALID_BRANCH", "Invalid review branch name"))
}
struct Version {
    heads: Vec<String>,
    root: Option<String>,
}

fn version(
    db: &impl Backend,
    store: &impl ExportStore,
    room: &str,
    branch: Option<&Value>,
    requested: Option<&Value>,
) -> Result<Version> {
    let mut frontier = if let Some(branch) = branch.filter(|branch| **branch != "@live") {
        let name = branch_name(branch)?;
        let stored = db.query(
            "SELECT heads FROM relay_review_branches WHERE room=?1 AND name=?2",
            &[room, name],
        )?;
        serde_json::from_str(
            stored
                .first()
                .ok_or_else(|| missing("BRANCH_NOT_FOUND", "Review branch not found"))?,
        )
        .map_err(internal)?
    } else {
        store
            .branch_heads(room, &format!("relay-{room}"))
            .map_err(internal)?
    };
    if let Some(requested) = requested {
        let selected = heads(requested, true)?;
        let available = store
            .batches(room, &frontier)
            .map_err(internal)?
            .into_iter()
            .map(|(id, _)| id)
            .collect::<BTreeSet<_>>();
        if !selected.iter().all(|id| available.contains(id)) {
            return Err(missing(
                "REVISION_NOT_FOUND",
                "Revision is outside this branch",
            ));
        }
        frontier = selected;
    }
    let (heads, root) = store.frontier(room, &frontier).map_err(internal)?;
    Ok(Version { heads, root })
}

fn text_preview(text: &str, max: usize) -> (String, bool) {
    let mut units = text.encode_utf16();
    let limited = units.by_ref().take(max).collect::<Vec<_>>();
    (String::from_utf16_lossy(&limited), units.next().is_some())
}

fn record(
    store: &impl ExportStore,
    version: &Version,
    room: &str,
    key: &str,
    field: &str,
) -> Result<Option<Value>> {
    let desc = store.lookup(version.root.clone(), key).map_err(internal)?;
    if desc.is_null() {
        return Ok(None);
    }
    let heads: Vec<String> =
        serde_json::from_value(desc["descriptor"]["heads"].clone()).map_err(internal)?;
    let doc = store.document(room, key, &heads).map_err(internal)?;
    let value = serde_json::to_value(AutoSerde::from(&doc)).map_err(internal)?;
    Ok(Some(value[field][&key[2..]].clone()))
}

pub fn run(
    db: &impl Backend,
    store: &impl ExportStore,
    room: &str,
    principal: &str,
    input: &Value,
    references_only: bool,
) -> Result<Value> {
    initialize(db)?;
    let command = input["command"].as_str().unwrap_or_default();
    if command == "branches" {
        let head = store
            .branch_heads(room, &format!("relay-{room}"))
            .map_err(internal)?;
        let mut branches = vec![
            json!({"name":"@live","label":"Synced room","heads":head,"revision":0,"live":true}),
        ];
        for row in db.query("SELECT json_object('name',name,'heads',json(heads),'revision',revision,
            'updatedBy',updated_by,'updatedAt',updated_at,'live',json('false')) FROM relay_review_branches WHERE room=?1 ORDER BY name",&[room])? {
            branches.push(serde_json::from_str(&row).map_err(internal)?);
        }
        return Ok(json!({"branches":branches}));
    }
    if command == "publish" {
        if references_only {
            return Err(Fault(
                403,
                "GIT_ONLY",
                "Code branches stay in Git".to_owned(),
            ));
        }
        return publish(db, store, room, principal, input);
    }
    let active = version(db, store, room, input.get("branch"), input.get("heads"))?;
    match command {
        "timeline" => timeline(db, store, room, input, &active),
        "message" => {
            let id = input["messageId"]
                .as_str()
                .filter(|id| id.encode_utf16().count() <= 200)
                .ok_or_else(|| bad("INVALID_MESSAGE", "Invalid message identity"))?;
            let message = record(store, &active, room, &format!("m:{id}"), "messages")?
                .ok_or_else(|| missing("MESSAGE_NOT_FOUND", "Message not found"))?;
            Ok(json!({"message":message}))
        }
        "files" => files(db, store, room, input, &active),
        "file" | "diff" => file_response(db, store, room, input, &active),
        _ => Err(bad("INVALID_REVIEW", "Unknown review command")),
    }
}

fn publish(
    db: &impl Backend,
    store: &impl ExportStore,
    room: &str,
    principal: &str,
    input: &Value,
) -> Result<Value> {
    let name = branch_name(&input["name"])?;
    let selected = heads(&input["heads"], true)?;
    let revision = input["expectedRevision"]
        .as_u64()
        .filter(|r| *r < LIMIT)
        .ok_or_else(|| bad("INVALID_REVISION", "Expected revision is required"))?;
    let request = input["requestId"]
        .as_str()
        .filter(|r| {
            r.len() <= 200
                && r.as_bytes().split_first().is_some_and(|(head, tail)| {
                    head.is_ascii_alphanumeric()
                        && tail
                            .iter()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(b))
                })
        })
        .ok_or_else(|| {
            bad(
                "INVALID_REQUEST_ID",
                "A publication request identity is required",
            )
        })?;
    version(db, store, room, None, Some(&input["heads"]))?;
    let mut sorted = selected.clone();
    sorted.sort();
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(json!({"name":name,"heads":sorted,"expectedRevision":revision}).to_string())
    );
    if let Some(row)=db.query("SELECT json_array(input,result) FROM relay_review_publications WHERE room=?1 AND principal=?2 AND request_id=?3",&[room,principal,request])?.first(){
        let (prior,result):(String,String)=serde_json::from_str(row).map_err(internal)?;
        if prior!=fingerprint{return Err(Fault(409,"REQUEST_CONFLICT","Publication request identity was reused with different input".to_owned()));}
        return serde_json::from_str(&result).map_err(internal);
    }
    let current = db.query(
        "SELECT CAST(revision AS TEXT) FROM relay_review_branches WHERE room=?1 AND name=?2",
        &[room, name],
    )?;
    let current = current
        .first()
        .map(|n| n.parse::<u64>())
        .transpose()
        .map_err(internal)?
        .unwrap_or(0);
    if current != revision {
        return Err(Fault(
            409,
            "BRANCH_CONFLICT",
            "Branch changed; read its revision before publishing again".to_owned(),
        ));
    }
    let (_, at) = db.observation()?;
    let revision = revision + 1;
    db.execute("INSERT INTO relay_review_branches VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(room,name) DO UPDATE SET heads=excluded.heads,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
        &[room,name,&json!(selected).to_string(),&revision.to_string(),principal,&at])?;
    let result = json!({"name":name,"heads":selected,"revision":revision,"updatedBy":principal,"updatedAt":at});
    db.execute(
        "INSERT INTO relay_review_publications VALUES(?1,?2,?3,?4,?5)",
        &[room, principal, request, &fingerprint, &result.to_string()],
    )?;
    Ok(result)
}

fn timeline(
    db: &impl Backend,
    store: &impl ExportStore,
    room: &str,
    input: &Value,
    version: &Version,
) -> Result<Value> {
    let before = page(&input["before"], LIMIT, 1, LIMIT)
        .ok_or_else(|| bad("INVALID_CURSOR", "Invalid history page"))?;
    let limit = page(&input["limit"], 25, 1, 50)
        .ok_or_else(|| bad("INVALID_CURSOR", "Invalid history page"))? as usize;
    let rows=db.query("WITH RECURSIVE reach(id) AS (
        SELECT value FROM json_each(?1) UNION SELECT p.value FROM reach r JOIN shard_batches b ON b.id=r.id
        CROSS JOIN json_each(b.parents) p WHERE b.room=?2
      ) SELECT json_array(b.seq,b.id) FROM reach r JOIN shard_batches b ON b.id=r.id WHERE b.room=?2
        AND b.seq<CAST(?3 AS INTEGER) ORDER BY b.seq DESC LIMIT CAST(?4 AS INTEGER)",
        &[&json!(version.heads).to_string(),room,&before.to_string(),&(limit+1).to_string()])?;
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    let mut count = 0;
    for row in rows.iter().take(limit) {
        let (seq, id): (u64, String) = serde_json::from_str(row).map_err(internal)?;
        let batch = store.batch(room, &id).map_err(internal)?;
        let raw = &batch["metadata"];
        let mut metadata = Value::Null;
        if raw.is_object() {
            metadata = json!({"actor":preview_field(raw,"actor","unknown"),"harness":preview_field(raw,"harness","unknown"),
                "observedAt":preview_field(raw,"observedAt",""),"fileIds":strings(&raw["fileIds"]).take(100).collect::<Vec<_>>()});
            let mut types = BTreeSet::new();
            metadata["operationTypes"] = json!(
                strings(&raw["operationTypes"])
                    .filter(|item| types.insert(*item))
                    .take(50)
                    .collect::<Vec<_>>()
            );
            for key in ["sessionId", "evidence", "sourceEventId"] {
                if raw[key].is_string() {
                    metadata[key] = json!(preview_field(raw, key, ""));
                }
            }
            let mut paths = json!({});
            for file in strings(&raw["fileIds"]).take(100) {
                let desc = store
                    .lookup(version.root.clone(), &format!("f:{file}"))
                    .map_err(internal)?;
                paths[file] = json!(preview_field(&desc["descriptor"], "path", file));
            }
            metadata["paths"] = paths;
        }
        let mut unique = BTreeSet::new();
        let ids = strings(&raw["messageIds"])
            .chain(raw["messageId"].as_str())
            .filter(|id| unique.insert(*id))
            .collect::<Vec<_>>();
        let mut messages = Vec::new();
        for id in ids.iter().take(16) {
            if count >= 50 || !seen.insert((*id).to_owned()) {
                continue;
            }
            if let Some(mut message) = record(store, version, room, &format!("m:{id}"), "messages")?
            {
                count += 1;
                let (text, truncated) =
                    text_preview(message["text"].as_str().unwrap_or_default(), 12000);
                message["id"] = json!(id);
                message["text"] = json!(text);
                message["truncated"] = json!(truncated);
                messages.push(message);
            }
        }
        entries.push(
            json!({"cursor":seq,"changeId":id,"parents":batch["parents"],"metadata":metadata,
            "messages":messages,"partial":ids.len()>16||count>=50}),
        );
    }
    let next = if rows.len() > limit {
        entries.last().map(|entry| entry["cursor"].clone())
    } else {
        None
    };
    Ok(json!({"entries":entries,"nextCursor":next,"heads":version.heads}))
}

fn preview_field(value: &Value, key: &str, default: &str) -> String {
    text_preview(value[key].as_str().unwrap_or(default), 200).0
}
fn strings(value: &Value) -> impl Iterator<Item = &str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| s.encode_utf16().count() <= 200)
}

fn descriptors(store: &impl ExportStore, version: &Version) -> Result<BTreeMap<String, Value>> {
    let mut nodes = Vec::new();
    bundle_export::reachable_nodes(
        store,
        &json!({"root":version.root}),
        &mut BTreeSet::new(),
        &mut nodes,
    )
    .map_err(internal)?;
    let mut files = BTreeMap::new();
    for (_, node) in nodes {
        if let Some(entries) = node.get("entries") {
            let values: Vec<(String, Value)> =
                serde_json::from_value(entries.clone()).map_err(internal)?;
            files.extend(values.into_iter().filter_map(|(key, value)| {
                key.strip_prefix("f:").map(|id| (id.to_owned(), value))
            }));
        }
    }
    Ok(files)
}

fn files(
    db: &impl Backend,
    store: &impl ExportStore,
    room: &str,
    input: &Value,
    active: &Version,
) -> Result<Value> {
    let limit = page(&input["limit"], 100, 1, 200)
        .ok_or_else(|| bad("INVALID_LIMIT", "Invalid page limit"))? as usize;
    let after = input
        .get("after")
        .map(|v| {
            v.as_str()
                .ok_or_else(|| bad("INVALID_CURSOR", "Invalid file cursor"))
        })
        .transpose()?
        .unwrap_or_default();
    let query = input
        .get("query")
        .map(|v| {
            v.as_str()
                .filter(|s| s.encode_utf16().count() <= 200)
                .ok_or_else(|| bad("INVALID_QUERY", "Invalid file search"))
        })
        .transpose()?
        .unwrap_or_default()
        .to_lowercase();
    let base = comparison(db, store, room, input)?;
    let current = descriptors(store, active)?;
    let previous = base
        .as_ref()
        .map(|base| descriptors(store, base))
        .transpose()?
        .unwrap_or_default();
    let ids = current
        .keys()
        .chain(previous.keys())
        .collect::<BTreeSet<_>>();
    let mut rows = Vec::new();
    let mut total = 0;
    for id in ids {
        let old = previous.get(id);
        let new = current.get(id);
        let path = new
            .or(old)
            .and_then(|item| item["path"].as_str())
            .ok_or_else(|| internal("missing file path"))?;
        let was = old.is_some_and(|item| item["deleted"] != true);
        let present = new.is_some_and(|item| item["deleted"] != true);
        let status = match (base.is_some(), was, present) {
            (false, _, _) => "present",
            (_, false, true) => "added",
            (_, true, false) => "deleted",
            (_, false, false) => "unchanged",
            _ if old.map(|item| &item["path"]) != new.map(|item| &item["path"]) => "renamed",
            _ if old.map(|item| &item["heads"]) != new.map(|item| &item["heads"]) => "modified",
            _ => "unchanged",
        };
        if base.is_none() && !present
            || id.as_str() <= after
            || !path.to_lowercase().contains(&query)
            || input["changedOnly"] == true && status == "unchanged"
        {
            continue;
        }
        total += 1;
        if rows.len() < limit {
            let mut row = json!({"fileId":id,"path":path,"status":status,"deleted":!present});
            if let Some(old) = old {
                row["previousPath"] = old["path"].clone();
            }
            rows.push(row);
        }
    }
    let next = if total > limit {
        rows.last().map(|row| row["fileId"].clone())
    } else {
        None
    };
    Ok(json!({"heads":active.heads,"files":rows,"nextCursor":next,"total":total}))
}

fn comparison(
    db: &impl Backend,
    store: &impl ExportStore,
    room: &str,
    input: &Value,
) -> Result<Option<Version>> {
    Ok(if let Some(heads_input) = input.get("baseHeads") {
        let requested = heads(heads_input, false)?;
        let (heads, root) = store.frontier(room, &requested).map_err(internal)?;
        Some(Version { heads, root })
    } else if let Some(compare) = input
        .get("compare")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    {
        Some(version(db, store, room, Some(compare), None)?)
    } else {
        None
    })
}

fn file_response(
    db: &impl Backend,
    store: &impl ExportStore,
    room: &str,
    input: &Value,
    active: &Version,
) -> Result<Value> {
    let id = input["fileId"]
        .as_str()
        .filter(|id| id.encode_utf16().count() <= 200)
        .ok_or_else(|| bad("INVALID_FILE", "Invalid file identity"))?;
    let current = record(store, active, room, &format!("f:{id}"), "files")?;
    let base = comparison(db, store, room, input)?;
    let before = base
        .as_ref()
        .map(|base| record(store, base, room, &format!("f:{id}"), "files"))
        .transpose()?
        .flatten();
    let file = current
        .as_ref()
        .or(before.as_ref())
        .ok_or_else(|| missing("FILE_NOT_FOUND", "File not found in either version"))?;
    let mut response = if input["command"] == "file" {
        let mut metadata = file_meta(
            store,
            if current.is_some() {
                active
            } else {
                base.as_ref().ok_or_else(|| internal("no base"))?
            },
            id,
            Some(file),
        )?;
        let full = file["text"].as_str().unwrap_or_default();
        let text = if file["kind"] == "text" {
            text_preview(full, 200_000)
                .0
                .split('\n')
                .take(2_000)
                .collect::<Vec<_>>()
                .join(
                    "
",
                )
        } else {
            String::new()
        };
        let truncated = file["kind"] == "text" && text != full;
        metadata["text"] = json!(text);
        json!({"file":metadata,"previewFrom":if current.is_some(){"target"}else{"base"},"truncated":truncated})
    } else {
        let non_text = [before.as_ref(), current.as_ref()]
            .into_iter()
            .flatten()
            .any(|file| file["deleted"] != true && file["kind"] != "text");
        let text = |file: Option<&Value>| {
            file.filter(|file| file["deleted"] != true)
                .and_then(|file| file["text"].as_str())
                .unwrap_or_default()
                .to_owned()
        };
        let mut diff = if non_text {
            json!({"rows":[],"added":null,"removed":null,"nonText":true,"truncated":false})
        } else {
            crate::review_diff::line_diff(&text(before.as_ref()), &text(current.as_ref()))
        };
        diff["before"] = file_meta(store, base.as_ref().unwrap_or(active), id, before.as_ref())?;
        diff["after"] = file_meta(store, active, id, current.as_ref())?;
        diff
    };
    let (comments, partial) = comments(store, active, room, id)?;
    response["comments"] = json!(comments);
    response["partial"] = json!(partial);
    response["heads"] = json!(active.heads);
    Ok(response)
}

fn file_meta(
    store: &impl ExportStore,
    version: &Version,
    id: &str,
    file: Option<&Value>,
) -> Result<Value> {
    let Some(file) = file else {
        return Ok(Value::Null);
    };
    let mut meta = json!({"fileId":id,"conflicts":[]});
    for field in ["path", "kind", "mode", "deleted", "target"] {
        if let Some(value) = file.get(field) {
            meta[field] = value.clone();
        }
    }
    if file["kind"] == "binary" {
        let bytes = STANDARD
            .decode(file["data"].as_str().unwrap_or_default())
            .map_err(internal)?
            .len();
        meta["bytes"] = json!(bytes);
    }
    if file["deleted"] != true
        && let Some(path) = file["path"].as_str()
    {
        let index = store
            .lookup(version.root.clone(), &format!("p:{path}"))
            .map_err(internal)?;
        if let Some(peers) = index["descriptor"]["files"]
            .as_array()
            .filter(|peers| peers.len() > 1)
        {
            meta["conflicts"] = json!([{"type":"path-collision","path":path,"fileIds":peers}]);
        }
    }
    Ok(meta)
}

fn comments(
    store: &impl ExportStore,
    version: &Version,
    room: &str,
    id: &str,
) -> Result<(Vec<Value>, bool)> {
    let mut nodes = Vec::new();
    bundle_export::reachable_nodes(
        store,
        &json!({"root":version.root}),
        &mut BTreeSet::new(),
        &mut nodes,
    )
    .map_err(internal)?;
    let keys: Vec<_> = nodes
        .iter()
        .flat_map(|(_, node)| node["entries"].as_array().into_iter().flatten())
        .filter_map(|entry| entry[0].as_str())
        .filter(|key| key.starts_with("c:"))
        .collect();
    let mut results = Vec::new();
    let file_key = format!("f:{id}");
    let mut file_doc = None;
    for key in keys.iter().take(200) {
        let Some(mut comment) = record(store, version, room, key, "comments")? else {
            continue;
        };
        if comment["fileId"] != id {
            continue;
        }
        if file_doc.is_none() {
            let desc = store
                .lookup(version.root.clone(), &file_key)
                .map_err(internal)?;
            if !desc.is_null() {
                let heads: Vec<String> =
                    serde_json::from_value(desc["descriptor"]["heads"].clone())
                        .map_err(internal)?;
                file_doc = Some(store.document(room, &file_key, &heads).map_err(internal)?);
            }
        }
        let resolved = file_doc
            .as_ref()
            .and_then(|doc| resolve_comment(doc, id, &comment).ok())
            .unwrap_or(Value::Null);
        let (text, truncated) = text_preview(comment["text"].as_str().unwrap_or_default(), 12000);
        comment["id"] = json!(&key[2..]);
        comment["text"] = json!(text);
        comment["truncated"] = json!(truncated);
        comment["resolved"] = resolved;
        results.push(comment);
    }
    Ok((results, keys.len() > 200))
}

fn resolve_comment(
    doc: &automerge::Automerge,
    id: &str,
    comment: &Value,
) -> std::result::Result<Value, Box<dyn std::error::Error>> {
    let (_, files) = doc.get(automerge::ROOT, "files")?.ok_or("missing files")?;
    let (_, file) = doc.get(files, id)?.ok_or("missing file")?;
    let (_, text) = doc.get(file, "text")?.ok_or("missing text")?;
    let cursor =
        |field: &str| -> std::result::Result<automerge::Cursor, Box<dyn std::error::Error>> {
            Ok(automerge::Cursor::try_from(
                comment[field].as_str().ok_or("missing cursor")?,
            )?)
        };
    let start = doc.get_cursor_position(&text, &cursor("start")?, None)?;
    let end = doc.get_cursor_position(&text, &cursor("end")?, None)?;
    let full = doc.text(&text)?;
    let utf16 = full
        .encode_utf16()
        .skip(start)
        .take(end.saturating_sub(start).min(300))
        .collect::<Vec<_>>();
    let value = serde_json::to_value(AutoSerde::from(doc))?;
    Ok(
        json!({"fileId":id,"path":value["files"][id]["path"],"deleted":value["files"][id]["deleted"],
        "start":start,"end":end,"text":String::from_utf16_lossy(&utf16)}),
    )
}
