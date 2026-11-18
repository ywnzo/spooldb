use crate::{Result, radix};
use flate2::{Compression, read::DeflateDecoder, write::DeflateEncoder};
use rusqlite::{Transaction, params, types::ValueRef};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

const MAX_DECODED_BYTES: usize = 64 * 1024 * 1024;

pub(crate) fn encode(body: &str) -> Result<rusqlite::types::Value> {
    use rusqlite::types::Value::{Blob, Text};
    if body.len() >= 256 {
        let mut encoder = DeflateEncoder::new(vec![1], Compression::fast());
        encoder.write_all(body.as_bytes())?;
        let compressed = encoder.finish()?;
        if compressed.len() < body.len() {
            return Ok(Blob(compressed));
        }
    }
    Ok(Text(body.to_owned()))
}

pub(crate) fn decode(body: ValueRef<'_>) -> Result<Value> {
    match body {
        ValueRef::Text(bytes) => Ok(serde_json::from_slice(bytes)?),
        ValueRef::Blob([1, compressed @ ..]) => {
            let mut bytes = Vec::new();
            DeflateDecoder::new(compressed)
                .take((MAX_DECODED_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() > MAX_DECODED_BYTES {
                return Err("Manifest node exceeds the decoded size limit".into());
            }
            Ok(serde_json::from_slice(&bytes)?)
        }
        _ => Err("Unknown manifest storage encoding".into()),
    }
}

pub(crate) fn load_node(db: &Transaction<'_>, hash: &str) -> Result<Value> {
    let mut statement = db.prepare_cached("SELECT body FROM shard_nodes WHERE hash=?1")?;
    let mut rows = statement.query([hash])?;
    let row = rows.next()?.ok_or("Missing manifest node")?;
    let node = decode(row.get_ref(0)?)?;
    // Manifest descriptors use fixed ASCII object keys and strings, arrays,
    // null and booleans. serde_json's sorted keys match the JS canonical hash.
    let actual = format!("{:x}", Sha256::digest(serde_json::to_vec(&node)?));
    if actual != hash {
        return Err("Corrupt manifest node".into());
    }
    Ok(node)
}

pub fn lookup(db: &Transaction<'_>, room: &str, key: &str) -> Result<Value> {
    let root: Option<String> = db.query_row(
        "SELECT root FROM shard_refs WHERE name=?1 AND room=?2",
        params![format!("relay-{room}"), room],
        |row| row.get(0),
    )?;
    lookup_root(db, root, key)
}

pub fn lookup_root(db: &Transaction<'_>, mut root: Option<String>, key: &str) -> Result<Value> {
    for bucket in radix::route(key)? {
        let Some(hash) = root else {
            return Ok(Value::Null);
        };
        let node = load_node(db, &hash)?;
        let children = node["children"]
            .as_array()
            .filter(|children| children.len() == 16)
            .ok_or("Invalid manifest children")?;
        root = match &children[usize::from(bucket)] {
            Value::Null => None,
            Value::String(hash) => Some(hash.clone()),
            _ => return Err("Invalid manifest child reference".into()),
        };
    }
    let Some(hash) = root else {
        return Ok(Value::Null);
    };
    let node = load_node(db, &hash)?;
    for entry in node["entries"].as_array().ok_or("Invalid manifest leaf")? {
        let pair = entry
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or("Invalid manifest entry")?;
        if pair[0].as_str().ok_or("Invalid manifest key")? == key {
            return Ok(json!({ "key": key, "descriptor": pair[1] }));
        }
    }
    Ok(Value::Null)
}

struct NativeNodes<'a, 'db>(&'a Transaction<'db>);

impl radix::Nodes for NativeNodes<'_, '_> {
    fn load(&self, hash: &str) -> Result<Value> {
        load_node(self.0, hash)
    }
    fn insert(&self, hash: &str, body: &str) -> Result<()> {
        self.0.execute(
            "INSERT OR IGNORE INTO shard_nodes(hash,body) VALUES(?1,?2)",
            params![hash, encode(body)?],
        )?;
        Ok(())
    }
}

pub fn set(
    db: &Transaction<'_>,
    root: Option<&str>,
    key: &str,
    value: Option<Value>,
) -> Result<Option<String>> {
    radix::update(&NativeNodes(db), root, &radix::route(key)?, key, value)
}

pub fn entries(db: &Transaction<'_>, root: Option<String>) -> Result<Vec<(String, Value)>> {
    let mut entries = Vec::new();
    collect_entries(db, root.as_deref(), 0, &mut entries)?;
    Ok(entries)
}

fn collect_entries(
    db: &Transaction<'_>,
    root: Option<&str>,
    depth: usize,
    entries: &mut Vec<(String, Value)>,
) -> Result<()> {
    let Some(root) = root else { return Ok(()) };
    let node = load_node(db, root)?;
    if depth == 4 {
        let mut leaf: Vec<(String, Value)> = serde_json::from_value(node["entries"].clone())?;
        entries.append(&mut leaf);
    } else {
        let children: Vec<Option<String>> = serde_json::from_value(node["children"].clone())?;
        if children.len() != 16 {
            return Err("Invalid manifest children".into());
        }
        for child in children {
            collect_entries(db, child.as_deref(), depth + 1, entries)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn updates_are_content_addressed_and_preserve_previous_roots() -> Result<()> {
        let mut db = Connection::open_in_memory()?;
        db.execute_batch(
            "CREATE TABLE shard_nodes(hash TEXT PRIMARY KEY, body TEXT NOT NULL);
             CREATE TABLE shard_refs(name TEXT, room TEXT, root TEXT);",
        )?;
        let tx = db.transaction()?;
        let first = set(&tx, None, "m:first", Some(json!({"heads": ["a"]})))?;
        let both = set(
            &tx,
            first.as_deref(),
            "m:second",
            Some(json!({"heads": ["b"]})),
        )?;
        let restored = set(&tx, both.as_deref(), "m:second", None)?;
        assert_eq!(first, restored);
        assert_eq!(set(&tx, restored.as_deref(), "m:first", None)?, None);

        tx.execute(
            "INSERT INTO shard_refs VALUES('relay-room','room',?1)",
            [&both],
        )?;
        assert_eq!(
            lookup(&tx, "room", "m:first")?["descriptor"]["heads"],
            json!(["a"])
        );
        assert_eq!(
            lookup(&tx, "room", "m:second")?["descriptor"]["heads"],
            json!(["b"])
        );
        Ok(())
    }
}
