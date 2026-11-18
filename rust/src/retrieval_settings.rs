use crate::{
    embeddings::Provider,
    memory_write::{Fault, bad},
    vectors,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, Fault>;

fn internal<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| Fault(500, "INTERNAL", "Retrieval settings are unavailable".into()))
}

const MODEL: &str = "@cf/baai/bge-m3";

pub fn schema(db: &Connection) -> Result<()> {
    internal(db.execute_batch(vectors::SCHEMA))?;
    internal(db.execute_batch("CREATE TABLE IF NOT EXISTS retrieval_settings(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS retrieval_credentials(id INTEGER PRIMARY KEY,account TEXT NOT NULL,token TEXT NOT NULL);"))
}

fn settings(db: &Connection) -> Result<(i64, Value)> {
    let row: Option<(i64, String)> = internal(
        db.query_row(
            "SELECT revision,data FROM retrieval_settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional(),
    )?;
    Ok(match row {
        Some((revision, raw)) => {
            let mut value: Value = serde_json::from_str(&raw)
                .map_err(|_| bad("RETRIEVAL_SETTINGS", "Invalid saved retrieval settings"))?;
            if value.get("provider").is_none() {
                value["provider"] = json!("local");
            }
            if value.get("accountId").is_none() {
                value["accountId"] = json!("");
            }
            (revision, value)
        }
        None => (
            0,
            json!({"enabled":true,"provider":"local","model":"multilingual","accountId":"",
            "minScore":0.25,"contextChars":6000,"threads":2}),
        ),
    })
}

fn limits(db: &Connection) -> Result<(i64, Value)> {
    let row: Option<(i64, String)> = internal(
        db.query_row(
            "SELECT revision,data FROM retrieval_usage_limits WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional(),
    )?;
    Ok(match row {
        Some((revision, raw)) => (
            revision,
            serde_json::from_str(&raw)
                .map_err(|_| bad("USAGE_LIMITS", "Invalid saved usage limits"))?,
        ),
        None => (
            0,
            json!({"dailyRequests":0,"dailyCharacters":0,"projectDailyCharacters":0}),
        ),
    })
}

fn account_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_token(value: &str) -> bool {
    (20..=256).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn configure(db: &Connection, input: &Value) -> Result<()> {
    let (revision, _) = settings(db)?;
    if input["expectedRevision"].as_i64() != Some(revision) {
        return Err(Fault(
            409,
            "RETRIEVAL_CONFLICT",
            "Retrieval settings changed; refresh before saving".into(),
        ));
    }
    let mut config = input["settings"].clone();
    if !config.is_object() {
        return Err(bad("RETRIEVAL_SETTINGS", "Invalid retrieval settings"));
    }
    if config.get("provider").is_none() {
        config["provider"] = json!("local");
    }
    if config.get("accountId").is_none() {
        config["accountId"] = json!("");
    }
    let provider = config["provider"].as_str().unwrap_or_default();
    let account = config["accountId"]
        .as_str()
        .ok_or_else(|| bad("RETRIEVAL_SETTINGS", "Invalid account ID"))?;
    let model = config["model"].as_str().unwrap_or_default();
    let enabled = config["enabled"].as_bool();
    if config.as_object().is_none_or(|v| v.len() != 7)
        || !(account.is_empty() || account_id(account))
        || enabled.is_none()
        || !matches!(config["threads"].as_i64(), Some(1 | 2 | 4))
        || !config["contextChars"]
            .as_u64()
            .is_some_and(|v| (1000..=24000).contains(&v))
        || !config["minScore"]
            .as_f64()
            .is_some_and(|v| (0.1..=0.9).contains(&v))
        || !matches!(
            (provider, model),
            ("cloudflare", MODEL) | ("local", "multilingual" | "english-small")
        )
    {
        return Err(bad(
            "RETRIEVAL_SETTINGS",
            "Choose a supported model, CPU limit, relevance threshold and context budget",
        ));
    }
    let token = input
        .get("token")
        .map(|v| {
            v.as_str().filter(|s| valid_token(s)).ok_or_else(|| {
                bad(
                    "RETRIEVAL_CREDENTIALS",
                    "Enter a valid Workers AI API token",
                )
            })
        })
        .transpose()?;
    let clear = input["clearToken"] == true;
    if provider == "cloudflare" && enabled == Some(true) {
        if input["externalProcessingApproved"] != true {
            return Err(bad(
                "RETRIEVAL_CONSENT",
                "Confirm that indexed passages and search queries may be sent to Cloudflare",
            ));
        }
        let existing: Option<String> = internal(
            db.query_row(
                "SELECT account FROM retrieval_credentials WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional(),
        )?;
        if clear
            || !account_id(account)
            || (token.is_none() && existing.as_deref() != Some(account))
        {
            return Err(bad(
                "RETRIEVAL_CREDENTIALS",
                "Enter an Account ID and API token for this account",
            ));
        }
    }
    if clear {
        internal(db.execute("DELETE FROM retrieval_credentials WHERE id=1", []))?;
    } else if let Some(token) = token {
        if !account_id(account) {
            return Err(bad(
                "RETRIEVAL_CREDENTIALS",
                "Enter a valid Cloudflare Account ID",
            ));
        }
        internal(db.execute(
            "INSERT OR REPLACE INTO retrieval_credentials VALUES(1,?1,?2)",
            params![account, token],
        ))?;
    }
    internal(db.execute(
        "INSERT OR REPLACE INTO retrieval_settings VALUES(1,?1,?2)",
        params![revision + 1, config.to_string()],
    ))?;
    Ok(())
}

fn update_limits(db: &Connection, input: &Value) -> Result<()> {
    let (revision, _) = limits(db)?;
    if input["expectedRevision"].as_i64() != Some(revision) {
        return Err(Fault(
            409,
            "USAGE_CONFLICT",
            "Usage limits changed; refresh before saving".into(),
        ));
    }
    let value = &input["limits"];
    if value.as_object().is_none_or(|v| v.len() != 3)
        || ["dailyRequests", "dailyCharacters", "projectDailyCharacters"]
            .iter()
            .any(|key| !value[*key].as_u64().is_some_and(|v| v <= 1_000_000_000))
    {
        return Err(bad(
            "USAGE_LIMITS",
            "Limits must be whole numbers from 0 to 1,000,000,000",
        ));
    }
    internal(db.execute(
        "INSERT OR REPLACE INTO retrieval_usage_limits VALUES(1,?1,?2)",
        params![revision + 1, value.to_string()],
    ))?;
    Ok(())
}

fn status(db: &Connection) -> Result<Value> {
    let (revision, settings) = settings(db)?;
    let (usage_revision, mut limits) = limits(db)?;
    limits["revision"] = json!(usage_revision);
    let day: String = internal(db.query_row("SELECT date('now')", [], |r| r.get(0)))?;
    let mut statement =
        internal(db.prepare("SELECT room,metric,value FROM retrieval_usage WHERE day=?1"))?;
    let mut rows = internal(statement.query([&day]))?;
    let mut totals = json!({});
    let mut projects = json!({});
    while let Some(row) = internal(rows.next())? {
        let (room, metric, amount): (String, String, i64) =
            internal((|| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))())?;
        let total = totals[&metric].as_i64().unwrap_or(0).saturating_add(amount);
        totals[&metric] = json!(total);
        if !room.is_empty() {
            projects[&room][&metric] = json!(amount);
        }
    }
    let account: Option<String> = internal(
        db.query_row(
            "SELECT account FROM retrieval_credentials WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional(),
    )?;
    let provider = Provider::load(db).ok().flatten();
    let status = if settings["enabled"] == false {
        "disabled"
    } else if provider.is_some() {
        "ready"
    } else {
        "error"
    };
    let mut backlog = Vec::new();
    let mut selecting =
        internal(db.prepare("SELECT room,name FROM team_projects ORDER BY name,room"))?;
    let mut rooms = internal(selecting.query([]))?;
    while let Some(room) = internal(rooms.next())? {
        let (id, name): (String, String) = internal((|| Ok((room.get(0)?, room.get(1)?)))())?;
        let count = if let Some(provider) = &provider {
            let sql = format!("SELECT count(*) FROM memory_docs d WHERE room=?1 AND {} AND
                (EXISTS(SELECT 1 FROM memory_vector_progress p WHERE p.room=d.room AND p.id=d.id AND p.model=?2 AND p.fingerprint=d.fingerprint)
                 OR NOT EXISTS(SELECT 1 FROM memory_vectors v WHERE v.room=d.room AND v.id=d.id AND v.model=?2 AND v.fingerprint=d.fingerprint))",vectors::VISIBLE);
            Some(internal(db.query_row(
                &sql,
                params![id, provider.id],
                |r| r.get::<_, i64>(0),
            ))?)
        } else {
            None
        };
        backlog.push(json!({"room":id,"name":name,"records":count}));
    }
    let archived: i64 = internal(db.query_row(
        "SELECT count(*) FROM memory_state WHERE status IN ('archived','resolved','superseded')",
        [],
        |r| r.get(0),
    ))?;
    Ok(
        json!({"supported":true,"settings":settings,"revision":revision,"status":status,
        "error":if status=="error"{Some("The configured embedding model is unavailable. Keyword search is available.")}else{None},
        "activeModel":provider.as_ref().map(|provider| &provider.model),
        "models":[{"key":"multilingual","name":"Multilingual MiniLM","description":"Local multilingual embeddings."},
            {"key":"english-small","name":"English MiniLM","description":"Local English embeddings."}],
        "cloudflareModels":[{"key":MODEL,"name":"BGE-M3 · multilingual","description":"Cloudflare-hosted embeddings."}],
        "cloudflare":{"configured":account.is_some(),"accountId":account.unwrap_or_default()},
        "cleanup":{"mode":"archive","archived":archived,"message":"Archived records remain in history."},
        "usage":{"day":day,"retentionDays":90,"limits":limits,"totals":totals,"projects":projects,"backlog":backlog,
            "queue":{"queries":0,"indexBatches":0}}}),
    )
}

pub fn run(db: &Connection, input: &Value) -> Result<Value> {
    schema(db)?;
    match input["action"].as_str() {
        None | Some("status" | "retry") => (),
        Some("configure") => configure(db, input)?,
        Some("limits") => update_limits(db, input)?,
        _ => {
            return Err(bad(
                "RETRIEVAL_ACTION",
                "Choose status, configure, limits or retry",
            ));
        }
    }
    status(db)
}
