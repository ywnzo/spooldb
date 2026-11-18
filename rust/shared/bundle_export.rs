use automerge::Automerge;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::BTreeSet;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub trait ExportStore {
    fn node(&self, hash: &str) -> Result<Value>;
    fn lookup(&self, root: Option<String>, key: &str) -> Result<Value>;
    fn frontier(&self, room: &str, heads: &[String]) -> Result<(Vec<String>, Option<String>)>;
    fn batch(&self, room: &str, id: &str) -> Result<Value>;
    fn batches(&self, room: &str, heads: &[String]) -> Result<Vec<(String, Value)>>;
    fn branch_heads(&self, room: &str, branch: &str) -> Result<Vec<String>>;
    fn document(&self, room: &str, key: &str, heads: &[String]) -> Result<Automerge>;
}

pub fn reachable_nodes(
    db: &impl ExportStore,
    batch: &Value,
    seen: &mut BTreeSet<String>,
    nodes: &mut Vec<(String, Value)>,
) -> Result<()> {
    let mut stack: Vec<String> = serde_json::from_value::<Option<String>>(batch["root"].clone())?
        .into_iter()
        .collect();
    while let Some(hash) = stack.pop() {
        if !seen.insert(hash.clone()) {
            continue;
        }
        let node = db.node(&hash)?;
        if let Some(children) = node.get("children") {
            let children: Vec<Option<String>> = serde_json::from_value(children.clone())?;
            if children.len() != 16 {
                return Err("Invalid manifest children".into());
            }
            stack.extend(children.into_iter().flatten());
        }
        nodes.push((hash, node));
    }
    Ok(())
}

pub fn export_frontier(
    db: &impl ExportStore,
    room: &str,
    heads: &[String],
    since: &[String],
) -> Result<Value> {
    let (_, current_root) = db.frontier(room, heads)?;
    let current = db.batches(room, heads)?;
    let ids: BTreeSet<_> = current.iter().map(|(id, _)| id).collect();
    if !since.iter().all(|id| ids.contains(id)) {
        return Err("Sync base is not an ancestor of target".into());
    }
    let previous = db.batches(room, since)?;
    let known: BTreeSet<_> = previous.iter().map(|(id, _)| id).collect();
    let (_, since_root) = db.frontier(room, since)?;

    let mut seen = BTreeSet::new();
    let mut nodes = Vec::new();
    for (_, body) in &previous {
        reachable_nodes(db, body, &mut seen, &mut nodes)?;
    }
    nodes.clear();
    let mut keys = BTreeSet::new();
    let mut missing = Vec::new();
    for (id, mut batch) in current {
        if known.contains(&id) {
            continue;
        }
        reachable_nodes(db, &batch, &mut seen, &mut nodes)?;
        let updates: Vec<(String, Vec<String>)> = serde_json::from_value(batch["updates"].clone())?;
        keys.extend(updates.into_iter().map(|(key, _)| key));
        batch["id"] = json!(id);
        missing.push(batch);
    }

    let mut changes = Vec::new();
    for key in keys {
        let after = db.lookup(current_root.clone(), &key)?;
        let before = db.lookup(since_root.clone(), &key)?;
        let heads: Vec<String> = serde_json::from_value(after["descriptor"]["heads"].clone())?;
        let before = if before.is_null() {
            Vec::new()
        } else {
            serde_json::from_value::<Vec<String>>(before["descriptor"]["heads"].clone())?
                .iter()
                .map(|hash| hash.parse())
                .collect::<std::result::Result<_, _>>()?
        };
        let doc = db.document(room, &key, &heads)?;
        let encoded = doc
            .get_changes(&before)
            .iter()
            .map(|change| STANDARD.encode(change.raw_bytes()))
            .collect::<Vec<_>>();
        if !encoded.is_empty() {
            changes.push(json!({"key": key, "changes": encoded}));
        }
    }

    nodes.sort_unstable_by(|(a, _), (b, _)| a.cmp(b));
    let nodes: Vec<_> = nodes
        .into_iter()
        .map(|(hash, node)| json!({"hash": hash, "node": node}))
        .collect();
    let bundle = json!({
        "protocol": "spool/2", "schema": 2, "room": room, "heads": heads,
        "batches": missing, "nodes": nodes, "documents": changes,
    });
    if serde_json::to_string(&bundle)?.encode_utf16().count() > 16_000_000 {
        return Err("Bundle exceeds 16 MB; use smaller incremental intervals".into());
    }
    Ok(bundle)
}

pub fn export_page(
    db: &impl ExportStore,
    room: &str,
    branch: &str,
    since: &[String],
    target: Option<&[String]>,
    max_bytes: usize,
) -> Result<Value> {
    let heads = match target {
        Some(heads) => db.frontier(room, heads)?.0,
        None => db.branch_heads(room, branch)?,
    };
    let rows = db.batches(room, &heads)?;
    let ids: BTreeSet<_> = rows.iter().map(|(id, _)| id).collect();
    if !since.iter().all(|id| ids.contains(id)) {
        return Err("Sync base is not an ancestor of target".into());
    }
    let known: BTreeSet<_> = db
        .batches(room, since)?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let missing: Vec<_> = rows
        .into_iter()
        .filter(|(id, _)| !known.contains(id))
        .collect();
    if missing.is_empty() {
        return Ok(json!({"bundle": null, "heads": heads, "more": false, "bytes": 0}));
    }
    let mut count = missing.len().min(32);
    let initial: BTreeSet<_> = db.frontier(room, since)?.0.into_iter().collect();
    loop {
        let mut tip = initial.clone();
        for (id, batch) in &missing[..count] {
            let parents: Vec<String> = serde_json::from_value(batch["parents"].clone())?;
            for parent in parents {
                tip.remove(&parent);
            }
            tip.insert(id.clone());
        }
        let tip: Vec<_> = tip.into_iter().collect();
        match export_frontier(db, room, &tip, since) {
            Ok(bundle) => {
                let bytes = serde_json::to_vec(&bundle)?.len();
                if bytes <= max_bytes {
                    return Ok(
                        json!({"bundle": bundle, "heads": heads, "more": count < missing.len(), "bytes": bytes}),
                    );
                }
            }
            Err(error) if !error.to_string().starts_with("Bundle exceeds") => return Err(error),
            Err(_) => {}
        }
        if count == 1 {
            return Err("One atomic batch exceeds the sync page byte limit".into());
        }
        count /= 2;
    }
}
