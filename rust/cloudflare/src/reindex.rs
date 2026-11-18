use crate::{
    memory_mutation::Backend,
    query_one,
    radix::Nodes,
    storage::{CloudMemory, Result, Sql, decode, internal},
};
use automerge::{AutoSerde, Automerge, Change, ReadDoc};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

impl CloudMemory {
    pub fn current_index(&self, room: &str, heads: &str) -> Result<bool> {
        let rows = self.query("SELECT heads FROM memory_index WHERE room=?1", &[room])?;
        Ok(rows
            .first()
            .is_some_and(|index| index == &format!("retrieval-v3:{heads}")))
    }

    pub fn refresh(&self, room: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Index {
            heads: String,
            last_seq: i64,
        }
        let current = self.frontier(room)?;
        let frontier = format!("retrieval-v3:{}", current.heads);
        let prior: Option<Index> = query_one(
            &self.0,
            "SELECT heads,last_seq FROM memory_index WHERE room=?1",
            vec![room.into()],
        )
        .map_err(internal)?;
        if prior.as_ref().is_some_and(|prior| prior.heads == frontier) {
            return Ok(current.heads);
        }
        let force = prior
            .as_ref()
            .is_some_and(|prior| !prior.heads.starts_with("retrieval-v3:"));
        let last = self.provenance(room, prior.map_or(0, |prior| prior.last_seq))?;
        #[derive(Deserialize)]
        struct Fingerprint {
            id: String,
            fingerprint: String,
        }
        let cursor = self
            .0
            .exec(
                "SELECT id,fingerprint FROM memory_docs WHERE room=?1",
                vec![room.into()],
            )
            .map_err(internal)?;
        let mut previous = cursor
            .next::<Fingerprint>()
            .map(|row| row.map(|row| (row.id, row.fingerprint)).map_err(internal))
            .collect::<Result<BTreeMap<_, _>>>()?;
        let has_vectors = !self
            .query(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vectors'",
                &[],
            )?
            .is_empty();
        let mut stack: Vec<_> = current.root.into_iter().map(|root| (root, 0)).collect();
        while let Some((hash, depth)) = stack.pop() {
            let node = self.load(&hash).map_err(internal)?;
            if depth < 4 {
                let children: Vec<Option<String>> =
                    serde_json::from_value(node["children"].clone()).map_err(internal)?;
                if children.len() != 16 {
                    return Err(internal("invalid manifest children"));
                }
                stack.extend(
                    children
                        .into_iter()
                        .rev()
                        .flatten()
                        .map(|child| (child, depth + 1)),
                );
                continue;
            }
            let entries: Vec<(String, Value)> =
                serde_json::from_value(node["entries"].clone()).map_err(internal)?;
            for (key, entry) in entries {
                let Some(id) = key.strip_prefix("m:") else {
                    continue;
                };
                let fingerprint = entry["heads"].to_string();
                let prior = previous.remove(id);
                if !force && prior.as_deref() == Some(&fingerprint) {
                    continue;
                }
                let message = self.replay(room, &key, &fingerprint)?;
                let role = message["role"]
                    .as_str()
                    .ok_or_else(|| internal("missing message role"))?;
                let text = message["text"]
                    .as_str()
                    .ok_or_else(|| internal("missing message text"))?;
                let provenance = self.query(
                    "SELECT data FROM memory_provenance WHERE room=?1 AND event_id=?2",
                    &[room, message["eventId"].as_str().unwrap_or_default()],
                )?;
                let source = provenance
                    .first()
                    .map(|data| serde_json::from_str(data))
                    .transpose()
                    .map_err(internal)?
                    .unwrap_or_else(|| json!({}));
                self.index_message(room, id, role, text, &fingerprint, source)?;
                if has_vectors {
                    self.run(
                        "DELETE FROM memory_vectors WHERE room=?1 AND id=?2",
                        vec![room.into(), id.into()],
                    )?;
                }
            }
        }
        for id in previous.keys() {
            for table in ["memory_docs", "memory_fts"] {
                self.run(
                    &format!("DELETE FROM {table} WHERE room=?1 AND id=?2"),
                    vec![room.into(), id.as_str().into()],
                )?;
            }
            if has_vectors {
                self.run(
                    "DELETE FROM memory_vectors WHERE room=?1 AND id=?2",
                    vec![room.into(), id.as_str().into()],
                )?;
            }
        }
        self.run("DELETE FROM memory_state WHERE room=?1", vec![room.into()])?;
        let controls=self.query("SELECT data FROM memory_docs WHERE room=?1 AND json_type(data,'$.lifecycleChanges')='array' ORDER BY seq,rowid",&[room])?;
        for data in controls {
            let record: Value = serde_json::from_str(&data).map_err(internal)?;
            let id = record["id"]
                .as_str()
                .ok_or_else(|| internal("invalid lifecycle source"))?;
            self.index_lifecycle(room, id, &record)?;
        }
        self.run("INSERT INTO memory_index VALUES(?1,?2,?3) ON CONFLICT(room) DO UPDATE SET heads=excluded.heads,last_seq=excluded.last_seq",
            vec![room.into(),frontier.into(),last.into()])?;
        Ok(current.heads)
    }

    fn provenance(&self, room: &str, mut last: i64) -> Result<i64> {
        let cursor = self
            .0
            .exec(
                "SELECT seq,id,body FROM shard_batches WHERE room=?1 AND seq>?2 ORDER BY seq",
                vec![room.into(), last.into()],
            )
            .map_err(internal)?;
        for row in cursor.raw() {
            let row = row.map_err(internal)?;
            let [Sql::Integer(seq), Sql::String(id), body] = row.as_slice() else {
                return Err(internal("invalid batch row"));
            };
            last = *seq;
            let body = decode(body).map_err(internal)?;
            let metadata = &body["metadata"];
            if let Some(event) = metadata["eventId"].as_str() {
                let mut source = json!({"changeId":id,"seq":seq});
                for field in [
                    "actor",
                    "harness",
                    "sessionId",
                    "turnId",
                    "messageId",
                    "sourceEventId",
                    "evidence",
                    "observedAt",
                ] {
                    if let Some(value) = metadata.get(field) {
                        source[field] = value.clone();
                    }
                }
                source["fileIds"] = json!(
                    metadata["fileIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .take(50)
                        .collect::<Vec<_>>()
                );
                self.run(
                    "INSERT OR IGNORE INTO memory_provenance VALUES(?1,?2,?3)",
                    vec![room.into(), event.into(), source.to_string().into()],
                )?;
            }
        }
        Ok(last)
    }

    pub(super) fn replay(&self, room: &str, key: &str, heads: &str) -> Result<Value> {
        let doc = self.load_document(room, key, heads)?;
        let value = serde_json::to_value(AutoSerde::from(&doc)).map_err(internal)?;
        Ok(value["messages"][&key[2..]].clone())
    }

    pub fn load_document(&self, room: &str, key: &str, heads: &str) -> Result<Automerge> {
        let cursor = self
            .0
            .exec(
                "WITH RECURSIVE wanted(hash) AS (
               SELECT value FROM json_each(?1) UNION
               SELECT d.value FROM wanted w JOIN shard_changes c ON c.hash=w.hash
                 CROSS JOIN json_each(c.deps) d WHERE c.room=?2 AND c.doc=?3
             ) SELECT c.hash,c.body FROM shard_changes c JOIN wanted w ON c.hash=w.hash
             WHERE c.room=?2 AND c.doc=?3 ORDER BY c.seq",
                vec![heads.into(), room.into(), key.into()],
            )
            .map_err(internal)?;
        let mut doc = Automerge::new();
        for row in cursor.raw() {
            let row = row.map_err(internal)?;
            let [Sql::String(hash), Sql::Blob(bytes)] = row.as_slice() else {
                return Err(internal("invalid change row"));
            };
            let change = Change::from_bytes(bytes.clone()).map_err(internal)?;
            if change.hash().to_string() != *hash {
                return Err(internal("invalid change hash"));
            }
            doc.apply_changes([change]).map_err(internal)?;
        }
        let mut expected: Vec<String> = serde_json::from_str(heads).map_err(internal)?;
        expected.sort_unstable();
        let mut actual = doc
            .get_heads()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        actual.sort_unstable();
        if expected.is_empty() || actual != expected || !doc.get_missing_deps(&[]).is_empty() {
            return Err(internal("incomplete document history"));
        }
        let value = serde_json::to_value(AutoSerde::from(&doc)).map_err(internal)?;
        if value["room"] != room || value["document"] != key || value["schema"] != 2 {
            return Err(internal("invalid document identity"));
        }
        Ok(doc)
    }
}
