use serde_json::{Value, json};
use sha2::{Digest, Sha256};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub trait Nodes {
    fn load(&self, hash: &str) -> Result<Value>;
    fn insert(&self, hash: &str, body: &str) -> Result<()>;
}

pub fn route(key: &str) -> Result<[u8; 4]> {
    let hash = Sha256::digest(serde_json::to_vec(key)?);
    Ok([hash[0] >> 4, hash[0] & 15, hash[1] >> 4, hash[1] & 15])
}

pub fn update(
    storage: &impl Nodes,
    hash: Option<&str>,
    buckets: &[u8],
    key: &str,
    value: Option<Value>,
) -> Result<Option<String>> {
    let existing = hash.map(|hash| storage.load(hash)).transpose()?;
    let node = if let Some((&bucket, next)) = buckets.split_first() {
        let mut children: Vec<Option<String>> = match existing {
            Some(node) => serde_json::from_value(node["children"].clone())?,
            None => vec![None; 16],
        };
        if children.len() != 16 {
            return Err("Invalid manifest children".into());
        }
        let child = &mut children[usize::from(bucket)];
        *child = update(storage, child.as_deref(), next, key, value)?;
        if children.iter().all(Option::is_none) {
            return Ok(None);
        }
        json!({"children": children})
    } else {
        let mut entries: Vec<(String, Value)> = match existing {
            Some(node) => serde_json::from_value(node["entries"].clone())?,
            None => Vec::new(),
        };
        entries.retain(|(name, _)| name != key);
        if let Some(value) = value {
            entries.push((key.to_owned(), value));
        }
        if entries.is_empty() {
            return Ok(None);
        }
        entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
        json!({"entries": entries})
    };
    let body = serde_json::to_string(&node)?;
    let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    storage.insert(&hash, &body)?;
    Ok(Some(hash))
}
