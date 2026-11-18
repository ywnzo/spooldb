use crate::{Result, bundle_export, bundles, documents, manifest, private_files, shards};
use automerge::{AutoSerde, Automerge, ObjType, ReadDoc, Value as AmValue};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Map, Value, json};
use std::io::{self, BufRead, Read, Write};
use std::path::Path;

pub(crate) struct Version {
    pub(crate) room: String,
    pub(crate) heads: Vec<String>,
    pub(crate) root: Option<String>,
}

impl Version {
    pub(crate) fn open(db: &Transaction<'_>, branch: &str, heads: Option<&Value>) -> Result<Self> {
        shards::validate_id(branch, "branch")?;
        let (room, frontier, root): (String, String, Option<String>) = db
            .query_row(
                "SELECT room,heads,root FROM shard_refs WHERE name=?1",
                [branch],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or("Unknown branch")?;
        let (heads, root) = if let Some(heads) = heads {
            let requested: Vec<String> = serde_json::from_value(heads.clone())?;
            if requested.is_empty() {
                return Err("A global version must include the room genesis".into());
            }
            bundles::frontier(db, &room, &requested)?
        } else {
            (serde_json::from_str(&frontier)?, root)
        };
        Ok(Self { room, heads, root })
    }

    fn page(&self, mut data: Value) -> Value {
        data["room"] = json!(self.room);
        data["heads"] = json!(self.heads);
        data
    }

    fn publish(&self, db: &Transaction<'_>, branch: &str, new: bool) -> Result<Value> {
        shards::validate_id(branch, "branch")?;
        let encoded = serde_json::to_string(&self.heads)?;
        if new {
            let exists = db
                .query_row("SELECT 1 FROM shard_refs WHERE name=?1", [branch], |_| {
                    Ok(())
                })
                .optional()?
                .is_some();
            if exists {
                return Err("Branch already exists".into());
            }
            db.execute(
                "INSERT INTO shard_refs(name,room,heads,root) VALUES(?1,?2,?3,?4)",
                params![branch, self.room, encoded, self.root],
            )?;
        } else {
            db.execute(
                "UPDATE shard_refs SET heads=?2,root=?3 WHERE name=?1",
                params![branch, encoded, self.root],
            )?;
        }
        db.execute(
            "INSERT OR IGNORE INTO shard_versions(room,frontier,root) VALUES(?1,?2,?3)",
            params![self.room, encoded, self.root],
        )?;
        Ok(self.page(json!({"branch":branch})))
    }
}

pub(crate) fn field<'a>(input: &'a Value, name: &str) -> Result<&'a str> {
    input[name]
        .as_str()
        .ok_or_else(|| format!("Invalid {name}").into())
}

pub(crate) fn integer(
    options: &Value,
    key: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize> {
    match options.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| (minimum..=maximum).contains(value))
            .ok_or_else(|| format!("Invalid {key}").into()),
    }
}

fn part(key: &str) -> Result<(&str, &str)> {
    let (prefix, id) = key.split_once(':').ok_or("Invalid document key")?;
    let field = match prefix {
        "f" => "files",
        "m" => "messages",
        "c" => "comments",
        "a" => "adapterEvents",
        _ => return Err("Unknown document type".into()),
    };
    Ok((field, id))
}

fn value_at(doc: &Automerge, value: AmValue<'_>, id: automerge::ObjId) -> Result<Value> {
    match value {
        AmValue::Scalar(value) => Ok(serde_json::to_value(value)?),
        AmValue::Object(ObjType::Text) => Ok(json!(doc.text(id)?)),
        AmValue::Object(ObjType::Map | ObjType::Table) => {
            let mut result = Map::new();
            for item in doc.map_range(id, ..) {
                let item_id = item.id();
                result.insert(
                    item.key.to_string(),
                    value_at(doc, item.value.into_value(), item_id)?,
                );
            }
            Ok(Value::Object(result))
        }
        AmValue::Object(ObjType::List) => {
            let mut result = Vec::new();
            for item in doc.list_range(id, ..) {
                let item_id = item.id();
                result.push(value_at(doc, item.value.into_value(), item_id)?);
            }
            Ok(Value::Array(result))
        }
    }
}

pub(crate) fn conflict_values(
    doc: &Automerge,
    object: &automerge::ObjId,
    key: &str,
) -> Result<Option<Value>> {
    let alternatives = doc.get_all(object, key)?;
    if alternatives.len() <= 1 {
        return Ok(None);
    }
    let mut values = Map::new();
    for (value, id) in alternatives {
        values.insert(id.to_string(), value_at(doc, value, id)?);
    }
    Ok(Some(Value::Object(values)))
}

fn entity(
    db: &Transaction<'_>,
    version: &Version,
    key: &str,
    descriptor: &Value,
    conflicts: Option<&mut Vec<Value>>,
) -> Result<Value> {
    let (field, id) = part(key)?;
    let heads: Vec<String> = serde_json::from_value(descriptor["heads"].clone())?;
    let doc = documents::load(db, &version.room, key, &heads)?;
    let data = serde_json::to_value(AutoSerde::from(&doc))?;
    let mut value = data[field][id].clone();
    if value.is_null() {
        return Err("Document entity is missing".into());
    }
    if let Some(conflicts) = conflicts {
        let (_, entities) = doc
            .get(automerge::ROOT, field)?
            .ok_or("Missing entity map")?;
        if let Some(values) = conflict_values(&doc, &entities, id)? {
            conflicts.push(json!({"type":"concurrent-entity","key":id,"values":values}));
        }
        if field == "files" {
            let (_, file) = doc.get(entities, id)?.ok_or("Missing file")?;
            for name in ["path", "deleted", "kind", "mode", "data", "target"] {
                if let Some(values) = conflict_values(&doc, &file, name)? {
                    conflicts.push(json!({"type":"concurrent-metadata","fileId":id,"field":name,"values":values}));
                }
            }
        }
    }
    if field == "files" {
        value["fileId"] = json!(id);
    }
    Ok(value)
}

fn collision(path: &str, descriptor: &Value) -> Option<Value> {
    descriptor["files"]
        .as_array()
        .filter(|files| files.len() > 1)
        .map(|files| json!({"type":"path-collision","path":path,"fileIds":files}))
}

fn read(db: &Transaction<'_>, version: &Version, file: Option<&str>) -> Result<Value> {
    let mut conflicts = Vec::new();
    if let Some(id) = file {
        shards::validate_id(id, "fileId")?;
        let key = format!("f:{id}");
        let descriptor = manifest::lookup_root(db, version.root.clone(), &key)?;
        let file = entity(
            db,
            version,
            &key,
            &descriptor["descriptor"],
            Some(&mut conflicts),
        )?;
        if file["deleted"] != true {
            let path = field(&file, "path")?;
            let peers = manifest::lookup_root(db, version.root.clone(), &format!("p:{path}"))?;
            conflicts.extend(collision(path, &peers["descriptor"]));
        }
        return Ok(version.page(json!({"file":file,"conflicts":conflicts})));
    }
    let mut state = json!({"files":[],"messages":{},"comments":{},"adapterEvents":{}});
    let mut paths = Vec::new();
    let mut entries = manifest::entries(db, version.root.clone())?;
    entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    for (key, descriptor) in entries {
        if let Some(path) = key.strip_prefix("p:") {
            paths.extend(collision(path, &descriptor));
            continue;
        }
        let (field, id) = part(&key)?;
        let value = entity(db, version, &key, &descriptor, Some(&mut conflicts))?;
        if field == "files" {
            state[field].as_array_mut().expect("file array").push(value);
        } else {
            state[field][id] = value;
        }
    }
    conflicts.extend(paths);
    state["conflicts"] = json!(conflicts);
    Ok(version.page(state))
}

fn records(db: &Transaction<'_>, version: &Version, options: &Value, files: bool) -> Result<Value> {
    let limit = integer(options, "limit", 100, 1, 1000)?;
    let after = options["after"].as_str().unwrap_or_default();
    let prefix = if files {
        "f:"
    } else {
        match options["kind"].as_str().unwrap_or("messages") {
            "messages" => "m:",
            "comments" => "c:",
            "adapterEvents" => "a:",
            _ => return Err("Invalid record kind".into()),
        }
    };
    let byte_limit = if files {
        usize::MAX
    } else {
        integer(options, "byteLimit", 8 * 1024 * 1024, 1, 16 * 1024 * 1024)?
    };
    let mut entries = manifest::entries(db, version.root.clone())?;
    entries.retain(|(key, descriptor)| {
        key.strip_prefix(prefix).is_some_and(|id| id > after)
            && (!files || options["includeDeleted"] == true || descriptor["deleted"] != true)
    });
    entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let mut bytes = 0;
    let mut records = Vec::new();
    let mut cursor = None;
    for (key, descriptor) in entries.iter().take(limit) {
        let (_, id) = part(key)?;
        let record = if files {
            json!({"fileId":id,"path":descriptor["path"],"deleted":descriptor["deleted"]})
        } else {
            let value = json!({"id":id,"value":entity(db,version,key,descriptor,None)?});
            let size = serde_json::to_vec(&value)?.len();
            if bytes + size > byte_limit {
                if records.is_empty() {
                    return Err("Record exceeds page byte limit".into());
                }
                break;
            }
            bytes += size;
            value
        };
        records.push(record);
        cursor = Some(id);
    }
    let next = if entries.len() > records.len() {
        cursor
    } else {
        None
    };
    Ok(if files {
        version.page(json!({"files":records,"nextCursor":next}))
    } else {
        version.page(json!({"records":records,"bytes":bytes,"nextCursor":next}))
    })
}

fn history(db: &Transaction<'_>, version: &Version, options: &Value) -> Result<Value> {
    let after = integer(options, "after", 0, 0, usize::MAX)?;
    let limit = integer(options, "limit", 100, 1, 1000)?;
    Ok(json!(batch_history(
        db,
        version,
        after,
        limit as i64,
        None
    )?))
}

fn batch_history(
    db: &Transaction<'_>,
    version: &Version,
    after: usize,
    limit: i64,
    file: Option<&str>,
) -> Result<Vec<Value>> {
    let mut query = db.prepare_cached(
        "WITH RECURSIVE reachable(id) AS (
            SELECT value FROM json_each(?1)
            UNION SELECT p.value FROM reachable r JOIN shard_batches b ON b.id=r.id
            CROSS JOIN json_each(b.parents) p WHERE b.room=?2
        )
        SELECT b.seq,b.id,b.parents,b.body FROM reachable r JOIN shard_batches b ON b.id=r.id
        WHERE b.room=?2 AND b.seq>?3
          AND (?5 IS NULL OR EXISTS (SELECT 1 FROM shard_batch_files f
            WHERE f.room=b.room AND f.batch=b.id AND f.file_id=?5))
        ORDER BY b.seq LIMIT ?4",
    )?;
    let mut rows = query.query(params![
        serde_json::to_string(&version.heads)?,
        version.room,
        i64::try_from(after).unwrap_or(i64::MAX),
        limit,
        file
    ])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        let parents: Value = serde_json::from_str(&row.get::<_, String>(2)?)?;
        let metadata = manifest::decode(row.get_ref(3)?)?["metadata"].clone();
        result.push(json!({"cursor":row.get::<_,i64>(0)?,"changeId":row.get::<_,String>(1)?,"parents":parents,"provenance":metadata}));
    }
    Ok(result)
}

fn trace(db: &Transaction<'_>, version: &Version, file: &str) -> Result<Value> {
    shards::validate_id(file, "fileId")?;
    if manifest::lookup_root(db, version.root.clone(), &format!("f:{file}"))?.is_null() {
        return Err("Unknown file".into());
    }
    let mut result = Vec::new();
    for row in batch_history(db, version, 0, -1, Some(file))? {
        let provenance = &row["provenance"];
        let mut ids = std::collections::BTreeSet::new();
        let mut messages = Vec::new();
        for id in provenance["messageIds"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(provenance.get("messageId"))
            .filter_map(Value::as_str)
        {
            if !ids.insert(id) {
                continue;
            }
            let key = format!("m:{id}");
            let item = manifest::lookup_root(db, version.root.clone(), &key)?;
            if !item.is_null() {
                let mut message = entity(db, version, &key, &item["descriptor"], None)?;
                message["messageId"] = json!(id);
                messages.push(message);
            }
        }
        result.push(json!({"changeId":row["changeId"],"parents":row["parents"],"provenance":provenance,"messages":messages}));
    }
    Ok(json!(result))
}

fn anchor(db: &Transaction<'_>, version: &Version, input: &Value, resolve: bool) -> Result<Value> {
    let input = if resolve { &input["anchor"] } else { input };
    if resolve
        && input["room"]
            .as_str()
            .is_some_and(|room| !room.is_empty() && room != version.room)
    {
        return Err("Anchor belongs to another room".into());
    }
    let id = field(input, "fileId")?;
    shards::validate_id(id, "fileId")?;
    let key = format!("f:{id}");
    let descriptor = manifest::lookup_root(db, version.root.clone(), &key)?;
    let heads: Vec<String> = serde_json::from_value(descriptor["descriptor"]["heads"].clone())?;
    let doc = documents::load(db, &version.room, &key, &heads)?;
    let (_, files) = doc
        .get(automerge::ROOT, "files")?
        .ok_or("Missing file map")?;
    let (_, file) = doc.get(files, id)?.ok_or("Missing file")?;
    let (AmValue::Object(ObjType::Text), text_id) =
        doc.get(file.clone(), "text")?.ok_or("File has no text")?
    else {
        return Err("File has no text".into());
    };
    let text = doc.text(text_id.clone())?;
    let utf16: Vec<u16> = text.encode_utf16().collect();
    if resolve {
        let cursor = |name| -> Result<usize> {
            Ok(doc.get_cursor_position(
                text_id.clone(),
                &automerge::Cursor::try_from(field(input, name)?)?,
                None,
            )?)
        };
        let start = cursor("start")?;
        let end = cursor("end")?;
        let content = utf16.get(start..end).unwrap_or(&[]);
        let value = serde_json::to_value(AutoSerde::from(&doc))?;
        return Ok(
            json!({"fileId":id,"path":value["files"][id]["path"],"deleted":value["files"][id]["deleted"],
            "start":start,"end":end,"text":String::from_utf16_lossy(content)}),
        );
    }
    let offset = |name| -> Result<usize> {
        let offset = input[name]
            .as_u64()
            .and_then(|idx| usize::try_from(idx).ok())
            .filter(|idx| *idx <= utf16.len())
            .ok_or("Invalid text position")?;
        if utf16
            .get(offset)
            .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
        {
            return Err("Position splits a surrogate pair".into());
        }
        Ok(offset)
    };
    let start = offset("start")?;
    let end = offset("end")?;
    if start > end {
        return Err("Invalid range".into());
    }
    let position = |offset| {
        if offset == utf16.len() {
            automerge::CursorPosition::End
        } else {
            automerge::CursorPosition::Index(offset)
        }
    };
    Ok(version.page(json!({"fileId":id,
        "start":doc.get_cursor_moving(text_id.clone(),position(start),None,automerge::MoveCursor::After)?.to_string(),
        "end":doc.get_cursor_moving(text_id,position(end),None,automerge::MoveCursor::After)?.to_string()})))
}

fn checkpoint(db: &Transaction<'_>, version: &Version, options: &Value) -> Result<Value> {
    let entries = match options.get("fileId") {
        Some(id) => {
            let id = id.as_str().ok_or("Invalid fileId")?;
            shards::validate_id(id, "fileId")?;
            let key = format!("f:{id}");
            let entry = manifest::lookup_root(db, version.root.clone(), &key)?;
            if entry.is_null() {
                return Err("Unknown file".into());
            }
            vec![(key, entry["descriptor"].clone())]
        }
        None => manifest::entries(db, version.root.clone())?
            .into_iter()
            .filter(|(key, _)| !key.starts_with("p:"))
            .collect(),
    };
    let mut bytes = 0;
    for (key, descriptor) in &entries {
        let heads: Vec<String> = serde_json::from_value(descriptor["heads"].clone())?;
        let doc = documents::load(db, &version.room, key, &heads)?;
        bytes += documents::checkpoint_document(db, &version.room, key, &doc)?;
    }
    Ok(json!({"documents":entries.len(),"bytes":bytes,"heads":version.heads}))
}

fn stats(db: &Transaction<'_>) -> Result<Value> {
    let mut result = json!({"layout":"sharded","cacheHits":0,"documentLoads":0,"checkpointLoads":0,
        "replayedChanges":0,"corruptCheckpoints":0,"activeDocumentHandles":0,"cacheEntries":0,
        "cacheWeightBytes":0,"cacheWeightLimit":0,"cacheEntryLimit":0});
    for (key, query) in [
        ("documents", "SELECT count(*) FROM shard_doc_stats"),
        ("changes", "SELECT count(*) FROM shard_changes"),
        ("checkpoints", "SELECT count(*) FROM shard_checkpoints"),
        ("manifestNodes", "SELECT count(*) FROM shard_nodes"),
        ("batches", "SELECT count(*) FROM shard_batches"),
    ] {
        result[key] = json!(db.query_row(query, [], |row| row.get::<_, i64>(0))?);
    }
    Ok(result)
}

fn compact(db: &mut Connection, options: &Value) -> Result<Value> {
    let vacuum = options["vacuum"] == true;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS live_manifest(hash TEXT PRIMARY KEY); DELETE FROM live_manifest;")?;
    {
        let mut roots = tx.prepare(
            "SELECT root FROM shard_batches WHERE root IS NOT NULL UNION
             SELECT root FROM shard_versions WHERE root IS NOT NULL UNION
             SELECT root FROM shard_refs WHERE root IS NOT NULL",
        )?;
        let mut rows = roots.query([])?;
        let mut mark = tx.prepare("INSERT OR IGNORE INTO temp.live_manifest VALUES(?1)")?;
        while let Some(row) = rows.next()? {
            let mut pending: Vec<String> = vec![row.get(0)?];
            while let Some(hash) = pending.pop() {
                if mark.execute([&hash])? == 0 {
                    continue;
                }
                let node = manifest::load_node(&tx, &hash)?;
                if let Some(children) = node.get("children") {
                    pending.extend(
                        serde_json::from_value::<Vec<Option<String>>>(children.clone())?
                            .into_iter()
                            .flatten(),
                    );
                }
            }
        }
    }
    let removed_nodes = tx.execute(
        "DELETE FROM shard_nodes WHERE hash NOT IN (SELECT hash FROM temp.live_manifest)",
        [],
    )?;
    let mut encoded_rows = 0;
    for (table, column) in [
        ("shard_nodes", "body"),
        ("shard_batches", "body"),
        ("shard_receipts", "input"),
    ] {
        let mut select=tx.prepare(&format!("SELECT rowid,{column} FROM {table} WHERE (?1 IS NULL OR rowid>?1)
            AND typeof({column})='text' AND length(CAST({column} AS BLOB))>=256 ORDER BY rowid LIMIT 8"))?;
        let mut update = tx.prepare(&format!("UPDATE {table} SET {column}=?2 WHERE rowid=?1"))?;
        let mut cursor: Option<i64> = None;
        loop {
            let page = select
                .query_map([cursor], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            if page.is_empty() {
                break;
            }
            for (id, body) in page {
                cursor = Some(id);
                if let rusqlite::types::Value::Blob(encoded) = manifest::encode(&body)? {
                    encoded_rows += update.execute(params![id, encoded])?;
                }
            }
        }
    }
    let removed_checkpoints = tx.execute(
        "DELETE FROM shard_checkpoints WHERE seq IN (SELECT seq FROM (
           SELECT seq,row_number() OVER (PARTITION BY room,doc ORDER BY seq DESC) AS rank
           FROM shard_checkpoints) WHERE rank>2)",
        [],
    )?;
    tx.execute("DELETE FROM temp.live_manifest", [])?;
    tx.commit()?;
    if vacuum {
        db.execute_batch("VACUUM;")?;
    }
    let busy = db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        row.get::<_, i64>(0)
    })?;
    Ok(
        json!({"removedNodes":removed_nodes,"encodedRows":encoded_rows,"removedCheckpoints":removed_checkpoints,"vacuum":vacuum,"walBusy":busy!=0}),
    )
}

fn execute(
    db: &Transaction<'_>,
    input: &Value,
    raw_submission: Option<&serde_json::value::RawValue>,
) -> Result<Value> {
    let command = field(input, "command")?;
    let branch = input["branch"].as_str().unwrap_or("main");
    let options = &input["options"];
    match command {
        "storage.checkpoint" => checkpoint(db, &Version::open(db, branch, None)?, options),
        "storage.stats" => stats(db),
        "storage.clearCache" => Ok(json!({"cleared":true})),
        "submit" => crate::storage_submit::submit(
            db,
            branch,
            &input["input"],
            raw_submission.ok_or("Missing submission input")?.get(),
        ),
        "init" => shards::create_room(db, &private_files::random_id()?, branch),
        "refs" => {
            let mut query =
                db.prepare_cached("SELECT name, room, heads FROM shard_refs ORDER BY name")?;
            let mut rows = query.query([])?;
            let mut refs = Vec::new();
            while let Some(row) = rows.next()? {
                let heads: Value = serde_json::from_str(&row.get::<_, String>(2)?)?;
                refs.push(json!({"branch":row.get::<_,String>(0)?,"room":row.get::<_,String>(1)?,"heads":heads}));
            }
            Ok(json!(refs))
        }
        "read" => read(db, &Version::open(db, branch, input.get("heads"))?, None),
        "file.read" => read(
            db,
            &Version::open(db, branch, input.get("heads"))?,
            Some(field(input, "fileId")?),
        ),
        "files.list" | "records.read" => records(
            db,
            &Version::open(db, branch, None)?,
            options,
            command == "files.list",
        ),
        "history" => history(db, &Version::open(db, branch, None)?, options),
        "trace" => trace(
            db,
            &Version::open(db, branch, None)?,
            field(input, "fileId")?,
        ),
        "anchor" | "resolve" => anchor(
            db,
            &Version::open(db, branch, input.get("heads"))?,
            input,
            command == "resolve",
        ),
        "fork" => Version::open(db, field(input, "source")?, input.get("heads"))?.publish(
            db,
            field(input, "target")?,
            true,
        ),
        "merge" => {
            let target = field(input, "target")?;
            let mut left = Version::open(db, target, None)?;
            let right = Version::open(db, field(input, "source")?, None)?;
            if left.room != right.room {
                return Err("Cannot merge unrelated rooms".into());
            }
            left.heads.extend(right.heads);
            (left.heads, left.root) = bundles::frontier(db, &left.room, &left.heads)?;
            left.publish(db, target, false)
        }
        "export" => {
            let version = Version::open(db, branch, None)?;
            let since: Vec<String> = input
                .get("since")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()?
                .unwrap_or_default();
            bundle_export::export_frontier(
                &bundles::NativeExport(db),
                &version.room,
                &version.heads,
                &since,
            )
        }
        "import" => bundles::import(db, branch, &input["bundle"]),
        _ => Err("Unknown storage command".into()),
    }
}

pub(crate) fn execute_layout(
    db: &Transaction<'_>,
    legacy: bool,
    input: &Value,
    raw_submission: Option<&serde_json::value::RawValue>,
) -> Result<Value> {
    if legacy {
        crate::storage_legacy::execute(db, input, raw_submission)
    } else {
        execute(db, input, raw_submission)
    }
}

pub enum Layout {
    Detect,
    Legacy,
    Sharded,
}

pub(crate) fn open_database(database: &Path, layout: Layout) -> Result<(Connection, bool)> {
    let db = Connection::open(database)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    let has_table = |name| -> rusqlite::Result<bool> {
        Ok(db
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    };
    let sharded = has_table("shard_refs")?;
    let legacy = has_table("refs")?;
    let legacy_data = legacy
        && db
            .query_row("SELECT 1 FROM refs LIMIT 1", [], |_| Ok(()))
            .optional()?
            .is_some();
    let use_legacy = match layout {
        Layout::Detect => !sharded && legacy,
        Layout::Legacy => true,
        Layout::Sharded => false,
    };
    if use_legacy && sharded {
        return Err("This database uses sharded storage".into());
    }
    if !use_legacy && legacy_data {
        return Err(
            "Use a separate database for sharded storage; legacy data is not migrated".into(),
        );
    }
    db.execute_batch(if use_legacy {
        crate::storage_legacy::SCHEMA
    } else {
        include_str!("../shared/shard_schema.sql")
    })?;
    db.execute_batch(crate::git_bridge::SCHEMA)?;
    db.execute_batch(crate::adapter_ingress::SCHEMA)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
    Ok((db, use_legacy))
}

pub fn watch(database: &Path, layout: Layout, root: &Path, interval: u64) -> Result<()> {
    if !(200..=60_000).contains(&interval) {
        return Err("Watch interval must be 200–60000 ms".into());
    }
    let (mut db, legacy) = open_database(database, layout)?;
    let root = std::fs::canonicalize(root)?;
    let request = json!({"command":"git.capture","root":root});
    let mut output = io::stdout().lock();
    let mut first = true;
    loop {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = match crate::git_bridge::run(&tx, legacy, database, &request) {
            Ok(result) => result,
            Err(error) => {
                writeln!(
                    output,
                    "{}",
                    json!({"event":"error","error":error.to_string()})
                )?;
                output.flush()?;
                return Err(error);
            }
        };
        tx.commit()?;
        if result["operations"].as_u64().is_some_and(|count| count > 0) {
            writeln!(output, "{}", json!({"event":"capture","result":result}))?;
        }
        if first {
            writeln!(
                output,
                "{}",
                json!({"event":"watching","root":root,"intervalMs":interval})
            )?;
            first = false;
        }
        output.flush()?;
        std::thread::sleep(std::time::Duration::from_millis(interval));
    }
}

pub fn serve(database: &Path, layout: Layout) -> Result<()> {
    let (mut db, use_legacy) = open_database(database, layout)?;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut bytes = Vec::new();
        if (&mut input)
            .take(16_000_002)
            .read_until(b'\n', &mut bytes)?
            == 0
        {
            break;
        }
        if bytes.len() > 16_000_001 || (bytes.len() == 16_000_001 && bytes.last() != Some(&b'\n')) {
            writeln!(
                output,
                "{}",
                json!({"id":null,"ok":false,"error":"Request too large"})
            )?;
            if bytes.last() != Some(&b'\n') {
                input.skip_until(b'\n')?;
            }
        } else {
            let mut id = Value::Null;
            let result = (|| -> Result<Value> {
                let value: Value = serde_json::from_slice(&bytes)?;
                id = value["id"].clone();
                if matches!(
                    value["command"].as_str(),
                    Some("snapshot.create" | "snapshot.recover" | "snapshot.list")
                ) {
                    return crate::snapshots::run(&mut db, use_legacy, &value);
                }
                if !use_legacy && value["command"] == "storage.compact" {
                    return compact(&mut db, &value["options"]);
                }
                if matches!(
                    value["command"].as_str(),
                    Some("git.attach" | "git.capture" | "git.sources")
                ) {
                    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let result = crate::git_bridge::run(&tx, use_legacy, database, &value)?;
                    tx.commit()?;
                    return Ok(result);
                }
                if matches!(
                    value["command"].as_str(),
                    Some("adapter.open" | "adapter.ingest" | "adapter.close" | "adapter.streams")
                ) {
                    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let result = crate::adapter_ingress::run(&tx, use_legacy, &value)?;
                    tx.commit()?;
                    return Ok(result);
                }
                let mode = if matches!(
                    value["command"].as_str(),
                    Some(
                        "init"
                            | "submit"
                            | "fork"
                            | "merge"
                            | "import"
                            | "export"
                            | "storage.checkpoint"
                    )
                ) || value.get("heads").is_some()
                {
                    TransactionBehavior::Immediate
                } else {
                    TransactionBehavior::Deferred
                };
                let tx = db.transaction_with_behavior(mode)?;
                #[derive(serde::Deserialize)]
                struct Submission<'a> {
                    #[serde(borrow)]
                    input: &'a serde_json::value::RawValue,
                }
                let raw_submission = if value["command"] == "submit" {
                    Some(serde_json::from_slice::<Submission<'_>>(&bytes)?.input)
                } else {
                    None
                };
                let result = execute_layout(&tx, use_legacy, &value, raw_submission)?;
                tx.commit()?;
                Ok(result)
            })();
            writeln!(
                output,
                "{}",
                match result {
                    Ok(result) => json!({"id":id,"ok":true,"result":result}),
                    Err(error) => json!({"id":id,"ok":false,"error":error.to_string()}),
                }
            )?;
        }
        output.flush()?;
    }
    Ok(())
}
