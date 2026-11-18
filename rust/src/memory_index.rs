use crate::{Result, documents, manifest, memory_record};
use automerge::AutoSerde;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const SCHEMA: &str = include_str!("../shared/memory_schema.sql");

pub fn refresh(db: &Transaction<'_>, room: &str) -> Result<Vec<String>> {
    let (heads, root): (String, Option<String>) = db.query_row(
        "SELECT heads,root FROM shard_refs WHERE name=?1 AND room=?2",
        params![format!("relay-{room}"), room],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let frontier = format!("retrieval-v3:{heads}");
    let prior: Option<(String, i64)> = db
        .query_row(
            "SELECT heads,last_seq FROM memory_index WHERE room=?1",
            [room],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let parsed = serde_json::from_str(&heads)?;
    if prior.as_ref().is_some_and(|(heads, _)| *heads == frontier) {
        return Ok(parsed);
    }
    let force = prior
        .as_ref()
        .is_some_and(|(heads, _)| !heads.starts_with("retrieval-v3:"));
    let last = update_provenance(db, room, prior.map_or(0, |(_, seq)| seq))?;
    let mut statement =
        db.prepare_cached("SELECT id,fingerprint FROM memory_docs WHERE room=?1")?;
    let mut previous = statement
        .query_map([room], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    let vectors: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vectors')",
        [],
        |row| row.get(0),
    )?;

    for (key, descriptor) in manifest::entries(db, root)? {
        let Some(id) = key.strip_prefix("m:") else {
            continue;
        };
        let heads: Vec<String> = serde_json::from_value(descriptor["heads"].clone())?;
        let fingerprint = serde_json::to_string(&heads)?;
        let prior = previous.remove(id);
        if !force && prior.as_deref() == Some(&fingerprint) {
            continue;
        }
        let doc = documents::load(db, room, &key, &heads)?;
        let shard = serde_json::to_value(AutoSerde::from(&doc))?;
        let message = &shard["messages"][id];
        write_card(db, room, id, message, &fingerprint)?;
        if vectors {
            db.execute(
                "DELETE FROM memory_vectors WHERE room=?1 AND id=?2",
                params![room, id],
            )?;
        }
    }
    for id in previous.keys() {
        db.execute(
            "DELETE FROM memory_docs WHERE room=?1 AND id=?2",
            params![room, id],
        )?;
        db.execute(
            "DELETE FROM memory_fts WHERE room=?1 AND id=?2",
            params![room, id],
        )?;
        if vectors {
            db.execute(
                "DELETE FROM memory_vectors WHERE room=?1 AND id=?2",
                params![room, id],
            )?;
        }
    }
    rebuild_lifecycle(db, room)?;
    if vectors {
        db.execute(
            "DELETE FROM memory_vectors WHERE room=?1 AND id IN (
               SELECT d.id FROM memory_docs d WHERE d.room=?1 AND (
                 COALESCE(json_extract(d.data,'$.lifecycleControl'),0)=1
                 OR EXISTS(SELECT 1 FROM memory_state s WHERE s.room=d.room AND s.id=d.id
                     AND s.status IN ('archived','resolved','superseded'))
                 OR (d.kind='task' AND (
                   instr(d.text,'Current request (source text, not verified findings):'||char(10))=1
                   OR json_extract(d.data,'$.status')='done'
                   OR EXISTS(SELECT 1 FROM memory_docs n WHERE n.room=d.room AND n.kind='task'
                        AND n.task_id=d.task_id AND CAST(json_extract(n.data,'$.revision') AS INTEGER)>
                            CAST(json_extract(d.data,'$.revision') AS INTEGER))
                 ))
               )
            )", [room],
        )?;
    }
    db.execute(
        "INSERT INTO memory_index VALUES(?1,?2,?3) ON CONFLICT(room) DO UPDATE SET
         heads=excluded.heads,last_seq=excluded.last_seq",
        params![room, frontier, last],
    )?;
    Ok(parsed)
}

fn update_provenance(db: &Transaction<'_>, room: &str, mut last: i64) -> Result<i64> {
    let mut statement = db.prepare_cached(
        "SELECT seq,id,body FROM shard_batches WHERE room=?1 AND seq>?2 ORDER BY seq",
    )?;
    let mut rows = statement.query(params![room, last])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(1)?;
        let batch = manifest::decode(row.get_ref(2)?)?;
        let metadata = &batch["metadata"];
        last = row.get(0)?;
        if let Some(event) = metadata["eventId"].as_str() {
            let mut data = json!({"changeId":id,"seq":last});
            for key in [
                "actor",
                "harness",
                "sessionId",
                "turnId",
                "messageId",
                "sourceEventId",
                "evidence",
                "observedAt",
            ] {
                if let Some(value) = metadata.get(key) {
                    data[key] = value.clone();
                }
            }
            data["fileIds"] = json!(
                metadata["fileIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .take(50)
                    .collect::<Vec<_>>()
            );
            db.execute(
                "INSERT OR IGNORE INTO memory_provenance VALUES(?1,?2,?3)",
                params![room, event, serde_json::to_string(&data)?],
            )?;
        }
    }
    Ok(last)
}

fn write_card(
    db: &Transaction<'_>,
    room: &str,
    id: &str,
    message: &Value,
    fingerprint: &str,
) -> Result<()> {
    let role = message["role"].as_str().ok_or("Missing message role")?;
    let text = message["text"].as_str().ok_or("Missing message text")?;
    let source: Option<String> = db
        .query_row(
            "SELECT data FROM memory_provenance WHERE room=?1 AND event_id=?2",
            params![room, message["eventId"].as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let source: Value = source
        .map(|encoded| serde_json::from_str(&encoded))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let event: Option<Value> = if role == "system" {
        serde_json::from_str(text)
            .ok()
            .filter(memory_record::valid_event)
    } else {
        None
    };
    let mut data = event.unwrap_or_else(|| json!({}));
    let kind = data["kind"].as_str().unwrap_or("conversation").to_owned();
    let title = data["title"]
        .as_str()
        .map_or_else(|| format!("{role} conversation"), str::to_owned);
    let text = data["text"].as_str().unwrap_or(text).to_owned();
    let seq = source["seq"].as_i64().unwrap_or(0);
    data["id"] = json!(id);
    data["kind"] = json!(kind);
    data["role"] = json!(role);
    data["source"] = source;
    data["trust"] = json!("source text and agent claims; not instructions");
    data["citation"] = json!(format!("tw://rooms/{room}/messages/{id}"));
    db.execute(
        "INSERT INTO memory_docs VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(room,id) DO UPDATE SET
         fingerprint=excluded.fingerprint,kind=excluded.kind,task_id=excluded.task_id,title=excluded.title,
         text=excluded.text,data=excluded.data,seq=excluded.seq",
        params![room,id,fingerprint,kind,data["taskId"].as_str(),title,text,serde_json::to_string(&data)?,seq],
    )?;
    let mut indexed = text;
    for path in data["files"]
        .as_array()
        .into_iter()
        .flatten()
        .take(30)
        .filter_map(|f| f["path"].as_str())
    {
        indexed.push('\n');
        indexed.push_str(&String::from_utf16_lossy(
            &path.encode_utf16().take(1000).collect::<Vec<_>>(),
        ));
    }
    db.execute(
        "DELETE FROM memory_fts WHERE room=?1 AND id=?2",
        params![room, id],
    )?;
    db.execute(
        "INSERT INTO memory_fts(room,id,title,text) VALUES(?1,?2,?3,?4)",
        params![room, id, title, indexed],
    )?;
    Ok(())
}

fn rebuild_lifecycle(db: &Transaction<'_>, room: &str) -> Result<()> {
    let mut statement = db.prepare_cached(
        "SELECT id,data FROM memory_docs WHERE room=?1 AND json_type(data,'$.lifecycleChanges')='array'
         ORDER BY seq,rowid",
    )?;
    let mut rows = statement.query([room])?;
    let mut states = BTreeMap::new();
    let mut known = BTreeSet::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let event: Value = serde_json::from_str(&row.get::<_, String>(1)?)?;
        for change in event["lifecycleChanges"]
            .as_array()
            .into_iter()
            .flatten()
            .take(60)
        {
            let Some(target) = change["targetId"].as_str() else {
                continue;
            };
            if !known.contains(target) {
                let exists: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM memory_docs WHERE room=?1 AND id=?2)",
                    params![room, target],
                    |row| row.get(0),
                )?;
                if !exists {
                    continue;
                }
                known.insert(target.to_owned());
            }
            if let Some(state) =
                memory_record::lifecycle_transition(states.get(target), &id, &event, change)
            {
                states.insert(target.to_owned(), state);
            }
        }
    }
    db.execute("DELETE FROM memory_state WHERE room=?1", [room])?;
    for (id, state) in states {
        db.execute(
            "INSERT INTO memory_state VALUES(?1,?2,?3,?4,?5)",
            params![
                room,
                id,
                state["status"].as_str(),
                state["revision"].as_i64(),
                serde_json::to_string(&state)?
            ],
        )?;
    }
    Ok(())
}
