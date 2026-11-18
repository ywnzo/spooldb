use crate::{manifest, memory_index, memory_mutation::Backend, memory_write::Fault, shards};
use rusqlite::{Transaction, params_from_iter};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, Fault>;
pub struct NativeMemory<'a, 'db>(pub &'a Transaction<'db>);

fn internal<E>(_: E) -> Fault {
    Fault(500, "INTERNAL", "Relay unavailable".to_owned())
}

impl Backend for NativeMemory<'_, '_> {
    fn query(&self, sql: &str, bindings: &[&str]) -> Result<Vec<String>> {
        let mut query = self.0.prepare_cached(sql).map_err(internal)?;
        let rows = query
            .query_map(params_from_iter(bindings), |row| row.get(0))
            .map_err(internal)?;
        rows.collect::<rusqlite::Result<_>>().map_err(internal)
    }
    fn execute(&self, sql: &str, bindings: &[&str]) -> Result<()> {
        self.0
            .execute(sql, params_from_iter(bindings))
            .map_err(internal)?;
        Ok(())
    }
    fn heads(&self, room: &str) -> Result<Vec<String>> {
        memory_index::refresh(self.0, room).map_err(internal)
    }
    fn observation(&self) -> Result<(String, String)> {
        shards::observation(self.0).map_err(internal)
    }
    fn published_file(&self, room: &str, path: &str) -> Result<Option<Value>> {
        let index = manifest::lookup(self.0, room, &format!("p:{path}")).map_err(internal)?;
        let Some(file_id) = index["descriptor"]["files"][0].as_str() else {
            return Ok(None);
        };
        let desc = manifest::lookup(self.0, room, &format!("f:{file_id}")).map_err(internal)?;
        Ok(Some(
            json!({"path":path,"fileId":file_id,"heads":desc["descriptor"]["heads"]}),
        ))
    }
    fn publish(&self, room: &str, input: &Value) -> Result<Value> {
        let stored = shards::append_message(self.0, room, &format!("relay-{room}"), input)
            .map_err(internal)?;
        memory_index::refresh(self.0, room).map_err(internal)?;
        Ok(stored)
    }
}

impl crate::deletion::History for NativeMemory<'_, '_> {
    fn message(&self, room: &str, id: &str) -> Result<Value> {
        let doc = crate::documents::read(self.0, room, &format!("m:{id}")).map_err(internal)?;
        let message = doc["messages"][id].clone();
        if !message.is_object() {
            return Err(internal("missing message"));
        }
        Ok(message)
    }
    fn memory_layout(&self, room: &str) -> Result<bool> {
        use rusqlite::params;
        let root: Option<String> = self
            .0
            .query_row(
                "SELECT root FROM shard_refs WHERE name=?1 AND room=?2",
                params![format!("relay-{room}"), room],
                |row| row.get(0),
            )
            .map_err(internal)?;
        Ok(manifest::entries(self.0, root)
            .map_err(internal)?
            .iter()
            .all(|(key, _)| key.starts_with("m:")))
    }
    fn reset(&self, room: &str) -> Result<Vec<String>> {
        shards::create_room(self.0, room, &format!("relay-{room}")).map_err(internal)?;
        self.heads(room)
    }
    fn retain(&self, room: &str, input: &Value) -> Result<Value> {
        shards::append_message(self.0, room, &format!("relay-{room}"), input).map_err(internal)
    }
    fn finish_replay(&self, room: &str) -> Result<()> {
        self.heads(room)?;
        self.execute("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')", &[])
    }
}
