use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const SCHEMA:&str="CREATE TABLE IF NOT EXISTS memory_vectors(room TEXT NOT NULL,id TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,chunk INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(room,id,model,chunk));
CREATE INDEX IF NOT EXISTS memory_vectors_scan ON memory_vectors(room,model,id,chunk);
CREATE TABLE IF NOT EXISTS memory_vector_progress(room TEXT NOT NULL,id TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,next_chunk INTEGER NOT NULL,PRIMARY KEY(room,id,model));
CREATE TABLE IF NOT EXISTS retrieval_usage(day TEXT NOT NULL,room TEXT NOT NULL,metric TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(day,room,metric));
CREATE TABLE IF NOT EXISTS retrieval_usage_limits(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);";

pub const VISIBLE:&str="COALESCE(json_extract(d.data,'$.lifecycleControl'),0)<>1
 AND NOT EXISTS (SELECT 1 FROM memory_state s WHERE s.room=d.room AND s.id=d.id AND s.status IN ('archived','resolved','superseded'))
 AND (d.kind<>'task' OR (instr(d.text,'Current request (source text, not verified findings):'||char(10))<>1
  AND COALESCE(json_extract(d.data,'$.status'),'')<>'done'
  AND NOT EXISTS (SELECT 1 FROM memory_docs n WHERE n.room=d.room AND n.kind='task' AND n.task_id=d.task_id
   AND CAST(json_extract(n.data,'$.revision') AS INTEGER)>CAST(json_extract(d.data,'$.revision') AS INTEGER))))
 AND NOT EXISTS (SELECT 1 FROM memory_docs bg WHERE bg.room=d.room AND bg.kind='task' AND bg.task_id=d.task_id
  AND instr(bg.text,'Current request (source text, not verified findings):'||char(10)||
    'This is an app-generated request for a suggested next user message. The user did not write this message.')=1)";

pub fn normalized(vector: &[f64]) -> Option<Vec<f32>> {
    if vector.is_empty() || vector.len() > 4096 || vector.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let norm = vector.iter().fold(0.0_f64, |acc, value| acc.hypot(*value));
    if norm == 0.0 || !norm.is_finite() {
        return None;
    }
    Some(vector.iter().map(|value| (*value / norm) as f32).collect())
}
pub fn encode(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}
pub fn score(bytes: &[u8], query: &[f32]) -> Option<f64> {
    if bytes.len() != 4 * query.len() {
        return None;
    }
    let result = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .zip(query)
        .map(|(raw, query)| f32::from_le_bytes(*raw) as f64 * *query as f64)
        .sum::<f64>();
    result.is_finite().then_some(result)
}

pub fn chunks(kind: &str, title: &str, text: &str, data: &Value) -> Vec<(usize, String)> {
    let title = String::from_utf16_lossy(&title.encode_utf16().take(120).collect::<Vec<_>>());
    let paths = data["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| file["path"].as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let paths = String::from_utf16_lossy(&paths.encode_utf16().take(100).collect::<Vec<_>>());
    let text = text.encode_utf16().collect::<Vec<_>>();
    (0..text.len().max(1))
        .step_by(600)
        .map(|offset| {
            let chunk = String::from_utf16_lossy(&text[offset..(offset + 750).min(text.len())]);
            (offset, format!("{kind}: {title}\n{paths}\n{chunk}"))
        })
        .collect()
}

pub fn excerpt(text: &str, offset: usize) -> (String, bool) {
    let text = text.encode_utf16().collect::<Vec<_>>();
    let start = offset.min(text.len().saturating_sub(750));
    (
        String::from_utf16_lossy(&text[start..(start + 750).min(text.len())]),
        text.len() > 750,
    )
}

fn identifiers(query: &str) -> Vec<&str> {
    query
        .split(|c: char| !c.is_ascii_alphanumeric() && !"/._-".contains(c))
        .filter(|token| {
            let bytes = token.as_bytes();
            token.contains('/') && token.split('/').all(|part| !part.is_empty())
                || bytes.len() >= 4
                    && bytes.first().is_some_and(u8::is_ascii_uppercase)
                    && bytes
                        .iter()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
                || bytes
                    .windows(2)
                    .any(|pair| pair[0].is_ascii_lowercase() && pair[1].is_ascii_uppercase())
        })
        .collect()
}
struct Ranked {
    item: Value,
    score: f64,
    channels: Vec<&'static str>,
}

pub fn fuse(lexical: Vec<Value>, semantic: Vec<Value>, query: &str) -> Vec<Value> {
    let ids = identifiers(query);
    let mut scores: BTreeMap<String, Ranked> = BTreeMap::new();
    let mut order = Vec::new();
    for (channel, items) in [("keyword", lexical), ("semantic", semantic)] {
        for (position, mut item) in items.into_iter().enumerate() {
            let Some(key) = item["id"].as_str().map(str::to_owned) else {
                continue;
            };
            if !scores.contains_key(&key) {
                order.push(key.clone());
            }
            let ranked = scores.entry(key).or_insert_with(|| Ranked {
                item: item.clone(),
                score: 0.0,
                channels: Vec::new(),
            });
            let rank = 61.0 + position as f64;
            if channel == "semantic" {
                ranked.score +=
                    1.5 / rank + item["match"]["semantic"].as_f64().unwrap_or_default() * 0.2;
                if ranked.channels.contains(&"keyword") {
                    item["match"]["keyword"] = json!(true);
                }
                ranked.item = item;
            } else {
                ranked.score += 1.0 / rank;
                let matches = ids.iter().any(|id| {
                    ["title", "text"]
                        .iter()
                        .any(|key| item[*key].as_str().is_some_and(|s| s.contains(id)))
                        || item["files"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|file| file["path"].as_str().is_some_and(|s| s.contains(id)))
                });
                if matches {
                    ranked.score += 1.0;
                }
            }
            ranked.channels.push(channel);
        }
    }
    let mut out = order
        .into_iter()
        .filter_map(|key| scores.remove(&key))
        .collect::<Vec<_>>();
    out.sort_by(|a, b| {
        b.score.total_cmp(&a.score).then_with(|| {
            b.item["sequence"]
                .as_i64()
                .cmp(&a.item["sequence"].as_i64())
        })
    });
    out.into_iter()
        .map(|mut row| {
            row.item["retrievedBy"] = json!(row.channels);
            row.item
        })
        .collect()
}
