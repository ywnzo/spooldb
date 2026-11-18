use crate::{Result, vectors};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

enum Backend {
    Cloudflare {
        account: String,
        token: String,
    },
    Local {
        threads: usize,
        cache: Option<PathBuf>,
    },
}

type LoadedModel = (
    String,
    usize,
    Option<PathBuf>,
    crate::local_embeddings::Model,
);
static LOCAL_MODEL: OnceLock<Mutex<Option<LoadedModel>>> = OnceLock::new();

pub struct Provider {
    backend: Backend,
    pub model: String,
    pub id: String,
    pub min_score: f64,
    pub context_chars: u64,
}

impl Provider {
    pub fn load(db: &Connection) -> Result<Option<Self>> {
        if !db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='retrieval_settings')",[],|r| r.get::<_,bool>(0))? {
            return Ok(None);
        }
        let raw: Option<String> = db
            .query_row("SELECT data FROM retrieval_settings WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional()?;
        let settings: Value = raw
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_else(
                || json!({"enabled":true,"provider":"local","model":"multilingual","threads":2}),
            );
        if settings["enabled"] != true {
            return Ok(None);
        }
        let model = settings["model"]
            .as_str()
            .ok_or("Missing configured embedding model")?;
        let (backend, id) = match settings["provider"].as_str().unwrap_or("local") {
            "cloudflare" if model == "@cf/baai/bge-m3" => {
                let (account, token): (String, String) = db.query_row(
                    "SELECT account,token FROM retrieval_credentials WHERE id=1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                if !valid_credentials(&account, &token) || settings["accountId"] != account {
                    return Err("Invalid Workers AI credentials".into());
                }
                (
                    Backend::Cloudflare { account, token },
                    format!("workers-ai:{model}:dense:v1"),
                )
            }
            "local" => {
                crate::local_embeddings::runtime()?;
                let threads = settings["threads"]
                    .as_u64()
                    .filter(|v| matches!(v, 1 | 2 | 4))
                    .unwrap_or(2) as usize;
                let cache = db
                    .path()
                    .map(Path::new)
                    .filter(|file| {
                        file.file_name().is_some_and(|name| name == "shared.sqlite")
                            && std::env::var_os("SPOOL_MODEL_CACHE").is_none()
                    })
                    .and_then(Path::parent)
                    .map(|dir| dir.join("models"));
                (
                    Backend::Local { threads, cache },
                    crate::local_embeddings::Model::identity(model)?,
                )
            }
            _ => return Err("Unsupported embedding provider or model".into()),
        };
        let min_score = settings["minScore"]
            .as_f64()
            .filter(|v| (0.1..=0.9).contains(v))
            .unwrap_or(0.25);
        let context_chars = settings["contextChars"]
            .as_u64()
            .filter(|v| (1000..=24000).contains(v))
            .unwrap_or(6000);
        Ok(Some(Self {
            backend,
            model: model.into(),
            id,
            min_score,
            context_chars,
        }))
    }

    fn external(&self) -> bool {
        matches!(self.backend, Backend::Cloudflare { .. })
    }

    pub fn probe(db: &mut Connection, input: &Value) -> Result<()> {
        crate::retrieval_settings::schema(db).map_err(|error| error.2)?;
        let saved: Option<(String, String)> = db
            .query_row(
                "SELECT account,token FROM retrieval_credentials WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let account = input["accountId"]
            .as_str()
            .or_else(|| saved.as_ref().map(|(id, _)| id.as_str()))
            .ok_or("Enter a valid Cloudflare account ID")?;
        let token = input["token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                saved
                    .as_ref()
                    .filter(|(id, _)| id == account)
                    .map(|(_, token)| token.as_str())
            })
            .ok_or("Enter a valid Workers AI API token")?;
        let model = input["model"].as_str().unwrap_or("@cf/baai/bge-m3");
        if !valid_credentials(account, token) || model != "@cf/baai/bge-m3" {
            return Err("Enter a valid Cloudflare account ID, API token and model".into());
        }
        let provider = Self {
            backend: Backend::Cloudflare {
                account: account.into(),
                token: token.into(),
            },
            model: model.into(),
            id: format!("workers-ai:{model}:dense:v1"),
            min_score: 0.25,
            context_chars: 6000,
        };
        let text = ["SpoolDB connection test"];
        if !reserve(db, "", &text, true)? {
            return Err("Embedding usage limit reached".into());
        }
        let _ = note(db, "", "embedding_probe_requests", 1);
        provider.embed(&text).inspect_err(|_| {
            let _ = note(db, "", "embedding_failures", 1);
        })?;
        Ok(())
    }

    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty()
            || texts.len() > 8
            || texts.iter().any(|text| text.encode_utf16().count() > 16000)
        {
            return Err("Invalid embedding batch".into());
        }
        let (account, token) = match &self.backend {
            Backend::Cloudflare { account, token } => (account, token),
            Backend::Local { threads, cache } => {
                let mut model = LOCAL_MODEL
                    .get_or_init(|| Mutex::new(None))
                    .lock()
                    .map_err(|_| "Local embedding runtime stopped")?;
                if model.as_ref().is_none_or(|value| {
                    value.0 != self.id || value.1 != *threads || value.2 != *cache
                }) {
                    *model = None;
                    let loaded = crate::local_embeddings::Model::load(
                        &self.model,
                        *threads,
                        cache.as_deref(),
                    )?;
                    *model = Some((self.id.clone(), *threads, cache.clone(), loaded));
                }
                return model
                    .as_ref()
                    .ok_or("Missing local embedding model")?
                    .3
                    .embed(texts);
            }
        };
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .max_redirects_will_error(true)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(8)))
            .build()
            .into();
        let endpoint = format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/ai/run/{}",
            account, self.model
        );
        let authorization = format!("Bearer {token}");
        let response = agent
            .post(&endpoint)
            .header("authorization", &authorization)
            .header("content-type", "application/json")
            .send(json!({"text":texts}).to_string())
            .map_err(|_| "Workers AI request failed")?;
        match response.status().as_u16() {
            200 => (),
            401 | 403 => return Err("Workers AI credentials were rejected".into()),
            429 => return Err("Workers AI usage limit was reached".into()),
            _ => return Err("Workers AI is temporarily unavailable".into()),
        }
        let mut bytes = Vec::new();
        response
            .into_body()
            .into_reader()
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|_| "Workers AI response failed")?;
        decode(&bytes, texts.len())
    }

    pub fn index_one(&self, db: &mut Connection, room: &str) -> Result<()> {
        db.execute_batch(vectors::SCHEMA)?;
        type IndexRow = (String, String, String, String, String, String, i64);
        let candidate: Option<IndexRow> = db.query_row(
            &format!("SELECT d.id,d.fingerprint,d.kind,d.title,d.text,d.data,COALESCE(p.next_chunk,0)
                FROM memory_docs d LEFT JOIN memory_vector_progress p
                ON p.room=d.room AND p.id=d.id AND p.model=?2 AND p.fingerprint=d.fingerprint
                WHERE d.room=?1 AND {} AND (p.id IS NOT NULL OR NOT EXISTS(
                    SELECT 1 FROM memory_vectors v WHERE v.room=d.room AND v.id=d.id AND v.model=?2
                    AND v.fingerprint=d.fingerprint))
                ORDER BY CASE WHEN d.kind='conversation' THEN 1 ELSE 0 END,d.seq DESC LIMIT 1",vectors::VISIBLE),
            params![room,self.id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
        ).optional()?;
        let Some((id, fingerprint, kind, title, text, data, progress)) = candidate else {
            return Ok(());
        };
        let data = serde_json::from_str(&data)?;
        let chunks = vectors::chunks(&kind, &title, &text, &data);
        let start = usize::try_from(progress)?.min(chunks.len());
        let end = (start + 8).min(chunks.len());
        let selected = &chunks[start..end];
        let texts: Vec<_> = selected.iter().map(|(_, text)| text.as_str()).collect();
        let vectors = if texts.is_empty() {
            Vec::new()
        } else {
            if !reserve(db, room, &texts, self.external())? {
                return Ok(());
            }
            self.embed(&texts).inspect_err(|_| {
                let _ = note(db, room, "embedding_failures", 1);
            })?
        };
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::memory_index::refresh(&tx, room)?;
        if !tx.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM memory_docs d
            WHERE d.room=?1 AND d.id=?2 AND d.fingerprint=?3 AND {})",
                vectors::VISIBLE
            ),
            params![room, id, fingerprint],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(());
        }
        for ((offset, _), vector) in selected.iter().zip(vectors) {
            tx.execute(
                "INSERT OR REPLACE INTO memory_vectors VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    room,
                    id,
                    self.id,
                    fingerprint,
                    *offset as i64,
                    vectors::encode(&vector)
                ],
            )?;
        }
        if end < chunks.len() {
            tx.execute(
                "INSERT OR REPLACE INTO memory_vector_progress VALUES(?1,?2,?3,?4,?5)",
                params![room, id, self.id, fingerprint, end as i64],
            )?;
        } else {
            tx.execute(
                "DELETE FROM memory_vector_progress WHERE room=?1 AND id=?2 AND model=?3",
                params![room, id, self.id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn query(&self, db: &mut Connection, room: &str, query: &str) -> Result<Option<Vec<f32>>> {
        db.execute_batch(vectors::SCHEMA)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS native_embedding_queries(
            provider TEXT NOT NULL, query_hash TEXT NOT NULL, vector BLOB NOT NULL,
            updated INTEGER NOT NULL, PRIMARY KEY(provider,query_hash));",
        )?;
        let key = format!("{:x}", Sha256::digest(query.as_bytes()));
        let cached: Option<Vec<u8>> = db
            .query_row(
                "SELECT vector FROM native_embedding_queries WHERE provider=?1 AND query_hash=?2",
                params![self.id, key],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(raw) =
            cached.filter(|raw| raw.len() == if self.external() { 4096 } else { 1536 })
        {
            let _ = note(db, room, "query_cache_hits", 1);
            return Ok(Some(
                raw.as_chunks::<4>()
                    .0
                    .iter()
                    .map(|v| f32::from_le_bytes(*v))
                    .collect(),
            ));
        }
        // Honor the legacy quota policy before sending text to the external provider.
        if !reserve(db, room, &[query], self.external())? {
            return Ok(None);
        }
        let _ = note(db, room, "query_cache_misses", 1);
        let mut embedded = self.embed(&[query]).inspect_err(|_| {
            let _ = note(db, room, "embedding_failures", 1);
        })?;
        let vector = embedded.pop().ok_or("Missing query embedding")?;
        db.execute(
            "INSERT OR REPLACE INTO native_embedding_queries VALUES(?1,?2,?3,unixepoch())",
            params![self.id, key, vectors::encode(&vector)],
        )?;
        db.execute("DELETE FROM native_embedding_queries WHERE rowid IN (
            SELECT rowid FROM native_embedding_queries ORDER BY updated DESC,rowid DESC LIMIT -1 OFFSET 256)",[])?;
        Ok(Some(vector))
    }
}

fn valid_credentials(account: &str, token: &str) -> bool {
    account.len() == 32
        && account.bytes().all(|b| b.is_ascii_hexdigit())
        && (20..=256).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn decode(bytes: &[u8], expected: usize) -> Result<Vec<Vec<f32>>> {
    if bytes.len() > 1_048_576 {
        return Err("Invalid Workers AI response".into());
    }
    let data: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid Workers AI response")?;
    let rows = data["result"]["data"]
        .as_array()
        .filter(|rows| rows.len() == expected && data["success"] == true)
        .ok_or("Invalid Workers AI response")?;
    rows.iter()
        .map(|row| {
            let raw: Vec<f64> =
                serde_json::from_value(row.clone()).map_err(|_| "Invalid embedding")?;
            if raw.len() != 1024 {
                return Err("Invalid embedding dimensions".into());
            }
            vectors::normalized(&raw).ok_or_else(|| "Invalid embedding".into())
        })
        .collect()
}

pub fn note(db: &Connection, room: &str, metric: &str, count: i64) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO retrieval_usage VALUES(date('now'),?1,?2,?3)
         ON CONFLICT(day,room,metric) DO UPDATE SET value=value+excluded.value",
        params![room, metric, count],
    )?;
    Ok(())
}

fn reserve(db: &mut Connection, room: &str, text: &[&str], external: bool) -> Result<bool> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let raw: Option<String> = tx
        .query_row(
            "SELECT data FROM retrieval_usage_limits WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let limits: Value = raw
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or(Value::Null);
    let chars = text
        .iter()
        .map(|line| line.encode_utf16().count() as i64)
        .sum::<i64>();
    if !external {
        note(&tx, room, "embedding_requests", 1)?;
        note(&tx, room, "embedding_characters", chars)?;
        tx.commit()?;
        return Ok(true);
    }
    for (key, metric, delta, scope) in [
        ("dailyRequests", "external_requests", 1, None),
        ("dailyCharacters", "external_characters", chars, None),
        (
            "projectDailyCharacters",
            "external_characters",
            chars,
            Some(room),
        ),
    ] {
        let limit = limits[key].as_i64().unwrap_or(0);
        if limit <= 0 {
            continue;
        }
        let used: i64 = tx.query_row(
            "SELECT COALESCE(sum(value),0) FROM retrieval_usage
            WHERE day=date('now') AND metric=?1 AND (?2 IS NULL OR room=?2)",
            params![metric, scope],
            |r| r.get(0),
        )?;
        if used.saturating_add(delta) > limit {
            note(&tx, room, "budget_denied", 1)?;
            tx.commit()?;
            return Ok(false);
        }
    }
    for (metric, delta) in [
        ("external_requests", 1),
        ("embedding_requests", 1),
        ("external_characters", chars),
        ("embedding_characters", chars),
    ] {
        note(&tx, room, metric, delta)?;
    }
    tx.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_dimensions_and_normalizes_provider_response() {
        let mut item = vec![0.0; 1024];
        item[0] = 3.0;
        item[1] = 4.0;
        let response = json!({"success":true,"result":{"data":[item]}}).to_string();
        let decoded = decode(response.as_bytes(), 1).unwrap();
        assert_eq!(&decoded[0][..2], &[0.6, 0.8]);
        assert!(decode(response.as_bytes(), 2).is_err());
        assert!(decode(br#"{"success":true,"result":{"data":[[0,1]]}}"#, 1).is_err());
    }
}
