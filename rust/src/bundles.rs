use crate::{
    Result,
    bundle_export::{self, ExportStore},
    documents, manifest,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Transaction, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

fn batches(db: &Transaction<'_>, room: &str, heads: &[String]) -> Result<Vec<(String, Value)>> {
    let mut statement = db.prepare_cached(
        "WITH RECURSIVE reachable(id) AS (
           SELECT value FROM json_each(?1)
           UNION
           SELECT p.value FROM reachable r JOIN shard_batches b ON b.id=r.id
             CROSS JOIN json_each(b.parents) p WHERE b.room=?2
         )
         SELECT r.id,b.body FROM reachable r LEFT JOIN shard_batches b
         ON b.room=?2 AND b.id=r.id ORDER BY b.seq",
    )?;
    let mut rows = statement.query(params![serde_json::to_string(heads)?, room])?;
    let mut batches = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let body = manifest::decode(row.get_ref(1)?)?;
        // Batch keys and metadata keys are ASCII. Dynamic identifiers are values.
        if body["room"] != room
            || body["schema"] != 2
            || format!("{:x}", Sha256::digest(serde_json::to_vec(&body)?)) != id
        {
            return Err("Invalid batch hash or room".into());
        }
        batches.push((id, body));
    }
    Ok(batches)
}

pub fn export(
    db: &Transaction<'_>,
    room: &str,
    branch: &str,
    mut since: Vec<String>,
) -> Result<Value> {
    if since.len() > 128 {
        return Err("Invalid sync frontier".into());
    }
    since.sort_unstable();
    since.dedup();
    let heads = branch_heads(db, room, branch)?;
    bundle_export::export_frontier(&NativeExport(db), room, &heads, &since)
}

fn branch_heads(db: &Transaction<'_>, room: &str, branch: &str) -> Result<Vec<String>> {
    let head_json: String = db.query_row(
        "SELECT heads FROM shard_refs WHERE name=?1 AND room=?2",
        params![branch, room],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(&head_json)?)
}

pub(crate) fn string_field<'a>(value: &'a Value, field: &str, max: usize) -> Result<&'a str> {
    value[field]
        .as_str()
        .filter(|s| s.encode_utf16().count() <= max)
        .ok_or_else(|| format!("Invalid {field}").into())
}

pub(crate) fn descriptor(key: &str, doc: &automerge::Automerge) -> Result<Value> {
    let (kind, id) = key.split_once(':').ok_or("Invalid document key")?;
    let field = match kind {
        "m" => "messages",
        "f" => "files",
        "c" => "comments",
        "a" => "adapterEvents",
        _ => return Err("Unsupported document type".into()),
    };
    let data = serde_json::to_value(automerge::AutoSerde::from(doc))?;
    let entity = &data[field][id];
    let heads: Vec<_> = doc.get_heads().iter().map(ToString::to_string).collect();
    let value = match kind {
        "m" => {
            if !matches!(
                entity["role"].as_str(),
                Some("user" | "assistant" | "tool" | "system")
            ) {
                return Err("Invalid message role".into());
            }
            string_field(entity, "text", 1_000_000)?;
            json!({"heads": heads})
        }
        "c" => {
            crate::shards::validate_id(string_field(entity, "fileId", 200)?, "fileId")?;
            string_field(entity, "start", 1_000_000)?;
            string_field(entity, "end", 1_000_000)?;
            string_field(entity, "text", 1_000_000)?;
            json!({"heads": heads})
        }
        "a" => {
            validate_adapter(entity, id)?;
            json!({"heads": heads})
        }
        "f" => {
            let path = string_field(entity, "path", 4096)?;
            if path.chars().any(|c| c <= '\u{1f}' || c == ':' || c == '\\')
                || path.split('/').any(|part| {
                    part.is_empty()
                        || part == "."
                        || part == ".."
                        || part.eq_ignore_ascii_case(".git")
                })
            {
                return Err("Unsafe file path".into());
            }
            if !entity["mode"].is_null() && !matches!(entity["mode"].as_i64(), Some(420 | 493)) {
                return Err("Invalid file mode".into());
            }
            match entity["kind"].as_str() {
                Some("text") | None if entity["kind"].is_null() || entity["kind"] == "text" => {
                    string_field(entity, "text", 1_000_000)?;
                }
                Some("binary") => {
                    let data = STANDARD.decode(string_field(entity, "data", 1_400_000)?)?;
                    if data.len() > 1_000_000 {
                        return Err("Invalid binary data".into());
                    }
                }
                Some("symlink") => {
                    let target = string_field(entity, "target", 4096)?;
                    if target.is_empty() || target.contains('\0') {
                        return Err("Invalid symlink target".into());
                    }
                }
                _ => return Err("Invalid file kind".into()),
            }
            let deleted = entity["deleted"]
                .as_bool()
                .ok_or("Invalid file deletion state")?;
            json!({"heads": heads, "path": path, "deleted": deleted})
        }
        _ => unreachable!(),
    };
    Ok(value)
}

pub(crate) fn validate_adapter(entity: &Value, id: &str) -> Result<()> {
    use std::sync::OnceLock;

    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        let schema = serde_json::from_str(include_str!("../../schemas/adapter-event.schema.json"))
            .expect("bundled adapter event schema is JSON");
        jsonschema::validator_for(&schema).expect("bundled adapter event schema compiles")
    });
    if !validator.is_valid(entity)
        || entity["eventId"] != id
        || serde_json::to_string(entity)?.encode_utf16().count() > 1_000_000
        || ["sequence", "part"].iter().any(|key| {
            entity[*key]
                .as_u64()
                .is_none_or(|n| n > 9_007_199_254_740_991)
        })
    {
        return Err("Invalid adapter event".into());
    }
    Ok(())
}

pub(crate) fn set_descriptor(
    db: &Transaction<'_>,
    mut root: Option<String>,
    key: &str,
    desc: Value,
) -> Result<Option<String>> {
    if let Some(id) = key.strip_prefix("f:") {
        let current = manifest::lookup_root(db, root.clone(), key)?;
        let previous = &current["descriptor"];
        if previous["path"] != desc["path"] || previous["deleted"] != desc["deleted"] {
            for (item, add) in [(previous, false), (&desc, true)] {
                if item["deleted"] != false {
                    continue;
                }
                let path = item["path"].as_str().ok_or("Invalid manifest path")?;
                let path_key = format!("p:{path}");
                let entry = manifest::lookup_root(db, root.clone(), &path_key)?;
                let mut files: BTreeSet<String> = if entry.is_null() {
                    BTreeSet::new()
                } else {
                    serde_json::from_value(entry["descriptor"]["files"].clone())?
                };
                if add {
                    files.insert(id.to_owned());
                } else {
                    files.remove(id);
                }
                root = manifest::set(
                    db,
                    root.as_deref(),
                    &path_key,
                    (!files.is_empty()).then(|| json!({"files": files})),
                )?;
            }
        }
    }
    manifest::set(db, root.as_deref(), key, Some(desc))
}

pub(crate) fn frontier(
    db: &Transaction<'_>,
    room: &str,
    requested: &[String],
) -> Result<(Vec<String>, Option<String>)> {
    if requested.len() <= 1 {
        let root = requested
            .first()
            .map(|head| {
                db.query_row(
                    "SELECT root FROM shard_batches WHERE room=?1 AND id=?2",
                    params![room, head],
                    |row| row.get(0),
                )
            })
            .transpose()?
            .flatten();
        return Ok((requested.to_vec(), root));
    }
    let history = batches(db, room, requested)?;
    let covered: BTreeSet<String> = history
        .iter()
        .map(|(_, batch)| serde_json::from_value::<Vec<String>>(batch["parents"].clone()))
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect();
    let distinct: BTreeSet<_> = requested
        .iter()
        .filter(|id| !covered.contains(*id))
        .cloned()
        .collect();
    let heads: Vec<_> = distinct.into_iter().collect();
    use rusqlite::OptionalExtension;
    let stored: Option<Option<String>> = db
        .query_row(
            "SELECT root FROM shard_versions WHERE room=?1 AND frontier=?2",
            params![room, serde_json::to_string(&heads)?],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(root) = stored {
        return Ok((heads, root));
    }
    let mut root = None;
    for (index, head) in heads.iter().enumerate() {
        let source: Option<String> = db.query_row(
            "SELECT root FROM shard_batches WHERE room=?1 AND id=?2",
            params![room, head],
            |row| row.get(0),
        )?;
        if index == 0 {
            root = source;
            continue;
        }
        let mut nodes = Vec::new();
        bundle_export::reachable_nodes(
            &NativeExport(db),
            &json!({"root": source}),
            &mut BTreeSet::new(),
            &mut nodes,
        )?;
        for (_, node) in nodes {
            if node.get("entries").is_none() {
                continue;
            }
            let entries: Vec<(String, Value)> = serde_json::from_value(node["entries"].clone())?;
            for (key, incoming) in entries {
                if key.starts_with("p:") {
                    continue;
                }
                let current = manifest::lookup_root(db, root.clone(), &key)?;
                if current["descriptor"]["heads"] == incoming["heads"] {
                    continue;
                }
                let mut value = incoming;
                if !current.is_null() {
                    let left: Vec<String> =
                        serde_json::from_value(current["descriptor"]["heads"].clone())?;
                    let right: Vec<String> = serde_json::from_value(value["heads"].clone())?;
                    let mut merged = documents::load(db, room, &key, &left)?;
                    merged.merge(&mut documents::load(db, room, &key, &right)?)?;
                    value = descriptor(&key, &merged)?;
                }
                root = set_descriptor(db, root, &key, value)?;
            }
        }
    }
    Ok((heads, root))
}

pub fn import(db: &Transaction<'_>, branch: &str, bundle: &Value) -> Result<Value> {
    crate::shards::validate_id(branch, "branch")?;
    if bundle["protocol"] != "spool/2" || bundle["schema"] != 2 {
        return Err("Sharded storage requires protocol spool/2".into());
    }
    let room = string_field(bundle, "room", 200)?;
    crate::shards::validate_id(room, "room")?;
    let requested: Vec<String> = serde_json::from_value(bundle["heads"].clone())?;
    if requested.is_empty() {
        return Err("Empty bundle frontier".into());
    }
    use rusqlite::OptionalExtension;
    let prior: Option<(String, String)> = db
        .query_row(
            "SELECT room,heads FROM shard_refs WHERE name=?1",
            [branch],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let mut heads: Vec<String> = match prior {
        Some((previous_room, heads)) if previous_room == room => serde_json::from_str(&heads)?,
        Some(_) => return Err("Cannot import unrelated room".into()),
        None => Vec::new(),
    };
    let nodes = bundle["nodes"].as_array().ok_or("Invalid bundle nodes")?;
    for item in nodes {
        let body = serde_json::to_vec(&item["node"])?;
        if item["hash"] != format!("{:x}", Sha256::digest(body)) {
            return Err("Invalid manifest hash".into());
        }
    }
    for document in bundle["documents"]
        .as_array()
        .ok_or("Invalid bundle documents")?
    {
        let key = string_field(document, "key", 202)?;
        let (kind, id) = key.split_once(':').ok_or("Invalid document key")?;
        if !matches!(kind, "m" | "f" | "c" | "a") {
            return Err("Invalid document key".into());
        }
        crate::shards::validate_id(id, "document ID")?;
        let changes: Vec<String> = serde_json::from_value(document["changes"].clone())?;
        let decoded = changes
            .into_iter()
            .map(|item| Ok(automerge::Change::from_bytes(STANDARD.decode(item)?)?))
            .collect::<Result<_>>()?;
        documents::persist(db, room, key, decoded)?;
    }
    for entry in bundle["batches"]
        .as_array()
        .ok_or("Invalid bundle batches")?
    {
        let hash = string_field(entry, "id", 64)?;
        let mut batch = entry.clone();
        batch.as_object_mut().ok_or("Invalid batch")?.remove("id");
        let body = serde_json::to_string(&batch)?;
        if hash != format!("{:x}", Sha256::digest(body.as_bytes()))
            || batch["room"] != room
            || batch["schema"] != 2
        {
            return Err("Invalid batch hash or room".into());
        }
        let parents: Vec<String> = serde_json::from_value(batch["parents"].clone())?;
        let updates: Vec<(String, Vec<String>)> = serde_json::from_value(batch["updates"].clone())?;
        let expected: Option<String> = serde_json::from_value(batch["root"].clone())?;
        let duplicate: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM shard_batches WHERE room=?1 AND id=?2)",
            params![room, hash],
            |row| row.get(0),
        )?;
        if duplicate {
            continue;
        }
        let (_, mut root) = frontier(db, room, &parents)?;
        if parents.is_empty()
            && (!batch["metadata"].is_null() || !updates.is_empty() || expected.is_some())
        {
            return Err("Invalid genesis".into());
        }
        for (key, heads) in updates {
            let (kind, id) = key.split_once(':').ok_or("Invalid document key")?;
            if !matches!(kind, "m" | "f" | "c" | "a") {
                return Err("Invalid document key".into());
            }
            crate::shards::validate_id(id, "document ID")?;
            let doc = documents::load(db, room, &key, &heads)?;
            root = set_descriptor(db, root, &key, descriptor(&key, &doc)?)?;
        }
        if root != expected {
            return Err("Batch manifest does not match its atomic updates".into());
        }
        db.execute(
            "INSERT INTO shard_batches(room,id,parents,root,body) VALUES(?1,?2,?3,?4,?5)",
            params![room, hash, serde_json::to_string(&parents)?, root, body],
        )?;
        if let Some(file_ids) = batch["metadata"]["fileIds"].as_array() {
            for file in file_ids {
                let file_id = file.as_str().ok_or("Invalid batch file ID")?;
                db.execute(
                    "INSERT OR IGNORE INTO shard_batch_files(room,file_id,batch) VALUES(?1,?2,?3)",
                    params![room, file_id, hash],
                )?;
            }
        }
    }
    heads.extend(requested);
    let (heads, root) = frontier(db, room, &heads)?;
    let encoded = serde_json::to_string(&heads)?;
    db.execute(
        "INSERT INTO shard_refs(name,room,heads,root) VALUES(?1,?2,?3,?4)
         ON CONFLICT(name) DO UPDATE SET heads=excluded.heads,root=excluded.root",
        params![branch, room, encoded, root],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO shard_versions(room,frontier,root) VALUES(?1,?2,?3)",
        params![room, encoded, root],
    )?;
    Ok(json!({"branch": branch, "room": room, "heads": heads}))
}

pub struct NativeExport<'a, 'db>(pub &'a Transaction<'db>);

impl ExportStore for NativeExport<'_, '_> {
    fn node(&self, hash: &str) -> Result<Value> {
        manifest::load_node(self.0, hash)
    }
    fn lookup(&self, root: Option<String>, key: &str) -> Result<Value> {
        manifest::lookup_root(self.0, root, key)
    }
    fn frontier(&self, room: &str, heads: &[String]) -> Result<(Vec<String>, Option<String>)> {
        frontier(self.0, room, heads)
    }
    fn batch(&self, room: &str, id: &str) -> Result<Value> {
        let mut statement = self
            .0
            .prepare_cached("SELECT body FROM shard_batches WHERE room=?1 AND id=?2")?;
        let mut rows = statement.query(params![room, id])?;
        let row = rows.next()?.ok_or("Missing batch")?;
        let body = manifest::decode(row.get_ref(0)?)?;
        if body["room"] != room
            || body["schema"] != 2
            || format!("{:x}", Sha256::digest(serde_json::to_vec(&body)?)) != id
        {
            return Err("Invalid batch hash or room".into());
        }
        Ok(body)
    }
    fn batches(&self, room: &str, heads: &[String]) -> Result<Vec<(String, Value)>> {
        batches(self.0, room, heads)
    }
    fn branch_heads(&self, room: &str, branch: &str) -> Result<Vec<String>> {
        branch_heads(self.0, room, branch)
    }
    fn document(&self, room: &str, key: &str, heads: &[String]) -> Result<automerge::Automerge> {
        documents::load(self.0, room, key, heads)
    }
}

pub fn export_page(
    db: &Transaction<'_>,
    room: &str,
    branch: &str,
    since: &[String],
    target: Option<&[String]>,
    max_bytes: usize,
) -> Result<Value> {
    bundle_export::export_page(&NativeExport(db), room, branch, since, target, max_bytes)
}
