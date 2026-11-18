use crate::{
    Result as WorkerResult, StateRequest,
    bundle_export::{self, ExportStore},
    fault, query_one,
    radix::{self, Nodes},
    reply,
    storage::{CloudMemory, Sql, decode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use worker::Response;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn validate(heads: &Value) -> Option<Vec<String>> {
    let parsed: Vec<String> = serde_json::from_value(heads.clone()).ok()?;
    (parsed.len() <= 128
        && parsed.iter().all(|head| {
            head.len() == 64
                && head
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }))
    .then_some(parsed)
}

pub fn run(memory: &CloudMemory, input: &StateRequest) -> WorkerResult<Response> {
    let Some(since) = validate(&input.input["since"]) else {
        return fault(
            400,
            "INVALID_FRONTIER",
            "Expected at most 128 causal hashes",
        );
    };
    let target = if let Some(value) = input.input.get("heads") {
        let Some(heads) = validate(value).filter(|heads| !heads.is_empty()) else {
            return fault(400, "INVALID_FRONTIER", "Invalid target frontier");
        };
        Some(heads)
    } else {
        None
    };
    match bundle_export::export_page(
        memory,
        &input.room,
        &format!("relay-{}", input.room),
        &since,
        target.as_deref(),
        1_500_000,
    ) {
        Ok(mut page) => {
            page["room"] = json!(input.room);
            page["sourcePrefix"] = json!(format!("@machines/{}/", input.principal.id));
            reply(200, page)
        }
        Err(error) => {
            let message = error.to_string();
            if message.contains("atomic batch exceeds") {
                fault(
                    422,
                    "BATCH_TOO_LARGE",
                    "One atomic batch exceeds the page limit",
                )
            } else if ["Missing", "not an ancestor"]
                .iter()
                .any(|part| message.contains(part))
            {
                fault(
                    409,
                    "MISSING_DEPENDENCIES",
                    "Causal base missing; reset sync cursors",
                )
            } else {
                fault(422, "INVALID_BUNDLE", "Invalid causal data")
            }
        }
    }
}

#[derive(Deserialize)]
struct Root {
    root: Option<String>,
}

impl ExportStore for CloudMemory {
    fn node(&self, hash: &str) -> Result<Value> {
        self.load(hash)
    }
    fn lookup(&self, mut root: Option<String>, key: &str) -> Result<Value> {
        for bucket in radix::route(key)? {
            let Some(hash) = root else {
                return Ok(Value::Null);
            };
            let node = self.load(&hash)?;
            let children: Vec<Option<String>> = serde_json::from_value(node["children"].clone())?;
            root = children
                .get(usize::from(bucket))
                .ok_or("Invalid manifest children")?
                .clone();
        }
        let Some(hash) = root else {
            return Ok(Value::Null);
        };
        let node = self.load(&hash)?;
        let entries: Vec<(String, Value)> = serde_json::from_value(node["entries"].clone())?;
        Ok(entries.into_iter().find(|(name, _)| name == key).map_or(
            Value::Null,
            |(key, value)| json!({"key":key,"descriptor":value}),
        ))
    }
    fn frontier(&self, room: &str, heads: &[String]) -> Result<(Vec<String>, Option<String>)> {
        let canonical = if heads.len() > 1 {
            let parents = self
                .batches(room, heads)?
                .into_iter()
                .map(|(_, batch)| serde_json::from_value::<Vec<String>>(batch["parents"].clone()))
                .collect::<std::result::Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect::<BTreeSet<_>>();
            heads
                .iter()
                .filter(|head| !parents.contains(*head))
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        } else {
            heads.to_vec()
        };
        let root = match canonical.as_slice() {
            [] => None,
            [head] => {
                query_one::<Root>(
                    &self.0,
                    "SELECT root FROM shard_batches WHERE room=?1 AND id=?2",
                    vec![room.into(), head.as_str().into()],
                )?
                .ok_or("Missing batch")?
                .root
            }
            _ => {
                query_one::<Root>(
                    &self.0,
                    "SELECT root FROM shard_versions WHERE room=?1 AND frontier=?2",
                    vec![room.into(), serde_json::to_string(&canonical)?.into()],
                )?
                .ok_or("Missing merged frontier")?
                .root
            }
        };
        Ok((canonical, root))
    }
    fn batch(&self, room: &str, id: &str) -> Result<Value> {
        let row = self
            .0
            .exec(
                "SELECT body FROM shard_batches WHERE room=?1 AND id=?2",
                vec![room.into(), id.into()],
            )?
            .raw()
            .next()
            .transpose()?
            .ok_or("Missing batch")?;
        let body = decode(row.first().ok_or("Missing batch body")?)?;
        if body["room"] != room
            || body["schema"] != 2
            || format!("{:x}", Sha256::digest(serde_json::to_vec(&body)?)) != id
        {
            return Err("Invalid batch hash or room".into());
        }
        Ok(body)
    }
    fn batches(&self, room: &str, heads: &[String]) -> Result<Vec<(String, Value)>> {
        let cursor=self.0.exec(
            "WITH RECURSIVE reach(id) AS (
              SELECT value FROM json_each(?1) UNION SELECT p.value FROM reach r
              JOIN shard_batches b ON b.id=r.id CROSS JOIN json_each(b.parents) p WHERE b.room=?2
             ) SELECT r.id,b.body FROM reach r LEFT JOIN shard_batches b ON b.room=?2 AND b.id=r.id ORDER BY b.seq",
            vec![serde_json::to_string(heads)?.into(),room.into()],
        )?;
        let mut output = Vec::new();
        for row in cursor.raw() {
            let row = row?;
            let [Sql::String(id), body] = row.as_slice() else {
                return Err("Invalid batch row".into());
            };
            if matches!(body, Sql::Null) {
                return Err("Missing batch".into());
            }
            let batch = decode(body)?;
            if batch["room"] != room
                || batch["schema"] != 2
                || format!("{:x}", Sha256::digest(serde_json::to_vec(&batch)?)) != *id
            {
                return Err("Invalid batch hash or room".into());
            }
            output.push((id.clone(), batch));
        }
        Ok(output)
    }
    fn branch_heads(&self, room: &str, branch: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Branch {
            heads: String,
        }
        let row = query_one::<Branch>(
            &self.0,
            "SELECT heads FROM shard_refs WHERE room=?1 AND name=?2",
            vec![room.into(), branch.into()],
        )?
        .ok_or("Missing branch")?;
        Ok(serde_json::from_str(&row.heads)?)
    }
    fn document(&self, room: &str, key: &str, heads: &[String]) -> Result<automerge::Automerge> {
        self.load_document(room, key, &serde_json::to_string(heads)?)
            .map_err(|error| error.2.into())
    }
}
