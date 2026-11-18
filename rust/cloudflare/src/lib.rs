#[path = "../../shared/bundle_export.rs"]
mod bundle_export;
#[path = "../../shared/deletion.rs"]
mod deletion;
mod downloads;
mod embeddings;
mod memory;
#[path = "../../shared/memory_context.rs"]
mod memory_context;
#[path = "../../shared/memory_mutation.rs"]
mod memory_mutation;
#[path = "../../shared/memory_page.rs"]
mod memory_page;
#[path = "../../shared/memory_record.rs"]
mod memory_record;
#[path = "../../shared/memory_search.rs"]
mod memory_search;
#[path = "../../shared/memory_write.rs"]
mod memory_write;
mod pull;
#[path = "../../shared/radix.rs"]
mod radix;
mod reindex;
mod remote_mcp;
#[path = "../../shared/review.rs"]
mod review;
#[path = "../../shared/review_diff.rs"]
mod review_diff;
#[path = "../../shared/shard_message.rs"]
mod shard_message;
#[path = "../../shared/source.rs"]
mod source;
mod storage;
#[path = "../../shared/vectors.rs"]
mod vectors;
#[path = "../../shared/workspace.rs"]
mod workspace;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use worker::{
    Context, Env, Error, Headers, Method, Request, RequestInit, Response, Result, SqlStorage,
    SqlStorageValue, State, durable_object, event,
};

fn reply(status: u16, mut value: Value) -> Result<Response> {
    value["protocol"] = json!("spool-relay/1");
    let headers = Headers::new();
    headers.set("content-type", "application/json; charset=utf-8")?;
    headers.set("cache-control", "no-store")?;
    headers.set("x-content-type-options", "nosniff")?;
    headers.set("referrer-policy", "no-referrer")?;
    Ok(Response::from_json(&value)?
        .with_status(status)
        .with_headers(headers))
}

fn fault(status: u16, code: &str, message: &str) -> Result<Response> {
    reply(status, json!({"error":{"code":code,"message":message}}))
}

fn public(result: Result<Response>) -> Result<Response> {
    result.or_else(|_| fault(500, "INTERNAL", "Relay request failed"))
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let result = async {
        if req.path().starts_with("/_spool/") {
            return fault(404, "NOT_FOUND", "Unknown endpoint");
        }
        if let Some(response) = downloads::run(&req, &env).await? {
            return Ok(response);
        }
        if req.path() == "/healthz" {
            return if req.method() == Method::Get {
                reply(
                    200,
                    json!({"ok":true,"backend":"cloudflare","sourceSharing":"git-references-only",
                        "releaseMarker":env.var("SPOOL_RELEASE_MARKER").ok().map(|value| value.to_string())}),
                )
            } else {
                fault(405, "METHOD", "Use GET")
            };
        }
        env.durable_object("WORKSPACE")?
            .id_from_name("workspace")?
            .get_stub()?
            .fetch_with_request(req)
            .await
    }
    .await;
    public(result)
}

struct Member {
    id: String,
    role: String,
}

fn query_one<T: serde::de::DeserializeOwned>(
    sql: &SqlStorage,
    query: &str,
    params: Vec<SqlStorageValue>,
) -> Result<Option<T>> {
    sql.exec(query, params)?.next::<T>().next().transpose()
}

fn auth_hash(req: &Request) -> Result<Option<String>> {
    let authorization = req.headers().get("authorization")?;
    Ok(authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| {
            (32..=128).contains(&token.len())
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        })
        .map(|token| format!("{:x}", Sha256::digest(token.as_bytes()))))
}

fn authorize(
    sql: &SqlStorage,
    room: &str,
    hash: &str,
) -> Result<std::result::Result<Member, Response>> {
    Ok(
        match workspace::project_member(&storage::CloudMemory(sql.clone()), room, hash) {
            Ok((id, role)) => Ok(Member { id, role }),
            Err(error) => Err(fault(error.0, error.1, &error.2)?),
        },
    )
}

fn label_record(sql: &SqlStorage, room: &str, record: &mut Value) -> Result<()> {
    if let Some(actor) = record["actor"].as_str() {
        let source = actor.split('/').next().unwrap_or(actor);
        #[derive(Deserialize)]
        struct Label {
            label: String,
        }
        let label: Option<Label> = query_one(
            sql,
            "SELECT label FROM team_members WHERE room=?1 AND id=?2",
            vec![room.into(), source.into()],
        )?;
        record["actorLabel"] = json!(label.map_or_else(|| actor.to_owned(), |value| value.label));
    }
    Ok(())
}

fn valid_room(room: &str) -> bool {
    room.len() <= 180
        && room.as_bytes().split_first().is_some_and(|(&first, tail)| {
            first.is_ascii_alphanumeric()
                && tail
                    .iter()
                    .all(|&b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}

fn internal_json(error: serde_json::Error) -> Error {
    Error::RustError(error.to_string())
}

#[durable_object]
pub struct SpoolWorkspace {
    state: State,
    env: Env,
}

async fn json_body(
    req: &mut Request,
    max: usize,
    source: bool,
) -> Result<std::result::Result<(Value, Option<String>), Response>> {
    let ctype = req.headers().get("content-type")?.unwrap_or_default();
    if !ctype
        .split(';')
        .next()
        .unwrap_or_default()
        .eq_ignore_ascii_case("application/json")
        || req.headers().has("content-encoding")?
    {
        return Ok(Err(fault(415, "CONTENT_TYPE", "Use uncompressed JSON")?));
    }
    let mut bytes = Vec::new();
    let mut stream = req.stream()?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > max {
            return Ok(Err(fault(
                413,
                "BODY_TOO_LARGE",
                "Request exceeds byte limit",
            )?));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(match serde_json::from_slice::<Value>(&bytes) {
        Ok(input) if input.is_object() => Ok((
            input,
            if source {
                crate::source::wire_digest(&bytes)
            } else {
                None
            },
        )),
        Ok(_) => Err(fault(400, "INVALID_REQUEST", "Expected object")?),
        Err(_) => Err(fault(400, "INVALID_JSON", "Invalid JSON")?),
    })
}

async fn transaction(
    state: &State,
    operation: impl FnOnce(storage::CloudMemory) -> storage::Result<Value> + 'static,
) -> Result<std::result::Result<Value, memory_write::Fault>> {
    use std::{cell::RefCell, rc::Rc};
    let store = state.storage();
    let sql = store.sql();
    let result = Rc::new(RefCell::new(None));
    let output = Rc::clone(&result);
    store
        .transaction(move |tx| async move {
            let outcome = operation(storage::CloudMemory(sql));
            if outcome.is_err() {
                tx.rollback()?;
            }
            output.replace(Some(outcome));
            Ok(())
        })
        .await?;
    result
        .take()
        .ok_or_else(|| Error::RustError("Missing transaction result".to_owned()))
}

impl SpoolWorkspace {
    async fn enrollment(&self, mut req: Request, path: &str) -> Result<Response> {
        if req.method() != Method::Post {
            return fault(405, "METHOD", "Use POST");
        }
        let header = req.headers().get("authorization")?.unwrap_or_default();
        let setup = path == "/v1/setup";
        let code = if setup {
            let token = header.strip_prefix("Bootstrap ").unwrap_or_default();
            let expected = self
                .env
                .secret("BOOTSTRAP_TOKEN_HASH")
                .map(|secret| secret.to_string())
                .or_else(|_| {
                    self.env
                        .var("BOOTSTRAP_TOKEN_HASH")
                        .map(|value| value.to_string())
                })
                .unwrap_or_default();
            if token.is_empty() || !workspace::bootstrap_authorized(token, &expected) {
                return fault(401, "UNAUTHORIZED", "Setup authentication required");
            }
            String::new()
        } else {
            let Some(code) = header
                .strip_prefix("Invite ")
                .filter(|code| workspace::valid_token(code))
            else {
                return fault(401, "INVITE_REQUIRED", "Invite required");
            };
            code.to_owned()
        };
        let body = match json_body(&mut req, 20_000, false).await? {
            Ok((body, _)) => body,
            Err(response) => return Ok(response),
        };
        let origin = self
            .env
            .var("PUBLIC_ORIGIN")
            .map(|v| v.to_string())
            .unwrap_or(req.url()?.origin().ascii_serialization());
        let workspace_invite = path.starts_with("/v1/workspace/");
        let preview = path.ends_with("/preview");
        let outcome = transaction(&self.state, move |db| {
            if setup {
                workspace::setup(&db, &body, &origin)
            } else {
                workspace::invite(&db, &code, workspace_invite, preview, &body, &origin)
            }
        })
        .await?;
        match outcome {
            Ok(value) => reply(200, value),
            Err(error) => fault(error.0, error.1, &error.2),
        }
    }

    async fn workspace_action(&self, mut req: Request) -> Result<Response> {
        if req.method() != Method::Post {
            return fault(405, "METHOD", "Use POST");
        }
        let authorization = req.headers().get("authorization")?.unwrap_or_default();
        let Some(token) = authorization.strip_prefix("Workspace ").filter(|token| {
            token.len() == 43
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        }) else {
            return fault(401, "WORKSPACE_AUTH", "Workspace authentication required");
        };
        let db = storage::CloudMemory(self.state.storage().sql());
        if let Err(error) = workspace::authorize(&db, token) {
            return fault(error.0, error.1, &error.2);
        }
        let input = match json_body(&mut req, 20_000, false).await? {
            Ok((body, _)) => body,
            Err(response) => return Ok(response),
        };
        if input["command"] == "delete-conversations" {
            let member = match workspace::authorize(&db, token) {
                Ok(member) => member,
                Err(error) => return fault(error.0, error.1, &error.2),
            };
            let room = match workspace::deletion_room(&db, &member, &input) {
                Ok(room) => room,
                Err(error) => return fault(error.0, error.1, &error.2),
            };
            let headers = Headers::new();
            headers.set("content-type", "application/json")?;
            let body =
                json!({"room":room,"principal":{"id":member.id},"policy":null,"input":input});
            let request = Request::new_with_init(
                "https://project.internal/conversation-delete",
                RequestInit::new()
                    .with_method(Method::Post)
                    .with_headers(headers)
                    .with_body(Some(body.to_string().into())),
            )?;
            let response = self
                .env
                .durable_object("PROJECTS")?
                .id_from_name(room)?
                .get_stub()?
                .fetch_with_request(request)
                .await?;
            return Ok(response);
        }
        let token = token.to_owned();
        let origin = self
            .env
            .var("PUBLIC_ORIGIN")
            .map(|v| v.to_string())
            .unwrap_or(req.url()?.origin().ascii_serialization());
        let outcome = transaction(&self.state, move |db| {
            let member = workspace::authorize(&db, &token)?;
            workspace::action(&db, &member, &input, &origin)
        })
        .await?;
        match outcome {
            Ok(value) => reply(200, value),
            Err(error) => fault(error.0, error.1, &error.2),
        }
    }

    async fn route(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        if path == "/_spool/oauth-mcp" {
            return remote_mcp::run(self, req).await;
        }
        if path == "/v1/workspace/action" {
            return self.workspace_action(req).await;
        }
        if matches!(
            path.as_str(),
            "/v1/setup"
                | "/v1/workspace/preview"
                | "/v1/workspace/enroll"
                | "/v1/invites/preview"
                | "/v1/invites/redeem"
        ) {
            return self.enrollment(req, &path).await;
        }
        let Some((room, action)) = path
            .strip_prefix("/v1/rooms/")
            .and_then(|path| path.split_once('/'))
        else {
            return fault(404, "NOT_FOUND", "Unknown endpoint");
        };
        if !valid_room(room)
            || !matches!(
                action,
                "state" | "push" | "memory" | "pull" | "source" | "review"
            )
        {
            return fault(404, "NOT_FOUND", "Unknown endpoint");
        }
        let method = if action == "state" {
            Method::Get
        } else {
            Method::Post
        };
        if req.method() != method {
            return fault(405, "METHOD", "Unsupported method");
        }
        let Some(hash) = auth_hash(&req)? else {
            return fault(401, "UNAUTHORIZED", "Project authentication required");
        };
        let sql = self.state.storage().sql();
        let member = match authorize(&sql, room, &hash)? {
            Ok(member) => member,
            Err(response) => return Ok(response),
        };
        if action == "push" {
            return if member.role == "write" {
                fault(403, "GIT_ONLY", "Repository sync bundles are not accepted")
            } else {
                fault(403, "FORBIDDEN", "Write access required")
            };
        }

        let (command, digest) = if action != "state" {
            match json_body(&mut req, 16_000_000, action == "source").await? {
                Ok(input) => input,
                Err(response) => return Ok(response),
            }
        } else {
            (Value::Null, None)
        };
        let member = if action != "state" {
            match authorize(&sql, room, &hash)? {
                Ok(member) => member,
                Err(response) => return Ok(response),
            }
        } else {
            member
        };
        if action == "source" && member.role != "write" {
            return fault(403, "FORBIDDEN", "Write access required");
        }
        let sharing = workspace::policy(&storage::CloudMemory(sql.clone()), room)
            .map_err(|e| Error::RustError(e.2))?;
        let command = if action == "memory" && memory_mutation::command(&command) {
            if member.role != "write" {
                return fault(403, "FORBIDDEN", "Write access required");
            }
            match memory_write::apply_sharing(&command, &sharing["sharing"]) {
                Ok(command) => command,
                Err(error) => return fault(error.0, error.1, &error.2),
            }
        } else {
            command
        };
        let input = json!({
            "room":room, "principal":{"id":member.id}, "policy":sharing,
            "input":command, "source_digest":digest,
        });
        let headers = Headers::new();
        headers.set("content-type", "application/json")?;
        let internal = Request::new_with_init(
            &format!("https://project.internal/{action}"),
            RequestInit::new()
                .with_method(Method::Post)
                .with_headers(headers)
                .with_body(Some(input.to_string().into())),
        )?;
        let mut response = self
            .env
            .durable_object("PROJECTS")?
            .id_from_name(room)?
            .get_stub()?
            .fetch_with_request(internal)
            .await?;
        if let Err(fault) = authorize(&sql, room, &hash)? {
            return Ok(fault);
        }
        if action != "memory" || response.status_code() != 200 {
            return Ok(response);
        }
        let mut result: Value = response.json().await?;
        result["workspaceSharing"] = input["policy"]["sharing"].clone();
        label_record(&sql, room, &mut result)?;
        for field in ["tasks", "notes", "relatedConversations", "results"] {
            if let Some(items) = result.get_mut(field).and_then(Value::as_array_mut) {
                for item in items {
                    label_record(&sql, room, item)?;
                }
            }
        }
        reply(200, result)
    }
}

impl worker::DurableObject for SpoolWorkspace {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        public(self.route(req).await)
    }
}

#[derive(Deserialize)]
struct StateRequest {
    room: String,
    principal: Principal,
    policy: Value,
    input: Value,
    source_digest: Option<String>,
}

#[derive(Deserialize)]
struct Principal {
    id: String,
}

#[derive(Deserialize)]
struct ProjectRef {
    room: String,
    heads: String,
}

#[durable_object]
pub struct SpoolProject {
    state: State,
    env: Env,
    cache: embeddings::QueryCache,
    indexing: std::rc::Rc<std::cell::Cell<bool>>,
}

impl SpoolProject {
    async fn mutate(&self, input: StateRequest) -> Result<Response> {
        let room = input.room;
        let principal = input.principal.id;
        let command = input.input;
        let response_room = room.clone();
        let response_principal = principal.clone();
        let outcome = transaction(&self.state, move |db| {
            memory_mutation::write(&db, &room, &command, &principal, true)
        })
        .await?;
        match outcome {
            Ok(mut data) => {
                data["room"] = json!(response_room);
                data["sourcePrefix"] = json!(format!("@machines/{response_principal}/"));
                reply(200, data)
            }
            Err(error) => fault(error.0, error.1, &error.2),
        }
    }

    async fn route(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        if !matches!(
            path.as_str(),
            "/state" | "/memory" | "/pull" | "/source" | "/conversation-delete" | "/review"
        ) || req.method() != Method::Post
        {
            return fault(404, "NOT_FOUND", "Unknown action");
        }
        let input: StateRequest = req.json().await?;
        let sql = self.state.storage().sql();
        let memory = storage::CloudMemory(self.state.storage().sql());
        match memory.initialized() {
            Ok(true) => {}
            Ok(false) => {
                let room = input.room.clone();
                let store = self.state.storage();
                let backend = storage::CloudMemory(store.sql());
                store
                    .transaction(move |_| async move {
                        backend
                            .initialize(&room)
                            .map_err(|error| Error::RustError(error.2))
                    })
                    .await?;
            }
            Err(error) => return fault(error.0, error.1, &error.2),
        }
        let row = query_one::<ProjectRef>(
            &sql,
            "SELECT room,heads FROM shard_refs WHERE name=?1",
            vec![format!("relay-{}", input.room).into()],
        )?;
        let Some(row) = row else {
            return fault(409, "ROOM_EMPTY", "Project history is unavailable");
        };
        if row.room != input.room {
            return fault(403, "ROOM_MISMATCH", "Project mismatch");
        }
        if path == "/conversation-delete" {
            let principal = input.principal.id.clone();
            let outcome = transaction(&self.state, move |db| {
                crate::deletion::run(&db, &input.room, &input.input)
            })
            .await?;
            return match outcome {
                Ok(mut value) => {
                    value["sourcePrefix"] = json!(format!("@machines/{principal}/"));
                    reply(200, value)
                }
                Err(error) => fault(error.0, error.1, &error.2),
            };
        }
        if path == "/source" {
            let outcome = transaction(&self.state, move |db| {
                crate::source::ingest(
                    &db,
                    &input.room,
                    &input.principal.id,
                    &input.input,
                    &input.policy["sharing"],
                    input.source_digest.as_deref(),
                )
            })
            .await?;
            return match outcome {
                Ok(result) => reply(200, result),
                Err(error) => fault(error.0, error.1, &error.2),
            };
        }
        if path == "/review" {
            let room = input.room.clone();
            let principal = input.principal.id.clone();
            let outcome = transaction(&self.state, move |db| {
                crate::review::run(
                    &db,
                    &db,
                    &input.room,
                    &input.principal.id,
                    &input.input,
                    true,
                )
            })
            .await?;
            return match outcome {
                Ok(mut value) => {
                    value["room"] = json!(room);
                    value["sourcePrefix"] = json!(format!("@machines/{principal}/"));
                    reply(200, value)
                }
                Err(error) => fault(error.0, error.1, &error.2),
            };
        }
        if path == "/pull" {
            return pull::run(&memory, &input);
        }
        if path == "/memory" {
            if memory_mutation::command(&input.input) {
                return self.mutate(input).await;
            }
            if !memory
                .current_index(&input.room, &row.heads)
                .map_err(|error| Error::RustError(error.2))?
            {
                let store = self.state.storage();
                let backend = storage::CloudMemory(store.sql());
                let room = input.room.clone();
                store
                    .transaction(move |_| async move {
                        backend
                            .refresh(&room)
                            .map(|_| ())
                            .map_err(|error| Error::RustError(error.2))
                    })
                    .await?;
                let frontier = memory
                    .frontier(&input.room)
                    .map_err(|error| Error::RustError(error.2))?;
                let base = memory::read(&sql, &input, &frontier.heads)?;
                return embeddings::augment(self, &sql, &input, &frontier.heads, base).await;
            }
            let base = memory::read(&sql, &input, &row.heads)?;
            return embeddings::augment(self, &sql, &input, &row.heads, base).await;
        }
        let mut value = input.policy;
        value["room"] = json!(input.room);
        value["heads"] = serde_json::from_str(&row.heads).map_err(internal_json)?;
        value["sourcePrefix"] = json!(format!("@machines/{}/", input.principal.id));
        value["memoryLifecycle"] = json!(1);
        value["maxPageBytes"] = json!(1_500_000);
        reply(200, value)
    }
}

impl worker::DurableObject for SpoolProject {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            cache: embeddings::QueryCache::default(),
            indexing: Default::default(),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        public(self.route(req).await)
    }
}
