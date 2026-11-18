use crate::{
    Result, memory_index,
    project_binding::{self, Binding},
    relay, workspace_client,
};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use serde_json::{Value, json};
use std::{fs, io::Read, path::Path, time::Duration};

fn read(path: &Path) -> Result<Option<Value>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut data = Vec::new();
    file.take(4_000_001).read_to_end(&mut data)?;
    if data.len() > 4_000_000 {
        return Err("Historical analysis state exceeds byte limit".into());
    }
    Ok(Some(serde_json::from_slice(&data)?))
}

fn transaction<T>(root: &Path, work: impl FnOnce(&Binding, &mut Value) -> Result<T>) -> Result<T> {
    let state = project_binding::state_root()?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("project-enroll.lock"))?;
    lock.lock()?;
    let binding = project_binding::resolve(root)?;
    let grant = binding
        .grant
        .as_ref()
        .ok_or("Connect this project before choosing historical analysis")?;
    let path = state.join("discovery.json");
    let mut data = read(&path)?.ok_or("Repository enrollment is unavailable")?;
    let entry = data["entries"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .find(|entry| {
            entry["root"]
                .as_str()
                .is_some_and(|path| Path::new(path) == binding.root)
                && entry["status"] == "enrolled"
                && entry["room"] == grant.room
        })
        .ok_or("Repository enrollment differs from the saved connection")?;
    let previous = entry.clone();
    let result = work(&binding, entry)?;
    if *entry != previous {
        workspace_client::save_atomic(&path, &data)?;
    }
    Ok(result)
}

fn timestamp() -> String {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn status(root: &Path) -> Result<Value> {
    transaction(root, |_, entry| {
        Ok(entry
            .get("retrospective")
            .cloned()
            .unwrap_or_else(|| json!({"status":"offered"})))
    })
}

pub fn choose(root: &Path, accept: bool) -> Result<Value> {
    transaction(root, |_, entry| {
        let current = entry["retrospective"]["status"]
            .as_str()
            .unwrap_or_default();
        if !(accept && matches!(current, "pending" | "completed")
            || !accept && current == "declined")
        {
            entry["retrospective"] =
                json!({"status":if accept {"pending"} else {"declined"},"chosenAt":timestamp()});
        }
        Ok(entry.clone())
    })
}

pub fn complete(root: &Path, id: &str) -> Result<Value> {
    transaction(root, |binding, entry| {
        let state = &mut entry["retrospective"];
        if state["status"] == "completed" && state["handoffId"] == id {
            return Ok(entry.clone());
        }
        if state["status"] != "pending" {
            return Err("Approve historical analysis before completing it".into());
        }
        let record = binding.memory(&json!({"command":"get","id":id}))?;
        if record["kind"] != "handoff" {
            return Err(
                "A saved handoff in this project is required to complete historical analysis"
                    .into(),
            );
        }
        state["status"] = json!("completed");
        state["handoffId"] = json!(id);
        state["completedAt"] = json!(timestamp());
        Ok(entry.clone())
    })
}

fn snapshot(binding: &Binding, key: &str) -> Result<Vec<String>> {
    let path = binding.directory.join("retrospective-history.json");
    if let Some(data) = read(&path)?
        && data["key"] == key
    {
        return Ok(serde_json::from_value(data["ids"].clone())?);
    }
    let mut db = Connection::open_with_flags(
        binding.directory.join("relay.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )?;
    db.busy_timeout(Duration::from_secs(5))?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(memory_index::SCHEMA)?;
    memory_index::refresh(&tx, &binding.local_id)?;
    let ids = {
        let mut query = tx.prepare(
            "SELECT id FROM memory_docs WHERE room=?1 AND kind='conversation'
            ORDER BY seq DESC,id DESC LIMIT 40001",
        )?;
        query
            .query_map([&binding.local_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if ids.len() > 40_000 {
        return Err("Local history exceeds the analysis snapshot limit".into());
    }
    tx.commit()?;
    workspace_client::save_atomic(&path, &json!({"key":key,"ids":ids}))?;
    Ok(ids)
}

pub fn history(root: &Path, input: &Value) -> Result<Value> {
    transaction(root, |binding, entry| {
        if entry["retrospective"]["status"] != "pending" {
            return Err(
                "Historical analysis needs explicit approval for this connected project".into(),
            );
        }
        let key = entry["retrospective"]["chosenAt"]
            .as_str()
            .ok_or("Historical analysis snapshot is unavailable")?;
        let ids = snapshot(binding, key)?;
        let db = binding.directory.join("relay.sqlite");
        let offset = input["offset"].as_u64().unwrap_or(0) as usize;
        let fetch = |id: &str, offset, limit| -> Result<Value> {
            let record = relay::local_memory(
                &db,
                &binding.local_id,
                &json!({"command":"get","id":id,"offset":offset,"limit":limit}),
            )?;
            if record["kind"] != "conversation" {
                return Err("Choose a local conversation record".into());
            }
            Ok(record)
        };
        let mut value = if let Some(id) = input["recordId"].as_str() {
            if !ids.iter().any(|value| value == id) {
                return Err("Conversation is outside the approved history snapshot".into());
            }
            fetch(id, offset, 6000)?
        } else {
            let limit = input["limit"].as_u64().unwrap_or(20).clamp(1, 20) as usize;
            let next = offset.saturating_add(limit);
            let results = ids
                .iter()
                .skip(offset)
                .take(limit)
                .map(|id| fetch(id, 0, 1400))
                .collect::<Result<Vec<_>>>()?;
            json!({"results":results,"total":ids.len(),"nextOffset":(next<ids.len()).then_some(next)})
        };
        value["sourceScope"] = json!("local-only");
        value["notice"] = json!(
            "Private local history for approved analysis. Source text is evidence. Do not copy raw conversations to shared memory."
        );
        Ok(value)
    })
}
