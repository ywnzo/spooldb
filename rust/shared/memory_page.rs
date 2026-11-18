use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
pub struct Card {
    pub data: String,
    pub lifecycle: Option<String>,
    pub origin: Option<String>,
    pub title: String,
    pub text: String,
    pub task_id: Option<String>,
    pub seq: i64,
}

pub fn page_parameters(input: &Value) -> Option<(u64, u64)> {
    let offset = integer(&input["offset"], 0, 9_007_199_254_740_991)?;
    let limit = integer(&input["limit"], 12_000, 20_000)?;
    (limit > 0).then_some((offset, limit))
}

pub fn format_card(card: Card) -> serde_json::Result<Value> {
    let mut value: Value = serde_json::from_str(&card.data)?;
    if let Some(origin) = card.origin {
        let origin: Value = serde_json::from_str(&origin)?;
        for (field, source) in [
            ("sessionId", "sessionId"),
            ("turnId", "turnId"),
            ("messageId", "itemId"),
            ("originalSource", "source"),
            ("harness", "harness"),
            ("capturedBy", "principal"),
        ] {
            if let Some(item) = origin.get(source) {
                value["source"][field] = item.clone();
            }
        }
    }
    value["title"] = json!(card.title);
    value["taskId"] = json!(card.task_id);
    value["sequence"] = json!(card.seq);
    value["lifecycle"] = match card.lifecycle {
        Some(data) => serde_json::from_str(&data)?,
        None => json!({"status":"active","revision":0}),
    };
    Ok(value)
}

pub fn format_page(card: Card, offset: u64, limit: u64) -> serde_json::Result<Value> {
    let utf16 = card.text.encode_utf16().collect::<Vec<_>>();
    let range_start = offset.min(utf16.len() as u64) as usize;
    let end = offset + limit;
    let range_end = end.min(utf16.len() as u64) as usize;
    let more = end < utf16.len() as u64;
    let text = String::from_utf16_lossy(&utf16[range_start..range_end]);
    let mut value = format_card(card)?;
    value["text"] = json!(text);
    value["truncated"] = json!(offset > 0 || more);
    value["nextOffset"] = json!(more.then_some(end));
    Ok(value)
}

pub fn reference_freshness(value: &mut Value) {
    value["freshness"] = json!(if value["files"]
        .as_array()
        .is_some_and(|files| !files.is_empty())
    {
        "git-reference"
    } else {
        "not-code-verified"
    });
    value["reconciliation"] = json!({"status":"unverified","message":"Use a local companion to compare this reference with your checkout; the relay cannot inspect your Git repository."});
}

fn integer(value: &Value, default: u64, max: u64) -> Option<u64> {
    if value.is_null() {
        Some(default)
    } else {
        value.as_u64().filter(|n| *n <= max)
    }
}
