use crate::{
    Result, bundles, manifest, memory_context, memory_index, memory_mutation, memory_page,
    memory_search, memory_write, native_memory::NativeMemory, shards, workspace,
};
use axum::{
    Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;

const RELEASE_VERSION: &str = include_str!("../../package.json");
const MAX_BODY: usize = 16_000_000;
const MAX_PAGE: usize = 4 * 1024 * 1024;

struct Relay {
    database: PathBuf,
    config: PathBuf,
    requests: Semaphore,
    origin: String,
    certificate: Option<String>,
    version: String,
    update_gate: PathBuf,
    control_socket: PathBuf,
}

type HttpResult<T> = std::result::Result<T, Fault>;

struct Fault(StatusCode, &'static str, std::borrow::Cow<'static, str>);

impl Fault {
    fn new(
        status: StatusCode,
        code: &'static str,
        text: impl Into<std::borrow::Cow<'static, str>>,
    ) -> Self {
        Self(status, code, text.into())
    }
}

impl IntoResponse for Fault {
    fn into_response(self) -> Response {
        send(self.0, json!({"error":{"code":self.1,"message":self.2}}))
    }
}

fn send(status: StatusCode, mut value: Value) -> Response {
    value["protocol"] = json!("spool-relay/1");
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        axum::Json(value),
    )
        .into_response()
}

fn bad(code: &'static str, message: &'static str) -> Fault {
    Fault::new(StatusCode::BAD_REQUEST, code, message)
}

fn internal() -> Fault {
    Fault::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL",
        "Relay unavailable",
    )
}

fn read_config(path: &Path) -> Result<Value> {
    let config: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let entries = config["credentials"]
        .as_array()
        .ok_or("Invalid credentials file")?;
    let mut hashes = BTreeSet::new();
    for credential in entries {
        let id = credential["id"].as_str().ok_or("Invalid credential ID")?;
        let hash = credential["tokenHash"]
            .as_str()
            .ok_or("Invalid credential hash")?;
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || !valid_hash(hash)
            || !hashes.insert(hash)
        {
            return Err("Invalid or duplicate credential".into());
        }
        let rooms = credential["rooms"]
            .as_object()
            .ok_or("Invalid room grants")?;
        for (room, role) in rooms {
            if !valid_room(room) || !matches!(role.as_str(), Some("read" | "write")) {
                return Err("Invalid room grant".into());
            }
        }
    }
    Ok(config)
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn valid_room(room: &str) -> bool {
    room.len() <= 180 && shards::validate_id(room, "room").is_ok()
}

fn authorize(
    config: &Value,
    db: &rusqlite::Transaction<'_>,
    headers: &HeaderMap,
    room: &str,
    write: bool,
) -> HttpResult<String> {
    let unauthorized = || {
        Fault::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Authentication required",
        )
    };
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|token| {
            (32..=128).contains(&token.len())
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        })
        .ok_or_else(unauthorized)?;
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    if managed(db).map_err(|_| internal())? {
        let (id, role) =
            workspace::project_member(&NativeMemory(db), room, &hash).map_err(write_fault)?;
        if write && role != "write" {
            return Err(Fault::new(
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
                "Room access denied",
            ));
        }
        return Ok(id);
    }
    let credential = config["credentials"]
        .as_array()
        .ok_or_else(internal)?
        .iter()
        .find(|entry| entry["tokenHash"] == hash)
        .ok_or_else(unauthorized)?;
    let role = credential["rooms"][room].as_str();
    if !(role == Some("write") || role == Some("read") && !write) {
        return Err(Fault::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "Room access denied",
        ));
    }
    credential["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(internal)
}

fn heads(value: &Value) -> HttpResult<Vec<String>> {
    let parsed: Vec<String> = serde_json::from_value(value.clone())
        .map_err(|_| bad("INVALID_FRONTIER", "Expected at most 128 causal hashes"))?;
    if parsed.len() > 128 || !parsed.iter().all(|head| valid_hash(head)) {
        return Err(bad(
            "INVALID_FRONTIER",
            "Expected at most 128 causal hashes",
        ));
    }
    Ok(parsed)
}

fn sync_fault(error: Box<dyn std::error::Error>) -> Fault {
    let message = error.to_string();
    if message.contains("atomic batch exceeds") {
        Fault::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "BATCH_TOO_LARGE",
            "One atomic batch exceeds the page limit",
        )
    } else if [
        "Missing",
        "Incomplete",
        "not an ancestor",
        "Query returned no rows",
    ]
    .iter()
    .any(|part| message.contains(part))
    {
        Fault::new(
            StatusCode::CONFLICT,
            "MISSING_DEPENDENCIES",
            "Causal base missing; reset sync cursors",
        )
    } else {
        Fault::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_BUNDLE",
            "Invalid causal data",
        )
    }
}

fn handle_room(
    state: &Relay,
    headers: &HeaderMap,
    room: &str,
    action: &str,
    input: &Value,
    source_digest: Option<&str>,
) -> HttpResult<Value> {
    let config = read_config(&state.config).map_err(|_| internal())?;
    let mut db = Connection::open_with_flags(&state.database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| internal())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| internal())?;
    let branch = format!("relay-{room}");
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| internal())?;
    if state.update_gate.try_exists().map_err(|_| internal())? {
        return Err(update_in_progress());
    }
    let principal = authorize(
        &config,
        &tx,
        headers,
        room,
        matches!(action, "push" | "source"),
    )?;
    let managed = managed(&tx).map_err(|_| internal())?;
    let mut config = config;
    if managed {
        config["referencesOnly"] = json!(true);
    }
    if action == "push" && references_only(&config) {
        return Err(Fault::new(
            StatusCode::FORBIDDEN,
            "GIT_ONLY",
            "Shared project memory does not accept repository sync bundles",
        ));
    }
    let stored: Option<String> = tx
        .query_row(
            "SELECT heads FROM shard_refs WHERE name=?1 AND room=?2",
            params![branch, room],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| internal())?;
    let stored = if stored.is_none() && managed {
        let created = shards::create_room(&tx, room, &branch).map_err(sync_fault)?;
        created["heads"]
            .as_array()
            .map(|_| created["heads"].to_string())
    } else {
        stored
    };
    let current = stored
        .map(|value| serde_json::from_str::<Vec<String>>(&value))
        .transpose()
        .map_err(|_| internal())?
        .unwrap_or_default();
    let policy = project_policy(&tx, room).map_err(|_| internal())?;
    let mut result = match action {
        "state" => {
            let mut state = policy.clone().unwrap_or_else(|| json!({}));
            state["heads"] = json!(current);
            state["maxPageBytes"] = json!(MAX_PAGE);
            state["memoryLifecycle"] = json!(1);
            state
        }
        "review" => {
            if current.is_empty() {
                return Err(Fault::new(
                    StatusCode::CONFLICT,
                    "ROOM_EMPTY",
                    "Sync this room before opening review",
                ));
            }
            if input["command"] == "publish" && !references_only(&config) {
                authorize(&config, &tx, headers, room, true)?;
            }
            crate::review::run(
                &NativeMemory(&tx),
                &bundles::NativeExport(&tx),
                room,
                &principal,
                input,
                references_only(&config),
            )
            .map_err(write_fault)?
        }
        "source" => {
            if current.is_empty() {
                return Err(Fault::new(
                    StatusCode::CONFLICT,
                    "ROOM_EMPTY",
                    "Create the shared project first",
                ));
            }
            let sharing = policy
                .as_ref()
                .map(|item| item["sharing"].clone())
                .unwrap_or_else(default_sharing);
            crate::source::ingest(
                &NativeMemory(&tx),
                room,
                &principal,
                input,
                &sharing,
                source_digest,
            )
            .map_err(write_fault)?
        }
        "memory" => {
            if current.is_empty() {
                return Err(Fault::new(
                    StatusCode::CONFLICT,
                    "ROOM_EMPTY",
                    "Sync this project before using memory",
                ));
            }
            let sharing = policy
                .as_ref()
                .map(|policy| policy["sharing"].clone())
                .unwrap_or_else(default_sharing);
            if memory_mutation::command(input) {
                authorize(&config, &tx, headers, room, true)?;
                let input = memory_write::apply_sharing(input, &sharing).map_err(write_fault)?;
                let mut result = memory_mutation::write(
                    &crate::native_memory::NativeMemory(&tx),
                    room,
                    &input,
                    &principal,
                    references_only(&config),
                )
                .map_err(write_fault)?;
                result["sourcePrefix"] = json!(format!("@machines/{principal}/"));
                result["workspaceSharing"] = sharing;
                result
            } else {
                let result = read_memory(&tx, room, input, &config, &principal, sharing)?;
                authorize(
                    &read_config(&state.config).map_err(|_| internal())?,
                    &tx,
                    headers,
                    room,
                    false,
                )?;
                result
            }
        }
        "pull" => {
            let since = heads(&input["since"])?;
            let target = input.get("heads").map(heads).transpose()?;
            if target.as_ref().is_some_and(Vec::is_empty) {
                return Err(bad("INVALID_FRONTIER", "Target heads cannot be empty"));
            }
            if current.is_empty() {
                if !since.is_empty() {
                    return Err(Fault::new(
                        StatusCode::CONFLICT,
                        "MISSING_DEPENDENCIES",
                        "Relay history is missing; reset sync cursors",
                    ));
                }
                json!({"bundle": null, "heads": [], "more": false, "bytes": 0})
            } else {
                bundles::export_page(&tx, room, &branch, &since, target.as_deref(), MAX_PAGE)
                    .map_err(sync_fault)?
            }
        }
        "push" => {
            let bundle = &input["bundle"];
            if bundle["room"] != room {
                return Err(Fault::new(
                    StatusCode::FORBIDDEN,
                    "ROOM_MISMATCH",
                    "Bundle room does not match authorized room",
                ));
            }
            let accepted = heads(&bundle["heads"])?;
            if accepted.is_empty() {
                return Err(bad("INVALID_FRONTIER", "Push heads cannot be empty"));
            }
            if serde_json::to_vec(bundle).map_err(|_| internal())?.len() > MAX_PAGE {
                return Err(Fault::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "PAGE_TOO_LARGE",
                    "Bundle exceeds relay page size",
                ));
            }
            let imported = bundles::import(&tx, &branch, bundle).map_err(sync_fault)?;
            heads(&imported["heads"])?;
            let mut sorted = accepted.clone();
            sorted.sort_unstable();
            tx.execute(
                "INSERT OR IGNORE INTO relay_audit(room,principal,heads,accepted_at)
                 VALUES(?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![
                    room,
                    principal,
                    serde_json::to_string(&sorted).map_err(|_| internal())?
                ],
            )
            .map_err(|_| internal())?;
            json!({"acceptedHeads":accepted,"heads":imported["heads"],"durable":true})
        }
        _ => return Err(internal()),
    };
    tx.commit().map_err(|_| internal())?;
    result["room"] = json!(room);
    Ok(result)
}

fn write_fault(error: memory_write::Fault) -> Fault {
    Fault::new(
        StatusCode::from_u16(error.0).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        error.1,
        error.2,
    )
}

fn references_only(config: &Value) -> bool {
    config["referencesOnly"] == true || config["projects"].is_array()
}

fn default_sharing() -> Value {
    json!({"handoffs":true,"decisions":true,"findings":true,"tasks":true,"conversations":true})
}

fn project_policy(db: &rusqlite::Transaction<'_>, room: &str) -> Result<Option<Value>> {
    let available: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workspace_sharing')",
        [],
        |row| row.get(0),
    )?;
    if !available {
        return Ok(None);
    }
    workspace::policy(&NativeMemory(db), room)
        .map(Some)
        .map_err(|error| error.2.into())
}

pub fn local_memory(database: &std::path::Path, room: &str, input: &Value) -> Result<Value> {
    local_memory_scoped(database, room, input, None)?
        .ok_or_else(|| "Local memory is unavailable".into())
}

pub fn local_memory_scoped(
    database: &std::path::Path,
    room: &str,
    input: &Value,
    private: Option<&str>,
) -> Result<Option<Value>> {
    let mut db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(5))?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let write = memory_mutation::command(input);
    if let Some(key) = private {
        let table: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_private')",
            [],
            |row| row.get(0),
        )?;
        if !write {
            if !table {
                return Ok(None);
            }
            let id = (input["command"] == "get")
                .then(|| input["id"].as_str().map(|id| format!("m:{id}")))
                .flatten();
            if !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM team_private
                WHERE remote=?1 AND (?2 IS NULL OR id=?2))",
                params![key, id],
                |row| row.get::<_, bool>(0),
            )? {
                return Ok(None);
            }
        } else if !table {
            tx.execute_batch(
                "CREATE TABLE team_private(remote TEXT,id TEXT,PRIMARY KEY(remote,id))",
            )?;
        }
    }
    tx.execute_batch(memory_index::SCHEMA)?;
    let branch = format!("relay-{room}");
    if !tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM shard_refs WHERE name=?1 AND room=?2)",
        params![branch, room],
        |row| row.get::<_, bool>(0),
    )? {
        shards::create_room(&tx, room, &branch)?;
    }
    let mut value = if write {
        let mut write_input = input.clone();
        if private.is_some() {
            memory_index::refresh(&tx, room)?;
            for field in ["refs", "supersedes", "resolves", "resolveIds"] {
                if let Some(ids) = write_input[field].as_array_mut() {
                    let mut local = Vec::new();
                    for id in ids.drain(..) {
                        if tx.query_row(
                            "SELECT EXISTS(SELECT 1 FROM memory_docs WHERE room=?1 AND id=?2)",
                            params![room, id.as_str()],
                            |row| row.get::<_, bool>(0),
                        )? {
                            local.push(id);
                        }
                    }
                    *ids = local;
                }
            }
        }
        memory_mutation::write(&NativeMemory(&tx), room, &write_input, "local-agent", true)
            .map_err(|fault| format!("{}: {}", fault.1, fault.2))?
    } else {
        read_memory(
            &tx,
            room,
            input,
            &Value::Null,
            "local-agent",
            default_sharing(),
        )
        .map_err(|fault| format!("{}: {}", fault.1, fault.2))?
    };
    let sharing = json!({"mode":"local","uploaded":false});
    if let Some(key) = private {
        if write {
            let id = value["id"]
                .as_str()
                .ok_or("Private memory write did not return an identity")?;
            tx.execute(
                "INSERT OR IGNORE INTO team_private VALUES(?1,?2)",
                params![key, format!("m:{id}")],
            )?;
        } else {
            for field in ["tasks", "notes", "results", "relatedConversations"] {
                let Some(items) = value[field].as_array_mut() else {
                    continue;
                };
                let mut local = Vec::new();
                for mut item in items.drain(..) {
                    let Some(id) = item["id"].as_str() else {
                        continue;
                    };
                    if tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM team_private WHERE remote=?1 AND id=?2)",
                        params![key, format!("m:{id}")],
                        |row| row.get::<_, bool>(0),
                    )? {
                        item["sharing"] = sharing.clone();
                        local.push(item);
                    }
                }
                *items = local;
            }
        }
    }
    value["room"] = json!(room);
    value["sharing"] = sharing;
    tx.commit()?;
    Ok(Some(value))
}

fn hybrid(
    state: &Relay,
    headers: &HeaderMap,
    room: &str,
    input: &Value,
    mut data: Value,
) -> HttpResult<Value> {
    use crate::{embeddings::Provider, vectors};
    let Some(query) = input["query"]
        .as_str()
        .map(str::trim)
        .filter(|q| !q.is_empty())
    else {
        return Ok(data);
    };
    if !matches!(input["command"].as_str(), Some("search" | "context"))
        || input["mode"] == "keyword"
        || input["includeArchived"] == true
    {
        return Ok(data);
    }
    let mut db = Connection::open_with_flags(&state.database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| internal())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| internal())?;
    let provider = match Provider::load(&db) {
        Ok(Some(provider)) => provider,
        Ok(None) => return Ok(data),
        Err(_) => {
            data["retrieval"]["semanticStatus"] = json!("unavailable");
            return Ok(data);
        }
    };
    let vector = match provider.query(&mut db, room, query) {
        Ok(Some(vector)) => vector,
        Ok(None) => {
            data["retrieval"]["semanticStatus"] = json!("budget_exceeded");
            return Ok(data);
        }
        Err(_) => {
            data["retrieval"]["semanticStatus"] = json!("unavailable");
            return Ok(data);
        }
    };
    let tx = db.transaction().map_err(|_| internal())?;
    let config = read_config(&state.config).map_err(|_| internal())?;
    authorize(&config, &tx, headers, room, false)?;
    let heads: String = tx
        .query_row(
            "SELECT heads FROM shard_refs WHERE room=?1 AND name=?2",
            params![room, format!("relay-{room}")],
            |row| row.get(0),
        )
        .map_err(|_| internal())?;
    if data["heads"] != serde_json::from_str::<Value>(&heads).map_err(|_| internal())? {
        drop(tx);
        return handle_room(state, headers, room, "memory", input, None);
    }
    let context = input["command"] == "context";
    let mut request = input.clone();
    request["limit"] = json!(30);
    request["offset"] = json!(0);
    if context {
        request["kinds"] = json!(["finding", "decision", "blocker", "handoff"]);
    }
    let mut bindings = vec![
        rusqlite::types::Value::Text(room.into()),
        rusqlite::types::Value::Text(provider.id.clone()),
    ];
    let mut condition = String::new();
    if let Some(task) = request["taskId"].as_str() {
        condition.push_str(" AND d.task_id=?");
        bindings.push(task.to_owned().into());
    }
    if let Some(kinds) = request["kinds"]
        .as_array()
        .filter(|kinds| !kinds.is_empty())
    {
        condition.push_str(&format!(
            " AND d.kind IN ({})",
            vec!["?"; kinds.len()].join(",")
        ));
        bindings.extend(
            kinds
                .iter()
                .filter_map(Value::as_str)
                .map(|kind| kind.to_owned().into()),
        );
    }
    let candidates = format!(
        "SELECT d.id,d.seq,v.chunk,v.vector FROM memory_vectors v
        JOIN memory_docs d ON d.room=v.room AND d.id=v.id
        WHERE v.room=? AND v.model=? AND v.fingerprint=d.fingerprint AND {}{condition}",
        vectors::VISIBLE
    );
    let mut statement = tx.prepare(&candidates).map_err(|_| internal())?;
    let mut rows = statement
        .query(rusqlite::params_from_iter(bindings))
        .map_err(|_| internal())?;
    let mut scores = std::collections::BTreeMap::<String, (f64, i64, usize)>::new();
    while let Some(row) = rows.next().map_err(|_| internal())? {
        let (id, seq, offset, bytes): (String, i64, i64, Vec<u8>) = (|| -> rusqlite::Result<_> {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })()
        .map_err(|_| internal())?;
        if let Some(score) =
            vectors::score(&bytes, &vector).filter(|score| *score >= provider.min_score)
        {
            let current = scores
                .entry(id)
                .or_insert((score, seq, offset.max(0) as usize));
            if score > current.0 {
                *current = (score, seq, offset.max(0) as usize);
            }
        }
    }
    let mut ranking: Vec<_> = scores.into_iter().collect();
    ranking.sort_by(|(_, a), (_, b)| b.0.total_cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let lookup = format!(
        "SELECT d.data,d.title,d.text,d.task_id,d.seq,s.data,o.data
        FROM memory_docs d LEFT JOIN memory_state s ON s.room=d.room AND s.id=d.id
        LEFT JOIN conversation_origins o ON o.room=d.room AND o.id=d.id
        WHERE d.room=?1 AND d.id=?2 AND {}",
        vectors::VISIBLE
    );
    let mut semantic = Vec::new();
    for (id, (score, _, offset)) in ranking.into_iter().take(100) {
        if let Some(card) = tx
            .query_row(&lookup, params![room, id], read_card)
            .optional()
            .map_err(|_| internal())?
        {
            let (text, truncated) = vectors::excerpt(&card.text, offset);
            let mut hit = memory_search::shape(card, "").map_err(|_| internal())?;
            decorate_memory(&tx, room, &config, &mut hit)?;
            hit["text"] = json!(text);
            hit["truncated"] = json!(truncated);
            hit["match"] = json!({"semantic":score,"offset":offset});
            semantic.push(hit);
        }
    }
    let plan = memory_search::plan(room, &request).map_err(|error| bad(error.0, error.1))?;
    let (lexical, _) = fetch_hits(&tx, room, &config, plan)?;
    let fused = vectors::fuse(lexical, semantic, query);
    let offset = if context {
        0
    } else {
        input["offset"].as_u64().unwrap_or(0) as usize
    };
    let limit = if context {
        8
    } else {
        input["limit"].as_u64().unwrap_or(10) as usize
    };
    data[if context { "notes" } else { "results" }] =
        json!(fused.iter().skip(offset).take(limit).collect::<Vec<_>>());
    if !context {
        data["nextOffset"] = json!(
            (fused.len() > offset.saturating_add(limit)).then_some(offset.saturating_add(limit))
        );
    }
    data["retrieval"] = json!({"mode":"hybrid","semanticStatus":"ready","model":provider.id,
        "contextChars":provider.context_chars,"index":"sqlite-exact-cosine"});
    Ok(data)
}

fn read_memory(
    tx: &rusqlite::Transaction<'_>,
    room: &str,
    input: &Value,
    config: &Value,
    principal: &str,
    sharing: Value,
) -> HttpResult<Value> {
    if input["command"] == "search" {
        let heads = memory_index::refresh(tx, room).map_err(sync_fault)?;
        let plan = memory_search::plan(room, input).map_err(|error| bad(error.0, error.1))?;
        let retrieval = memory_search::retrieval(input).map_err(|error| bad(error.0, error.1))?;
        let (values, next) = fetch_hits(tx, room, config, plan)?;
        let mut response = json!({"results":values,"heads":heads,"nextOffset":next,
            "sourcePrefix":format!("@machines/{principal}/"),"workspaceSharing":sharing});
        if let Some(retrieval) = retrieval {
            response["retrieval"] = retrieval;
        }
        return Ok(response);
    }
    if input["command"] == "context" {
        return context(tx, room, input, config, principal, sharing);
    }
    if input["command"] != "get" {
        return Err(bad("INVALID_MEMORY", "Unsupported memory command"));
    }
    let id = input["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 200)
        .ok_or_else(|| bad("INVALID_MEMORY", "Invalid memory identity"))?;
    let (offset, limit) = memory_page::page_parameters(input)
        .ok_or_else(|| bad("INVALID_LIMIT", "Invalid text page"))?;
    let heads = memory_index::refresh(tx, room).map_err(sync_fault)?;
    let card = tx
        .query_row(
            "SELECT d.data,d.title,d.text,d.task_id,d.seq,s.data,o.data
         FROM memory_docs d LEFT JOIN memory_state s ON s.room=d.room AND s.id=d.id
         LEFT JOIN conversation_origins o ON o.room=d.room AND o.id=d.id
         WHERE d.room=?1 AND d.id=?2",
            params![room, id],
            read_card,
        )
        .optional()
        .map_err(|_| internal())?
        .ok_or({
            Fault::new(
                StatusCode::NOT_FOUND,
                "MEMORY_NOT_FOUND",
                "Memory is not in this project",
            )
        })?;
    let mut value = memory_page::format_page(card, offset, limit).map_err(|_| internal())?;
    decorate_memory(tx, room, config, &mut value)?;
    value["heads"] = json!(heads);
    value["sourcePrefix"] = json!(format!("@machines/{principal}/"));
    value["workspaceSharing"] = sharing;
    Ok(value)
}

fn fetch_hits(
    tx: &rusqlite::Transaction<'_>,
    room: &str,
    config: &Value,
    plan: Option<memory_search::Search<'_>>,
) -> HttpResult<(Vec<Value>, Option<usize>)> {
    let mut values = Vec::new();
    let mut next = None;
    if let Some(plan) = plan {
        let bindings = plan.params.into_iter().map(|value| {
            if let Some(text) = value.as_str() {
                rusqlite::types::Value::Text(text.to_owned())
            } else {
                rusqlite::types::Value::Integer(value.as_i64().expect("numeric search parameter"))
            }
        });
        let mut query = tx.prepare_cached(&plan.sql).map_err(|_| internal())?;
        let mut rows = query
            .query(rusqlite::params_from_iter(bindings))
            .map_err(|_| internal())?;
        while let Some(row) = rows.next().map_err(|_| internal())? {
            if values.len() == plan.limit {
                next = Some(plan.offset + plan.limit);
                break;
            }
            let record = read_card(row).map_err(|_| internal())?;
            let mut value = memory_search::shape(record, plan.query).map_err(|_| internal())?;
            decorate_memory(tx, room, config, &mut value)?;
            values.push(value);
        }
    }
    Ok((values, next))
}

fn context(
    tx: &rusqlite::Transaction<'_>,
    room: &str,
    input: &Value,
    config: &Value,
    principal: &str,
    sharing: Value,
) -> HttpResult<Value> {
    let retrieval = memory_search::retrieval(input).map_err(|error| bad(error.0, error.1))?;
    let notes = memory_context::notes_input(input);
    let plan = memory_search::plan(room, &notes).map_err(|error| bad(error.0, error.1))?;
    let conversations = memory_context::conversations_input(input);
    let conversation_plan = if input["query"].as_str().is_some_and(|q| !q.is_empty()) {
        memory_search::plan(room, &conversations).map_err(|error| bad(error.0, error.1))?
    } else {
        None
    };
    let heads = memory_index::refresh(tx, room).map_err(sync_fault)?;
    let (notes, _) = fetch_hits(tx, room, config, plan)?;
    let (conversations, _) = fetch_hits(tx, room, config, conversation_plan)?;
    let mut statement = tx
        .prepare_cached(memory_context::TASKS_SQL)
        .map_err(|_| internal())?;
    let mut rows = statement.query([room]).map_err(|_| internal())?;
    let mut tasks = Vec::new();
    while let Some(row) = rows.next().map_err(|_| internal())? {
        let card = read_card(row).map_err(|_| internal())?;
        let mut value = memory_search::shape(card, "").map_err(|_| internal())?;
        decorate_memory(tx, room, config, &mut value)?;
        tasks.push(value);
    }
    let tasks = memory_context::task_cards(tasks, input);
    let mut statement = tx
        .prepare_cached(memory_context::CHANGES_SQL)
        .map_err(|_| internal())?;
    let mut rows = statement.query([room]).map_err(|_| internal())?;
    let mut changes: Vec<Value> = Vec::new();
    while let Some(row) = rows.next().map_err(|_| internal())? {
        let data: String = row.get(0).map_err(|_| internal())?;
        changes.push(serde_json::from_str(&data).map_err(|_| internal())?);
    }
    let mut value = json!({"heads":heads,"tasks":tasks,"notes":notes,
        "relatedConversations":conversations,"recentChanges":changes,
        "sourcePrefix":format!("@machines/{principal}/"),"workspaceSharing":sharing});
    if let Some(retrieval) = retrieval {
        value["retrieval"] = retrieval;
    }
    memory_context::enrich(&mut value, references_only(config));
    Ok(value)
}

fn read_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<memory_page::Card> {
    Ok(memory_page::Card {
        data: row.get(0)?,
        title: row.get(1)?,
        text: row.get(2)?,
        task_id: row.get(3)?,
        seq: row.get(4)?,
        lifecycle: row.get(5)?,
        origin: row.get(6)?,
    })
}

fn decorate_memory(
    tx: &rusqlite::Transaction<'_>,
    room: &str,
    config: &Value,
    value: &mut Value,
) -> HttpResult<()> {
    if references_only(config) {
        memory_page::reference_freshness(value);
    } else {
        let mut freshness = "not-code-verified";
        if let Some(files) = value["files"].as_array().filter(|files| !files.is_empty()) {
            freshness = "matches-captured-code";
            for file in files {
                let Some(id) = file["fileId"].as_str() else {
                    freshness = "code-changed";
                    break;
                };
                let current = manifest::lookup(tx, room, &format!("f:{id}")).map_err(sync_fault)?;
                let descriptor = &current["descriptor"];
                if current.is_null()
                    || descriptor["deleted"] == true
                    || descriptor["path"] != file["path"]
                    || descriptor["heads"] != file["heads"]
                {
                    freshness = "code-changed";
                    break;
                }
            }
        }
        value["freshness"] = json!(freshness);
    }
    if let Some(actor) = value["actor"].as_str() {
        let key = actor.split('/').next().unwrap_or(actor);
        let label: Option<String> = if !config.is_null() && managed(tx).map_err(|_| internal())? {
            tx.query_row(
                "SELECT label FROM team_members WHERE room=?1 AND id=?2",
                params![room, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| internal())?
        } else {
            config["credentials"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|credential| !credential["rooms"][room].is_null())
                .find(|credential| credential["id"] == key)
                .and_then(|credential| {
                    credential["label"]
                        .as_str()
                        .or_else(|| credential["id"].as_str())
                })
                .map(str::to_owned)
        };
        value["actorLabel"] = json!(label.as_deref().unwrap_or(actor));
    }
    Ok(())
}

fn managed(db: &rusqlite::Transaction<'_>) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspace_settings)",
        [],
        |row| row.get(0),
    )?)
}

fn workspace_credential<'a>(headers: &'a HeaderMap, scheme: &str) -> Option<&'a str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix(scheme)
        .filter(|token| workspace::valid_token(token))
}

fn update_in_progress() -> Fault {
    Fault::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "UPDATING",
        "Relay update in progress; retry shortly",
    )
}

fn authorize_workspace_owner(state: &Relay, headers: &HeaderMap) -> HttpResult<()> {
    let db = Connection::open_with_flags(&state.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| internal())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| internal())?;
    let tx = db.unchecked_transaction().map_err(|_| internal())?;
    let token = workspace_credential(headers, "Workspace ").ok_or_else(|| {
        Fault::new(
            StatusCode::UNAUTHORIZED,
            "WORKSPACE_AUTH",
            "Workspace authentication required",
        )
    })?;
    let member = workspace::authorize(&NativeMemory(&tx), token).map_err(write_fault)?;
    if !member.is_owner() {
        return Err(Fault::new(
            StatusCode::FORBIDDEN,
            "WORKSPACE_ROLE",
            "Workspace owner access is required",
        ));
    }
    tx.commit().map_err(|_| internal())?;
    Ok(())
}

fn retrieval_probe(state: &Relay, headers: &HeaderMap, input: &Value) -> HttpResult<Value> {
    authorize_workspace_owner(state, headers)?;
    let mut db = Connection::open_with_flags(&state.database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| internal())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| internal())?;
    crate::embeddings::Provider::probe(&mut db, input).map_err(|error| {
        Fault::new(
            StatusCode::BAD_REQUEST,
            "RETRIEVAL_PROBE",
            error.to_string(),
        )
    })?;
    Ok(json!({"ok":true,"message":"Cloudflare connection verified. No project memory was sent."}))
}

fn relay_admin(state: &Relay, headers: &HeaderMap, input: &Value) -> HttpResult<Value> {
    authorize_workspace_owner(state, headers)?;
    let mut request = input.clone();
    request
        .as_object_mut()
        .expect("validated JSON object")
        .remove("command");
    control_request(&state.control_socket, &request)
}

pub fn host_control(path: &std::path::Path, request: &Value) -> Result<Value> {
    control_request(path, request).map_err(|fault| fault.2.to_string().into())
}

#[cfg(unix)]
fn control_request(path: &std::path::Path, request: &Value) -> HttpResult<Value> {
    use std::{
        io::{BufRead, BufReader, ErrorKind, Read, Write},
        os::unix::net::UnixStream,
    };
    let failed = || {
        Fault::new(
            StatusCode::BAD_GATEWAY,
            "MAINTENANCE",
            "Relay maintenance service failed",
        )
    };
    let mut stream = match UnixStream::connect(path) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(control_unavailable());
        }
        Err(_) => return Err(failed()),
    };
    let timeout = Some(Duration::from_secs(8));
    stream.set_read_timeout(timeout).map_err(|_| failed())?;
    stream.set_write_timeout(timeout).map_err(|_| failed())?;
    serde_json::to_writer(&mut stream, request).map_err(|_| failed())?;
    stream.write_all(b"\n").map_err(|_| failed())?;
    let mut response = Vec::new();
    BufReader::new(stream)
        .take(200_001)
        .read_until(b'\n', &mut response)
        .map_err(|_| failed())?;
    if response.len() > 200_000 || response.last() != Some(&b'\n') {
        return Err(failed());
    }
    let value: Value = serde_json::from_slice(&response).map_err(|_| failed())?;
    if !value.is_object() {
        return Err(failed());
    }
    if let Some(message) = value["error"].as_str() {
        return Err(Fault::new(
            StatusCode::BAD_GATEWAY,
            "MAINTENANCE",
            message.to_owned(),
        ));
    }
    Ok(value)
}

#[cfg(not(unix))]
fn control_request(_: &std::path::Path, _: &Value) -> HttpResult<Value> {
    Ok(control_unavailable())
}

fn control_unavailable() -> Value {
    json!({"supported":false,"message":"Host maintenance is not installed or is unavailable on this relay."})
}

fn handle_workspace(
    state: &Relay,
    headers: &HeaderMap,
    path: &str,
    input: &Value,
) -> HttpResult<Value> {
    let mut db = Connection::open_with_flags(&state.database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| internal())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| internal())?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| internal())?;
    let backend = NativeMemory(&tx);
    let result = match path {
        "/v1/setup" => {
            let config = read_config(&state.config).map_err(|_| internal())?;
            let expected = config["bootstrapTokenHash"].as_str().unwrap_or_default();
            let token = headers
                .get(header::AUTHORIZATION)
                .and_then(|header| header.to_str().ok())
                .and_then(|header| header.strip_prefix("Bootstrap "))
                .unwrap_or_default();
            if token.is_empty() || !workspace::bootstrap_authorized(token, expected) {
                return Err(Fault::new(
                    StatusCode::UNAUTHORIZED,
                    "UNAUTHORIZED",
                    "Setup authentication required",
                ));
            }
            workspace::setup(&backend, input, &state.origin)
        }
        "/v1/workspace/action" => {
            let token = workspace_credential(headers, "Workspace ").ok_or_else(|| {
                Fault::new(
                    StatusCode::UNAUTHORIZED,
                    "WORKSPACE_AUTH",
                    "Workspace authentication required",
                )
            })?;
            let member = workspace::authorize(&backend, token).map_err(write_fault)?;
            if input["command"] == "retrieval" {
                if !member.is_owner() {
                    return Err(Fault::new(
                        StatusCode::FORBIDDEN,
                        "WORKSPACE_ROLE",
                        "Workspace owner access is required for relay retrieval settings",
                    ));
                }
                crate::retrieval_settings::run(&tx, input)
            } else if input["command"] == "delete-conversations" {
                let room =
                    workspace::deletion_room(&backend, &member, input).map_err(write_fault)?;
                let has_ref: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM shard_refs WHERE room=?1 AND name=?2)",
                        params![room, format!("relay-{room}")],
                        |row| row.get(0),
                    )
                    .map_err(|_| internal())?;
                if !has_ref {
                    shards::create_room(&tx, room, &format!("relay-{room}")).map_err(sync_fault)?;
                }
                crate::deletion::run(&backend, room, input)
            } else {
                workspace::action(&backend, &member, input, &state.origin)
            }
        }
        _ => {
            let code = workspace_credential(headers, "Invite ").ok_or_else(|| {
                Fault::new(
                    StatusCode::UNAUTHORIZED,
                    "INVITE_REQUIRED",
                    "Invite required",
                )
            })?;
            workspace::invite(
                &backend,
                code,
                path.starts_with("/v1/workspace/"),
                path.ends_with("/preview"),
                input,
                &state.origin,
            )
        }
    }
    .map_err(write_fault)?;
    let result = if let Some(certificate) = &state.certificate {
        crate::relay_tls::pins(result, certificate, &state.origin).map_err(|_| internal())?
    } else {
        result
    };
    tx.commit().map_err(|_| internal())?;
    Ok(result)
}

async fn request(State(state): State<Arc<Relay>>, request: Request) -> HttpResult<Response> {
    let (parts, body) = request.into_parts();
    let _permit = state
        .requests
        .try_acquire()
        .map_err(|_| Fault::new(StatusCode::SERVICE_UNAVAILABLE, "BUSY", "Retry later"))?;
    let updating = state.update_gate.try_exists().map_err(|_| internal())?;
    if parts
        .uri
        .path_and_query()
        .is_some_and(|path| path.as_str() == "/healthz")
        && parts.method == Method::GET
    {
        return Ok(send(
            StatusCode::OK,
            json!({"ok":true,"version":state.version,"updating":updating}),
        ));
    }
    if let Some(response) = review_asset(&parts.method, &parts.uri) {
        return Ok(response);
    }
    let path = parts.uri.path();
    let workspace_action = path == "/v1/workspace/action"
        && parts.method == Method::POST
        && parts.uri.query().is_none();
    if updating && !workspace_action {
        let mut response = update_in_progress().into_response();
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, header::HeaderValue::from_static("30"));
        return Ok(response);
    }
    if matches!(
        path,
        "/v1/setup"
            | "/v1/workspace/action"
            | "/v1/workspace/preview"
            | "/v1/workspace/enroll"
            | "/v1/invites/preview"
            | "/v1/invites/redeem"
    ) && parts.uri.query().is_none()
    {
        if parts.method != Method::POST {
            return Err(Fault::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD",
                "Use POST",
            ));
        }
        let (input, _) = request_json(&parts.headers, body, 20_000, false).await?;
        let path = path.to_owned();
        let workspace_state = Arc::clone(&state);
        let value = tokio::task::spawn_blocking(move || {
            if workspace_action && input["command"] == "relay-admin" {
                relay_admin(&workspace_state, &parts.headers, &input)
            } else if updating
                || workspace_state
                    .update_gate
                    .try_exists()
                    .map_err(|_| internal())?
            {
                Err(update_in_progress())
            } else if workspace_action
                && input["command"] == "retrieval"
                && input["action"] == "test"
            {
                retrieval_probe(&workspace_state, &parts.headers, &input)
            } else {
                handle_workspace(&workspace_state, &parts.headers, &path, &input)
            }
        })
        .await
        .map_err(|_| internal())??;
        return Ok(send(StatusCode::OK, value));
    }
    let not_found = || Fault::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Unknown endpoint");
    let (room, action) = parts
        .uri
        .path()
        .strip_prefix("/v1/rooms/")
        .and_then(|path| path.split_once('/'))
        .ok_or_else(not_found)?;
    if parts.uri.query().is_some()
        || !valid_room(room)
        || !matches!(
            action,
            "state" | "pull" | "push" | "memory" | "source" | "review"
        )
    {
        return Err(not_found());
    }
    let expected = if action == "state" {
        Method::GET
    } else {
        Method::POST
    };
    if parts.method != expected {
        return Err(Fault::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED",
            "Unsupported method",
        ));
    }
    let room_owned = room.to_owned();
    let write = matches!(action, "push" | "source");
    let state_for_auth = Arc::clone(&state);
    let headers = parts.headers.clone();
    tokio::task::spawn_blocking(move || {
        let config = read_config(&state_for_auth.config).map_err(|_| internal())?;
        let mut db =
            Connection::open_with_flags(&state_for_auth.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| internal())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|_| internal())?;
        let tx = db.transaction().map_err(|_| internal())?;
        authorize(&config, &tx, &headers, &room_owned, write)
    })
    .await
    .map_err(|_| internal())??;
    let (input, digest) = if action == "state" {
        (Value::Null, None)
    } else {
        request_json(&parts.headers, body, MAX_BODY, action == "source").await?
    };
    let state = Arc::clone(&state);
    let (room, action) = (room.to_owned(), action.to_owned());
    let value = tokio::task::spawn_blocking(move || {
        let value = handle_room(
            &state,
            &parts.headers,
            &room,
            &action,
            &input,
            digest.as_deref(),
        )?;
        if action == "memory" {
            hybrid(&state, &parts.headers, &room, &input, value)
        } else {
            Ok(value)
        }
    })
    .await
    .map_err(|_| internal())??;
    Ok(send(StatusCode::OK, value))
}

async fn request_json(
    headers: &HeaderMap,
    body: axum::body::Body,
    max: usize,
    source: bool,
) -> HttpResult<(Value, Option<String>)> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .unwrap_or_default();
    if !content_type
        .trim_end()
        .eq_ignore_ascii_case("application/json")
        || headers.contains_key(header::CONTENT_ENCODING)
    {
        return Err(Fault::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "CONTENT_TYPE",
            "Use uncompressed application/json",
        ));
    }
    let bytes = tokio::time::timeout(Duration::from_secs(30), to_bytes(body, max))
        .await
        .map_err(|_| {
            Fault::new(
                StatusCode::REQUEST_TIMEOUT,
                "TIMEOUT",
                "Request body timed out",
            )
        })?
        .map_err(|_| {
            Fault::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "BODY_TOO_LARGE",
                "Request exceeds byte limit",
            )
        })?;
    let input: Value =
        serde_json::from_slice(&bytes).map_err(|_| bad("INVALID_JSON", "Invalid UTF-8 JSON"))?;
    if !input.is_object() {
        return Err(bad("INVALID_REQUEST", "Expected request object"));
    }
    let digest = if source {
        crate::source::wire_digest(&bytes)
    } else {
        None
    };
    Ok((input, digest))
}

async fn run_indexer(state: std::sync::Weak<Relay>) {
    let mut tick = tokio::time::interval(Duration::from_secs(3));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut after = String::new();
    let mut delay = Duration::ZERO;
    loop {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        tick.tick().await;
        let Some(state) = state.upgrade() else {
            return;
        };
        if state.requests.available_permits() != 16
            || state.update_gate.try_exists().unwrap_or(true)
        {
            continue;
        }
        let previous = after.clone();
        let result = tokio::task::spawn_blocking(move || {
            index_turn(&state.database, &previous).map_err(|error| error.to_string())
        })
        .await;
        match result {
            Ok(Ok(Some(room))) => {
                after = room;
                delay = Duration::ZERO;
            }
            Ok(Ok(None)) => {
                after.clear();
                delay = Duration::from_secs(5);
            }
            _ => {
                delay = (delay * 2).clamp(Duration::from_secs(5), Duration::from_secs(60));
            }
        }
    }
}

fn index_turn(database: &std::path::Path, after: &str) -> Result<Option<String>> {
    let mut db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(5))?;
    let Some(provider) = crate::embeddings::Provider::load(&db)? else {
        return Ok(None);
    };
    let room: Option<String> = db.query_row(
        "SELECT p.room FROM team_projects p JOIN shard_refs r ON r.room=p.room AND r.name='relay-'||p.room
         ORDER BY CASE WHEN p.room>?1 THEN 0 ELSE 1 END,p.room LIMIT 1",
        [after],|row|row.get(0),
    ).optional()?;
    let Some(room) = room else {
        return Ok(None);
    };
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    memory_index::refresh(&tx, &room)?;
    tx.commit()?;
    provider.index_one(&mut db, &room)?;
    Ok(Some(room))
}

pub(crate) fn initialize_store(database: &Path, config: &Path) -> Result<Value> {
    let settings = read_config(config)?;
    let mut db = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    db.busy_timeout(Duration::from_secs(5))?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let legacy_schema: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refs')",
        [],
        |row| row.get(0),
    )?;
    if legacy_schema && tx.query_row("SELECT EXISTS(SELECT 1 FROM refs)", [], |row| row.get(0))? {
        return Err("Relay data uses the legacy layout; use a sharded database".into());
    }
    tx.execute_batch(include_str!("../shared/shard_schema.sql"))?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS relay_audit(
            seq INTEGER PRIMARY KEY,room TEXT NOT NULL,principal TEXT NOT NULL,
            heads TEXT NOT NULL,accepted_at TEXT NOT NULL,UNIQUE(room,principal,heads)
         );",
    )?;
    tx.execute_batch(memory_index::SCHEMA)?;
    migrate_workspace(&tx, &settings, config)?;
    if settings["projects"].is_array() || settings["bootstrapTokenHash"].is_string() {
        crate::retrieval_settings::schema(&tx).map_err(|error| error.2)?;
    }
    tx.commit()?;
    Ok(settings)
}

pub async fn serve(database: PathBuf, config: PathBuf, address: SocketAddr) -> Result<()> {
    let settings = initialize_store(&database, &config)?;
    let (certificate, tls) = if settings["privateTls"] == true {
        let (certificate, tls) =
            crate::relay_tls::configure(config.parent().ok_or("Invalid relay folder")?)?;
        (Some(certificate), Some(tls))
    } else {
        (None, None)
    };
    let listener = tokio::net::TcpListener::bind(address).await?;
    let bound = listener.local_addr()?;
    let origin = settings["publicOrigin"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("http://{bound}"));
    let version = serde_json::from_str::<Value>(RELEASE_VERSION)?["version"]
        .as_str()
        .ok_or("Missing release version")?
        .to_owned();
    let update_gate = database.with_file_name(".spool-update-gate");
    let state = Arc::new(Relay {
        version,
        update_gate,
        control_socket: settings["controlSocket"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/run/spool-control/agent.sock")),
        database,
        config,
        requests: Semaphore::new(16),
        origin,
        certificate,
    });
    let indexer = tokio::spawn(run_indexer(Arc::downgrade(&state)));
    let router = Router::new().fallback(request).with_state(state);
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    println!("{bound}");
    let shutdown = async move {
        #[cfg(unix)]
        tokio::select! {
            _ = term.recv() => {},
            _ = tokio::signal::ctrl_c() => {},
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    };
    if let Some(tls) = tls {
        axum::serve(crate::relay_tls::TlsListener::new(listener, tls), router)
            .with_graceful_shutdown(shutdown)
            .await?;
    } else {
        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await?;
    }
    indexer.abort();
    Ok(())
}

fn migrate_workspace(
    db: &rusqlite::Transaction<'_>,
    config: &Value,
    config_path: &std::path::Path,
) -> Result<()> {
    db.execute_batch(include_str!("../shared/workspace_schema.sql"))?;
    if config["projects"].is_array() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        for key in ["workspace-key", "invite-key"] {
            let path = config_path.with_file_name(key);
            if path.exists() {
                let bytes = std::fs::read(path)?;
                if bytes.len() != 32 {
                    return Err("Invalid existing workspace key".into());
                }
                let encoded = STANDARD.encode(bytes);
                let stored: Option<String> = db
                    .query_row(
                        "SELECT value FROM deployment_meta WHERE key=?1",
                        [key],
                        |row| row.get(0),
                    )
                    .optional()?;
                if stored.as_ref().is_some_and(|old| old != &encoded) {
                    return Err("Workspace keys disagree with existing host keys".into());
                }
                db.execute(
                    "INSERT OR IGNORE INTO deployment_meta VALUES(?1,?2)",
                    params![key, encoded],
                )?;
            }
        }
        for project in config["projects"].as_array().into_iter().flatten() {
            let (Some(room), Some(name)) = (project["room"].as_str(), project["name"].as_str())
            else {
                return Err("Invalid existing project".into());
            };
            db.execute(
                "INSERT OR IGNORE INTO team_projects VALUES(?1,?2,NULL,NULL)",
                params![room, name],
            )?;
        }
        let migrating: bool = db.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM team_host_meta WHERE key='members-migrated')",
            [],
            |row| row.get(0),
        )?;
        if migrating {
            for credential in config["credentials"].as_array().into_iter().flatten() {
                for (room, role) in credential["rooms"].as_object().into_iter().flatten() {
                    db.execute(
                        "INSERT OR IGNORE INTO team_members VALUES(?1,?2,?3,?4,?5,0)",
                        params![
                            credential["id"].as_str(),
                            room,
                            credential["label"]
                                .as_str()
                                .or_else(|| credential["id"].as_str()),
                            role.as_str(),
                            credential["tokenHash"].as_str()
                        ],
                    )?;
                }
            }
            db.execute("INSERT INTO team_host_meta VALUES('members-migrated')", [])?;
        }
        db.execute("INSERT OR IGNORE INTO workspace_repository_links SELECT repository_key,room FROM workspace_repositories",[])?;
    }
    Ok(())
}

pub(crate) fn review_asset(method: &Method, uri: &axum::http::Uri) -> Option<Response> {
    if method != Method::GET && method != Method::HEAD {
        return None;
    }
    let path = uri.path();
    if path == "/review" {
        let query = uri.query().map_or(String::new(), |q| format!("?{q}"));
        return Some(
            (
                StatusCode::PERMANENT_REDIRECT,
                [(header::LOCATION, format!("/review/{query}"))],
            )
                .into_response(),
        );
    }
    let (mime, asset) = match path {
        "/review/" => (
            "text/html; charset=utf-8",
            include_str!("../../src/review/public/index.html"),
        ),
        "/review/discovery.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../src/review/public/discovery.js"),
        ),
        "/review/workspace.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../src/review/public/workspace.js"),
        ),
        "/review/app.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../src/review/public/app.js"),
        ),
        "/review/settings.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../src/review/public/settings.js"),
        ),
        "/review/relay-settings.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../src/review/public/relay-settings.js"),
        ),
        "/review/retrieval-settings.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../src/review/public/retrieval-settings.js"),
        ),
        "/review/style.css" => (
            "text/css; charset=utf-8",
            include_str!("../../src/review/public/style.css"),
        ),
        "/review/kiln.css" => (
            "text/css; charset=utf-8",
            include_str!("../../src/review/public/kiln.css"),
        ),
        _ => return None,
    };
    let body = if method == Method::HEAD { "" } else { asset };
    Some(([
        (header::CONTENT_TYPE,mime),
        (header::CACHE_CONTROL,"no-store"),
        (header::CONTENT_SECURITY_POLICY,"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
        (header::X_CONTENT_TYPE_OPTIONS,"nosniff"),
        (header::REFERRER_POLICY,"no-referrer"),
     ],body).into_response())
}
