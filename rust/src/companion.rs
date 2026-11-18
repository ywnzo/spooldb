use crate::{Result, capture, capture_export, codex_history, project_binding};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    net::{SocketAddr, TcpStream},
    os::unix::fs::{FileTypeExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Default)]
pub struct Companion {
    published: BTreeMap<PathBuf, String>,
    history: Option<codex_history::History>,
}

fn relay_frontier(binding: &project_binding::Binding) -> Result<String> {
    let db = Connection::open_with_flags(
        binding.directory.join("relay.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    db.busy_timeout(Duration::from_secs(5))?;
    Ok(db.query_row(
        "SELECT heads FROM shard_refs WHERE name=?1 AND room=?2",
        [
            format!("relay-{}", binding.local_id),
            binding.local_id.clone(),
        ],
        |row| row.get(0),
    )?)
}

impl Companion {
    pub fn cycle(&mut self, executable: &Path) -> Result<Value> {
        let roots = project_binding::registered_roots()?;
        self.published.retain(|root, _| roots.contains(root));
        let projects = roots
            .into_iter()
            .map(|root| match self.project(&root, executable) {
                Ok(value) => value,
                Err(error) => json!({"root":root,"status":"error","error":error.to_string()}),
            })
            .collect::<Vec<_>>();
        Ok(json!({"projects":projects}))
    }

    pub(crate) fn project(&mut self, root: &Path, executable: &Path) -> Result<Value> {
        let binding = project_binding::resolve(root)?;
        let mut result = json!({"project":binding.info(),"status":"idle"});
        if project_binding::capture_enabled(&binding)? {
            if self.history.is_none() {
                self.history = Some(codex_history::History::start(executable)?);
            }
            let capture = self
                .history
                .as_mut()
                .expect("history was started")
                .poll(&binding.root, &binding.directory.join("capture.sqlite"));
            if capture.is_err() {
                self.history = None;
            }
            result["capture"] = capture?;
            result["status"] = json!("captured");
        }
        result["publish"] = capture::publish_local(&binding.directory, &binding.local_id)?;
        if let Some(grant) = &binding.grant {
            let frontier = relay_frontier(&binding)?;
            let signature = format!(
                "{:x}",
                Sha256::digest(json!([grant.url, grant.room, grant.token, frontier]).to_string())
            );
            if self.published.get(root) != Some(&signature) {
                result["share"] =
                    capture_export::export(&binding.directory, &binding.local_id, grant)?;
                self.published.insert(root.to_owned(), signature);
            }
        } else {
            self.published.remove(root);
        }
        Ok(result)
    }
}

fn prior_service_is_live(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    value["origin"]
        .as_str()
        .and_then(|origin| origin.strip_prefix("http://"))
        .and_then(|origin| origin.parse::<SocketAddr>().ok())
        .is_some_and(|address| {
            address.ip().is_loopback()
                && TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
        })
}

struct Ready {
    path: PathBuf,
    receipt: Value,
}

impl Drop for Ready {
    fn drop(&mut self) {
        if fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|value| {
                ["pid", "backend", "origin"]
                    .iter()
                    .all(|key| value[*key] == self.receipt[*key])
            })
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct DiscoverySocket(PathBuf);

impl Drop for DiscoverySocket {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn open_discovery(state: &Path) -> Result<(tokio::net::UnixListener, DiscoverySocket)> {
    let path = state.join("discovery.sock");
    match fs::symlink_metadata(&path) {
        Ok(entry) if entry.file_type().is_socket() => {
            match std::os::unix::net::UnixStream::connect(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                    fs::remove_file(&path)?;
                }
                _ => return Err("SpoolDB discovery socket is already in use".into()),
            }
        }
        Ok(_) => return Err("SpoolDB discovery path is occupied by a non-socket file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    let cleanup = DiscoverySocket(path);
    fs::set_permissions(&cleanup.0, fs::Permissions::from_mode(0o600))?;
    Ok((listener, cleanup))
}

async fn discovery_loop(listener: tokio::net::UnixListener, origin: String) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(32));
    let origin: std::sync::Arc<str> = origin.into();
    loop {
        let (mut stream, _) = listener.accept().await?;
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            continue;
        };
        let origin = origin.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let request = async {
                let mut line = Vec::new();
                let mut input = BufReader::new((&mut stream).take(20_001));
                input.read_until(b'\n', &mut line).await?;
                if line.len() > 20_000 || line.last() != Some(&b'\n') {
                    return Ok::<(), Box<dyn std::error::Error + Send + Sync>>(());
                }
                let result = tokio::task::spawn_blocking(move || {
                    let input: Value =
                        serde_json::from_slice(&line).map_err(|error| error.to_string())?;
                    let mut result =
                        crate::discovery::run(&input).map_err(|error| error.to_string())?;
                    if let Some(fields) = result.as_object_mut() {
                        fields
                            .entry("origin")
                            .or_insert_with(|| json!(origin.as_ref()));
                    }
                    if input["command"] == "list" {
                        result["companion"] = json!({
                            "protocol":"spool-companion/1",
                            "version":crate::version().map_err(|error| error.to_string())?,
                            "pid":std::process::id(),
                            "kind":"native",
                            "capabilities":["git-submodules"]
                        });
                    }
                    Ok::<Value, String>(result)
                })
                .await?;
                let value = match result {
                    Ok(result) => json!({"result":result}),
                    Err(error) => json!({"error":error}),
                };
                let mut encoded = serde_json::to_vec(&value)?;
                encoded.push(b'\n');
                stream.write_all(&encoded).await?;
                Ok(())
            };
            let _ = tokio::time::timeout(Duration::from_secs(65), request).await;
        });
    }
}

pub async fn serve(executable: PathBuf, every: Duration) -> Result<()> {
    let state = project_binding::state_root()?;
    if !state.try_exists()? {
        fs::create_dir_all(state.parent().ok_or("Invalid state directory")?)?;
        crate::project_init::private_dir(&state)?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("native-companion.lock"))?;
    lock.try_lock()
        .map_err(|error| format!("Could not acquire the companion lock: {error}"))?;
    let path = state.join("service.json");
    if prior_service_is_live(&path) {
        return Err("SpoolDB’s local service is already running for this state directory".into());
    }
    let (listener, router) = crate::local_web::open(0).await?;
    let (discovery, _socket) = open_discovery(&state)?;
    let origin = format!("http://{}", listener.local_addr()?);
    let mode = if project_binding::registered_roots()?.is_empty() {
        "setup"
    } else {
        "ready"
    };
    let receipt = json!({"origin":origin,"mode":mode,"pid":std::process::id(),"backend":"rust"});
    crate::workspace_client::save_atomic(&path, &receipt)?;
    let _ready = Ready { path, receipt };

    let stop = tokio::signal::ctrl_c();
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let terminate = async {
        #[cfg(unix)]
        {
            let _ = term.recv().await;
        }
        #[cfg(not(unix))]
        std::future::pending::<()>().await;
    };
    tokio::select! {
        _ = stop => Ok(()),
        _ = terminate => Ok(()),
        result = axum::serve(listener,router) => Ok(result?),
        result = discovery_loop(discovery,origin) => result,
        result = capture_loop(executable,every) => result,
    }
}

async fn capture_loop(executable: PathBuf, every: Duration) -> Result<()> {
    let mut interval = tokio::time::interval(every);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut companion = Companion::default();
    let mut previous = None;
    loop {
        interval.tick().await;
        let path = executable.clone();
        let (updated, result) = tokio::task::spawn_blocking(move || {
            let result = companion.cycle(&path).map_err(|error| error.to_string());
            (companion, result)
        })
        .await?;
        companion = updated;
        if previous.as_ref() != Some(&result) {
            match &result {
                Ok(status) => println!("{status}"),
                Err(error) => eprintln!("spool companion: {error}"),
            }
            previous = Some(result);
        }
    }
}
