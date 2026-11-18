use crate::{
    Result, bundles,
    native_memory::NativeMemory,
    project_binding::{self, Binding},
    project_init,
    relay::review_asset,
    workspace_client,
};
use axum::{
    Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct LocalWeb {
    address: SocketAddr,
    secret: [u8; 32],
}

const SESSION_TTL: u64 = 43_200;
const MAX_BODY: usize = 1_000_000;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs())
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            part.trim()
                .split_once('=')
                .filter(|(key, _)| *key == name)
                .map(|(_, value)| value.to_owned())
        })
}

fn response(status: StatusCode, value: Value) -> Response {
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

fn failure(status: StatusCode, message: impl Into<String>) -> Response {
    response(status, json!({"error":message.into()}))
}

fn sign(secret: &[u8], token: &str) -> Hmac<Sha256> {
    let mut hmac =
        Hmac::<Sha256>::new_from_slice(secret).expect("any HMAC key length is supported");
    hmac.update(token.as_bytes());
    hmac
}

fn authenticated(state: &LocalWeb, headers: &HeaderMap, setup: bool) -> bool {
    let name = if setup { "spool_setup" } else { "spool_local" };
    let Some(token) = cookie(headers, name) else {
        return false;
    };
    let Some((timestamp, nonce)) = token.split_once('.') else {
        return false;
    };
    if nonce.len() != 43
        || !timestamp
            .parse::<u64>()
            .ok()
            .is_some_and(|value| value <= now() && value.saturating_add(SESSION_TTL) > now())
    {
        return false;
    }
    let Some(code) = headers
        .get("x-spool-csrf")
        .and_then(|value| URL_SAFE_NO_PAD.decode(value.as_bytes()).ok())
    else {
        return false;
    };
    sign(&state.secret, &token).verify_slice(&code).is_ok()
}

pub(crate) fn projects() -> Result<Vec<Binding>> {
    Ok(project_binding::registered_roots()?
        .into_iter()
        .filter_map(|root| project_binding::resolve(&root).ok())
        .collect())
}

pub(crate) fn public_project(binding: &Binding) -> Value {
    json!({"id":binding.local_id,"root":binding.root,"name":binding.root.file_name()})
}

pub(crate) fn project_state(binding: &Binding) -> Result<Value> {
    let team = if let Some(grant) = &binding.grant {
        json!({"configured":true,"connected":true,"room":grant.room,"url":grant.url,
            "mode":"shared","sourceSharing":"git-references-only"})
    } else {
        json!({"configured":false,"connected":false,"mode":"local"})
    };
    let enabled = project_binding::capture_enabled(binding)?;
    let mut project = public_project(binding);
    project["room"] = json!(binding.local_id);
    project["team"] = team;
    project["codex"] =
        json!({"enabled":enabled,"status":if enabled {"connected"} else {"disconnected"}});
    Ok(project)
}

pub(crate) fn capture_project(binding: &Binding) -> Result<Value> {
    let outcome =
        crate::companion::Companion::default().project(&binding.root, Path::new("codex"))?;
    let mut state = project_state(binding)?;
    state["captureRun"] = outcome;
    Ok(state)
}

pub(crate) fn connect_agents() -> Result<Value> {
    crate::init_cli::install_codex()?;
    Ok(json!({"configured":true,
        "message":"SpoolDB MCP is configured. Reopen Codex sessions to load the connection."}))
}

fn memory_setup() -> Result<Value> {
    let command = std::env::current_exe()?;
    let state = project_binding::state_root()?;
    Ok(
        json!({"mcpServers":{"spool":{"command":command,"args":["project-mcp"],"env":{"SPOOL_STATE":state}}}}),
    )
}

fn agents() -> Result<Value> {
    let config = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::home_dir().map(|home| home.join(".codex")))
        .ok_or("Could not find the Codex configuration directory")?;
    let configured = crate::relay_retention::metadata(&config.join("config.toml"))?
        .filter(|entry| entry.is_file() && entry.len() < 2_000_000)
        .and_then(|_| std::fs::read_to_string(config.join("config.toml")).ok())
        .is_some_and(|contents| {
            contents.lines().any(|line| {
                let line = line.trim();
                matches!(line, "[mcp_servers.spool]" | "[mcp_servers.spooldb]")
                    || line.starts_with("[plugins.spooldb@")
            })
        });
    Ok(json!({"configured":configured}))
}

fn update_memory(binding: &Binding, input: &Value) -> Result<Value> {
    let action = input["action"]
        .as_str()
        .filter(|action| matches!(*action, "archive" | "restore" | "resolve" | "supersede"))
        .ok_or("Choose a memory lifecycle action")?;
    let id = input["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or("Choose a memory record")?;
    let reason = input["reason"]
        .as_str()
        .map(str::trim)
        .filter(|reason| !reason.is_empty() && reason.chars().count() <= 1000)
        .ok_or("Enter a short reason")?;
    let revision = input["expectedRevision"]
        .as_u64()
        .ok_or("A memory revision is required")?;
    let request = input["requestId"]
        .as_str()
        .filter(|request| !request.is_empty() && request.len() <= 200)
        .ok_or("A retry key is required")?;
    let mut lifecycle = json!({"id":id,"action":action,"expectedRevision":revision});
    for key in ["replacementId", "resolveIds"] {
        if let Some(value) = input.get(key) {
            lifecycle[key] = value.clone();
        }
    }
    binding.memory(
        &json!({"command":"remember","kind":"decision","title":format!("Memory {action}"),
        "text":reason,"requestId":request,"lifecycle":lifecycle}),
    )
}

fn session(state: &LocalWeb, headers: &HeaderMap, setup: bool) -> Result<Response> {
    let mut value = json!({});
    if !setup {
        let projects = projects()?;
        let preferred = cookie(headers, "spool_project").or_else(|| {
            let state = project_binding::state_root().ok()?;
            let choice = crate::project_paths::optional_json::<Value>(&state.join("cli.json"))
                .ok()
                .flatten()?;
            choice["project"].as_str().map(ToOwned::to_owned)
        });
        let project = projects
            .iter()
            .find(|item| Some(&item.local_id) == preferred.as_ref())
            .or_else(|| projects.first())
            .ok_or("Add a project first")?;
        value["project"] = project_state(project)?;
    }
    let mut nonce = [0; 32];
    getrandom::fill(&mut nonce)?;
    let token = format!("{}.{}", now(), URL_SAFE_NO_PAD.encode(nonce));
    value["csrf"] =
        json!(URL_SAFE_NO_PAD.encode(sign(&state.secret, &token).finalize().into_bytes()));
    let (name, path) = if setup {
        ("spool_setup", "/api")
    } else {
        ("spool_local", "/local")
    };
    let mut result = response(StatusCode::OK, value);
    result.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{name}={token}; HttpOnly; SameSite=Strict; Path={path}; Max-Age={SESSION_TTL}"
        ))?,
    );
    Ok(result)
}

fn setup_asset(path: &str, is_setup: bool) -> Option<Response> {
    let (mime, body) = match path {
        "/" if is_setup => (
            "text/html; charset=utf-8",
            include_str!("../../src/desktop/public/setup.html"),
        ),
        "/setup.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../src/desktop/public/setup.js"),
        ),
        "/style.css" => (
            "text/css; charset=utf-8",
            include_str!("../../src/desktop/public/style.css"),
        ),
        "/kiln.css" => (
            "text/css; charset=utf-8",
            include_str!("../../src/review/public/kiln.css"),
        ),
        "/workspace.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../src/review/public/workspace.js"),
        ),
        "/discovery.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../src/review/public/discovery.js"),
        ),
        _ => return None,
    };
    Some(([(header::CONTENT_TYPE,mime),(header::CACHE_CONTROL,"no-store"),
        (header::X_CONTENT_TYPE_OPTIONS,"nosniff"),
        (header::CONTENT_SECURITY_POLICY,"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")],body).into_response())
}

fn invite_inbox() -> Result<Vec<Value>> {
    crate::desktop_launch::inbox(&project_binding::state_root()?.join("inbox.json"))
}

fn dismiss_invite(link: Option<&str>) -> Result<()> {
    if let Some(link) = link {
        crate::desktop_launch::dismiss(&project_binding::state_root()?.join("inbox.json"), link)?;
    }
    Ok(())
}

fn mark_ready(origin: &str) -> Result<()> {
    let path = project_binding::state_root()?.join("service.json");
    if let Ok(bytes) = std::fs::read(&path) {
        let mut value: Value = serde_json::from_slice(&bytes)?;
        if value["backend"] == "rust"
            && value["pid"] == std::process::id()
            && value["origin"] == origin
            && value["mode"] != "ready"
        {
            value["mode"] = json!("ready");
            workspace_client::save_atomic(&path, &value)?;
        }
    }
    Ok(())
}

fn review(binding: &Binding, input: &Value) -> Result<Value> {
    if input["command"] == "publish" {
        return Err("Local review is read-only".into());
    }
    let mut db = Connection::open_with_flags(
        binding.directory.join("relay.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    db.busy_timeout(Duration::from_secs(5))?;
    let tx = db.transaction()?;
    let mut data = crate::review::run(
        &NativeMemory(&tx),
        &bundles::NativeExport(&tx),
        &binding.local_id,
        "local-review",
        input,
        false,
    )
    .map_err(|error| error.2)?;
    data["room"] = json!(binding.local_id);
    data["protocol"] = json!("spool-relay/1");
    Ok(data)
}

fn workspace(binding: Option<&Binding>, input: &Value) -> Result<Value> {
    match input["command"].as_str() {
        Some("join-local") => {
            let root = Path::new(
                input["root"]
                    .as_str()
                    .ok_or("Choose your local Git project folder")?,
            );
            let room = input["room"].as_str().ok_or("Choose a shared project")?;
            let selector = input["workspace"]
                .as_str()
                .or_else(|| {
                    binding.and_then(|item| item.grant.as_ref().map(|grant| grant.url.as_str()))
                })
                .ok_or("Choose a saved workspace connection")?;
            project_init::initialize(root)?;
            let result = workspace_client::enroll_project(selector, root, "join", room, None)?;
            let project = project_binding::resolve(root)?;
            if input["captureConversations"] != false && result["existing"] != true {
                workspace_client::save_atomic(
                    &project.directory.join("integrations.json"),
                    &json!({"codex":true}),
                )?;
            }
            let mut joined = json!({"joined":true,"project":public_project(&project),"existingConnection":result["existing"]});
            if input["connectAgents"] == true
                && let Err(error) = crate::init_cli::install_codex()
            {
                joined["agentError"] = json!(error.to_string());
            }
            Ok(joined)
        }
        Some("profiles") => workspace_client::list_profiles(),
        Some("preview" | "connect") => {
            let link = input["link"]
                .as_str()
                .ok_or("Paste a workspace invitation")?;
            let device = (input["command"] == "connect")
                .then(|| input["device"].as_str().unwrap_or("SpoolDB client"));
            workspace_client::invite(link, device)
        }
        _ => {
            if let Some(selector) = input["workspace"].as_str() {
                return workspace_client::action(selector, input);
            }
            if let Some(grant) = binding.and_then(|binding| binding.grant.as_ref()) {
                if matches!(
                    input["command"].as_str(),
                    Some("project-sharing" | "delete-conversations" | "invite-project")
                ) && input["room"] != grant.room
                {
                    return Err(
                        "This action must target the selected repository’s shared project".into(),
                    );
                }
                let mut listed = workspace_client::action(&grant.url, input)?;
                if input["command"] == "list" {
                    listed["connected"] = json!(true);
                    listed["repositoryBinding"] = json!({"relay":grant.url,"room":grant.room});
                }
                Ok(listed)
            } else {
                Ok(json!({"connected":false,"selectionRequired":true}))
            }
        }
    }
}

fn pick_folder() -> Result<Value> {
    let mut picked = Value::Null;
    for (program, args) in [
        ("kdialog", vec!["--getexistingdirectory", "."]),
        ("zenity", vec!["--file-selection", "--directory"]),
    ] {
        match std::process::Command::new(program).args(args).output() {
            Ok(result) if result.status.success() => {
                picked = json!({"root":String::from_utf8(result.stdout)?.trim()});
                break;
            }
            Ok(result) if result.status.code() == Some(1) => {
                picked = json!({"root":null});
                break;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    if picked.is_null() {
        Ok(json!({"root":null,"message":"Enter the project folder path."}))
    } else {
        Ok(picked)
    }
}

fn local_host(input: &Value) -> Result<Value> {
    if !matches!(
        input["command"].as_str(),
        Some("list" | "create" | "create-invite")
    ) {
        return Err("Choose a local project administration action".into());
    }
    let directory = if let Some(path) = std::env::var_os("SPOOL_TEAM_HOST") {
        std::path::PathBuf::from(path)
    } else if let Some(path) = crate::server_install::configured_state()? {
        path
    } else {
        project_binding::state_root()?.join("shared-relay")
    };
    crate::team_host::compatible_request(&directory, input)
}

fn join_project(input: &Value, origin: &str) -> Result<Value> {
    let cwd = Path::new(
        input["root"]
            .as_str()
            .ok_or("Choose a Git project folder")?,
    );
    let link = input["link"]
        .as_str()
        .filter(|value| !value.trim().is_empty());
    let mut value = if let Some(link) = link {
        workspace_client::project_invitation(
            link,
            Some(cwd),
            input["device"].as_str().unwrap_or("SpoolDB client"),
            input["captureConversations"] != false,
        )?
    } else {
        let initialized = project_init::initialize(cwd)?;
        let binding = project_binding::resolve(cwd)?;
        json!({"joined":false,"project":public_project(&binding),"existing":initialized["existing"]})
    };
    if value["joined"] == true
        && input["connectAgents"] == true
        && let Err(error) = crate::init_cli::install_codex()
    {
        value["agentError"] = json!(error.to_string());
    }
    dismiss_invite(link)?;
    mark_ready(origin)?;
    value["origin"] = json!(origin);
    Ok(value)
}

fn setup_api(path: &str, input: &Value, origin: &str) -> Result<Response> {
    let value = match path {
        "/api/status" => {
            json!({"pending":invite_inbox()?.first().and_then(|entry|entry["link"].as_str()),"device":"SpoolDB client"})
        }
        "/api/workspace" => {
            let mut value = workspace(None, input)?;
            if value["joined"] == true {
                mark_ready(origin)?;
                value["origin"] = json!(origin);
            }
            value
        }
        "/api/discovery" => {
            let mut value = crate::discovery::run(input)?;
            if value["status"] == "enrolled" {
                mark_ready(origin)?;
                value["origin"] = json!(origin);
            }
            value
        }
        "/api/browse" => pick_folder()?,
        "/api/preview" => workspace_client::project_invitation(
            input["link"].as_str().ok_or("Paste a project invitation")?,
            None,
            "",
            false,
        )?,
        "/api/join" => join_project(input, origin)?,
        _ => return Ok(failure(StatusCode::NOT_FOUND, "Unknown setup action")),
    };
    Ok(response(StatusCode::OK, value))
}

fn dispatch(headers: &HeaderMap, path: &str, method: &Method, input: &Value) -> Result<Response> {
    let projects = projects()?;
    let preferred = headers
        .get("x-spool-project")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| cookie(headers, "spool_project"));
    let selected = match preferred {
        Some(id) => projects.iter().find(|item| item.local_id == id),
        None => projects.first(),
    };
    let value = match (method, path) {
        (&Method::GET, "/local/projects") => {
            json!({"projects":projects.iter().map(public_project).collect::<Vec<_>>()})
        }
        (&Method::GET, "/local/invites/pending") => json!({"pending":invite_inbox()?.first()}),
        (&Method::POST, "/local/invites/dismiss") => {
            dismiss_invite(input["link"].as_str())?;
            json!({"dismissed":true})
        }
        (&Method::POST, "/local/invites/preview") => workspace_client::project_invitation(
            input["link"].as_str().ok_or("Paste a project invitation")?,
            None,
            "",
            false,
        )?,
        (&Method::POST, "/local/invites/join") => join_project(
            input,
            &format!(
                "http://{}",
                headers
                    .get(header::HOST)
                    .and_then(|host| host.to_str().ok())
                    .unwrap_or_default()
            ),
        )?,
        (&Method::POST, "/local/projects/add") => {
            let root = Path::new(input["root"].as_str().ok_or("Choose a project directory")?);
            let mut result = project_init::initialize(root)?;
            let project = &result["project"];
            result["project"] =
                json!({"id":project["projectId"],"root":project["root"],"name":root.file_name()});
            result
        }
        (&Method::POST, "/local/projects/select") => {
            let id = input["id"].as_str().ok_or("Choose a project")?;
            let binding = projects
                .iter()
                .find(|item| item.local_id == id)
                .ok_or("Project unavailable")?;
            let mut result = response(StatusCode::OK, project_state(binding)?);
            result.headers_mut().insert(
                header::SET_COOKIE,
                HeaderValue::from_str(&format!(
                    "spool_project={id}; HttpOnly; SameSite=Strict; Path=/local; Max-Age=31536000"
                ))?,
            );
            return Ok(result);
        }
        (&Method::POST, "/local/team/host") => local_host(input)?,
        (&Method::POST, "/local/workspace") => workspace(selected, input)?,
        (&Method::POST, "/local/discovery") => crate::discovery::run(input)?,
        (&Method::POST, "/local/projects/browse") => pick_folder()?,
        _ => {
            let binding = selected.ok_or("Select a project to continue")?;
            match (method, path) {
                (&Method::GET, "/local/status") => project_state(binding)?,
                (&Method::GET, "/local/memory-setup") => memory_setup()?,
                (&Method::GET, "/local/agents") => agents()?,
                (&Method::POST, "/local/memory/update") => update_memory(binding, input)?,

                (&Method::POST, "/local/capture") => capture_project(binding)?,
                (&Method::POST, "/local/agents/connect") => connect_agents()?,
                (&Method::POST, "/local/review") => review(binding, input)?,
                (&Method::POST, "/local/memory") => {
                    if crate::memory_mutation::command(input) {
                        return Err("Use agent tools for memory writes".into());
                    }
                    if input["command"] == "file_read" {
                        return Ok(response(
                            StatusCode::OK,
                            crate::local_source::read(binding, input)?,
                        ));
                    }
                    let mut value = binding.memory(input)?;
                    crate::git_evidence::reconcile(&binding.root, &mut value);
                    value
                }
                (&Method::POST, "/local/codex/connect" | "/local/codex/disconnect") => {
                    let path_enabled = path.ends_with("/connect");
                    workspace_client::save_atomic(
                        &binding.directory.join("integrations.json"),
                        &json!({"codex":path_enabled}),
                    )?;
                    project_state(binding)?
                }
                _ => return Ok(failure(StatusCode::NOT_FOUND, "Unknown local action")),
            }
        }
    };
    Ok(response(StatusCode::OK, value))
}

async fn route(State(state): State<Arc<LocalWeb>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let host = state.address.to_string();
    if parts
        .headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(host.as_str())
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Open SpoolDB at its loopback address",
        );
    }
    let path = parts.uri.path();
    if path == "/healthz" && parts.method == Method::GET {
        return response(
            StatusCode::OK,
            json!({"ok":true,"protocol":"spool-relay/1"}),
        );
    }
    let first_run =
        path == "/" && project_binding::registered_roots().is_ok_and(|roots| roots.is_empty());
    if parts.method == Method::GET
        && let Some(asset) = setup_asset(path, first_run)
    {
        return asset;
    }
    if path == "/" && parts.method == Method::GET {
        return (
            StatusCode::FOUND,
            [
                (header::LOCATION, "/review/"),
                (header::CACHE_CONTROL, "no-store"),
            ],
        )
            .into_response();
    }
    if let Some(asset) = review_asset(&parts.method, &parts.uri) {
        return asset;
    }
    let origin = format!("http://{host}");
    let setup = path.starts_with("/api/");
    if !(setup || path.starts_with("/local/"))
        || parts
            .headers
            .get("sec-fetch-site")
            .is_none_or(|value| value != "same-origin")
        || parts
            .headers
            .get(header::ORIGIN)
            .is_some_and(|value| value.as_bytes() != origin.as_bytes())
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Open SpoolDB in the local browser first",
        );
    }
    if matches!(path, "/local/session" | "/api/session") && parts.method == Method::GET {
        return tokio::task::spawn_blocking(move || {
            session(&state, &parts.headers, setup).map_err(|error| error.to_string())
        })
        .await
        .map_or_else(
            |_| failure(StatusCode::INTERNAL_SERVER_ERROR, "Local app unavailable"),
            |result| {
                result.unwrap_or_else(|error| failure(StatusCode::BAD_REQUEST, error.to_string()))
            },
        );
    }
    if !authenticated(&state, &parts.headers, setup) {
        return failure(
            StatusCode::UNAUTHORIZED,
            "Reload to refresh the local session",
        );
    }
    let input = if parts.method == Method::POST {
        if parts
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_none_or(|value| value.split(';').next() != Some("application/json"))
        {
            return failure(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Use JSON");
        }
        match tokio::time::timeout(Duration::from_secs(15), to_bytes(body, MAX_BODY)).await {
            Ok(Ok(bytes)) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) if value.is_object() => value,
                _ => return failure(StatusCode::BAD_REQUEST, "Expected a local action object"),
            },
            _ => {
                return failure(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Invalid or oversized local request",
                );
            }
        }
    } else if parts.method == Method::GET {
        Value::Null
    } else {
        return failure(StatusCode::METHOD_NOT_ALLOWED, "Unsupported method");
    };
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let result = if setup && parts.method == Method::POST {
            setup_api(&path, &input, &origin)
        } else {
            dispatch(&parts.headers, &path, &parts.method, &input)
        };
        result.map_err(|error| error.to_string())
    })
    .await
    .map_or_else(
        |_| failure(StatusCode::INTERNAL_SERVER_ERROR, "Local app unavailable"),
        |result| result.unwrap_or_else(|error| failure(StatusCode::BAD_REQUEST, error.to_string())),
    )
}

pub async fn open(port: u16) -> Result<(tokio::net::TcpListener, Router)> {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    let mut secret = [0; 32];
    getrandom::fill(&mut secret)?;
    let state = Arc::new(LocalWeb { address, secret });
    let router = Router::new().fallback(route).with_state(state);
    Ok((listener, router))
}

pub async fn serve(port: u16) -> Result<()> {
    let (listener, router) = open(port).await?;
    let address = listener.local_addr()?;
    println!("{address}");
    axum::serve(listener, router).await?;
    Ok(())
}
