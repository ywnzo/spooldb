use crate::{
    Result,
    native_memory::NativeMemory,
    project_init::{private_dir, write_private},
    relay, retrieval_settings, workspace,
    workspace_client::save_atomic,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{Value, json};
use std::{fs, net::SocketAddr, path::Path, time::Duration};
use url::Url;

fn prepare(
    directory: &Path,
    requested: Option<&str>,
    fallback: Option<String>,
    private_tls: Option<bool>,
) -> Result<(std::path::PathBuf, fs::File)> {
    let home = std::path::absolute(directory)?;
    if !home.try_exists()? {
        fs::create_dir_all(home.parent().ok_or("Invalid host data folder")?)?;
        private_dir(&home)?;
    }
    let home = fs::canonicalize(home)?;
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(home.join("native-team-host.lock"))?;
    lock.try_lock()
        .map_err(|_| "A native relay is already running for this directory")?;
    if std::os::unix::net::UnixStream::connect(home.join("admin.sock")).is_ok() {
        return Err("Stop the existing relay before opening its data directory".into());
    }
    let config = home.join("host.json");
    let database = home.join("shared.sqlite");
    let mut settings: Value = match fs::read(&config) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            json!({"projects":[],"credentials":[]})
        }
        Err(error) => return Err(error.into()),
    };
    if !settings["projects"].is_array() || !settings["credentials"].is_array() {
        return Err("Existing host configuration is invalid".into());
    }
    let configured = requested
        .or_else(|| settings["publicOrigin"].as_str())
        .or(fallback.as_deref());
    let origin = match configured {
        Some(origin) => public_url(origin)?,
        _ => return Err("Use --origin when selecting an ephemeral port".into()),
    };
    if let Some(enabled) = private_tls {
        settings["privateTls"] = json!(enabled);
    }
    if settings["privateTls"] == true {
        if !origin.starts_with("https://") {
            return Err("Private TLS requires an HTTPS origin".into());
        }
        crate::relay_tls::configure(&home)?;
    }
    settings["publicOrigin"] = json!(origin);
    key_files(&home, &database)?;
    if !database.try_exists()? {
        write_private(&database, b"")?;
    }
    save_atomic(&config, &settings)?;
    Ok((home, lock))
}

pub fn start(directory: &Path, address: SocketAddr, public_origin: Option<&str>) -> Result<()> {
    let fallback = (address.port() != 0).then(|| format!("http://{address}"));
    let (home, _lock) = prepare(directory, public_origin, fallback, None)?;
    tokio::runtime::Runtime::new()?.block_on(relay::serve(
        home.join("shared.sqlite"),
        home.join("host.json"),
        address,
    ))
}

pub fn setup(directory: &Path, origin: &str, name: &str, private_tls: bool) -> Result<Value> {
    let (home, _lock) = prepare(directory, Some(origin), None, Some(private_tls))?;
    relay::initialize_store(&home.join("shared.sqlite"), &home.join("host.json"))?;
    request(&home, &json!({"command":"workspace-init","name":name}))
}

fn public_url(value: &str) -> Result<String> {
    let url = Url::parse(value)?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.scheme() == "http"
            && !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err("Use a public HTTPS hostname or loopback HTTP origin".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn key_files(directory: &Path, database: &Path) -> Result<()> {
    let existing = if database.try_exists()? {
        Some(Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?)
    } else {
        None
    };
    let has_meta = match &existing {
        Some(db) => db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
            WHERE type='table' AND name='deployment_meta')",
            [],
            |row| row.get::<_, bool>(0),
        )?,
        None => false,
    };
    for key in ["workspace-key", "invite-key"] {
        let stored: Option<String> = if has_meta {
            existing
                .as_ref()
                .expect("metadata requires a database")
                .query_row(
                    "SELECT value FROM deployment_meta WHERE key=?1",
                    [key],
                    |row| row.get(0),
                )
                .optional()?
        } else {
            None
        };
        let path = directory.join(key);
        if path.try_exists()? {
            let bytes = fs::read(&path)?;
            if bytes.len() != 32
                || stored
                    .as_ref()
                    .is_some_and(|key| *key != STANDARD.encode(&bytes))
            {
                return Err("Saved workspace key is invalid or differs from the database".into());
            }
            continue;
        }
        let mut bytes = [0; 32];
        if let Some(stored) = stored {
            let value = STANDARD.decode(stored)?;
            if value.len() != 32 {
                return Err("Saved workspace key is invalid".into());
            }
            bytes.copy_from_slice(&value);
        } else {
            getrandom::fill(&mut bytes)?;
        }
        write_private(&path, &bytes)?;
    }
    Ok(())
}

pub fn compatible_request(directory: &Path, input: &Value) -> Result<Value> {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        os::unix::net::UnixStream,
    };
    let socket = directory.join("admin.sock");
    let mut stream = match UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            return request(directory, input);
        }
        Err(error) => return Err(error.into()),
    };
    let timeout = Some(Duration::from_secs(8));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;
    serde_json::to_writer(&mut stream, input)?;
    stream.write_all(b"\n")?;
    let mut bytes = Vec::new();
    BufReader::new(stream)
        .take(1_000_001)
        .read_until(b'\n', &mut bytes)?;
    if bytes.len() > 1_000_000 || bytes.last() != Some(&b'\n') {
        return Err("Invalid relay administration response".into());
    }
    let response: Value = serde_json::from_slice(&bytes)?;
    if let Some(message) = response["error"].as_str() {
        return Err(message.to_owned().into());
    }
    Ok(response)
}

pub fn request(directory: &Path, input: &Value) -> Result<Value> {
    if input["command"] != "list" && directory.join(".spool-update-gate").try_exists()? {
        return Err("Relay update in progress; retry shortly".into());
    }

    let config: Value = serde_json::from_slice(&fs::read(directory.join("host.json"))?)?;
    let origin = config["publicOrigin"]
        .as_str()
        .ok_or("Start the native relay before administering its data folder")?;
    if input["command"] == "relay-admin" {
        let mut request = input.clone();
        request
            .as_object_mut()
            .ok_or("Expected a local host action")?
            .remove("command");
        let socket = config["controlSocket"]
            .as_str()
            .unwrap_or("/run/spool-control/agent.sock");
        return relay::host_control(Path::new(socket), &request);
    }
    let path = directory.join("shared.sqlite");
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(5))?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let backend = NativeMemory(&tx);
    let result = match input["command"].as_str() {
        Some("workspace-init") => {
            workspace::setup(&backend, input, origin).map_err(|error| error.2)?
        }
        Some("workspace-owner-invite") => {
            workspace::owner_recovery(&backend, origin).map_err(|error| error.2)?
        }
        Some("retrieval") if input["action"] != "test" => {
            retrieval_settings::run(&tx, input).map_err(|error| error.2)?
        }
        Some("create") => workspace::local_create(&backend, input).map_err(|error| error.2)?,
        Some("create-invite" | "revoke") => {
            let room = input["room"].as_str().ok_or("Choose a project room")?;
            let exists = tx
                .query_row("SELECT 1 FROM team_projects WHERE room=?1", [room], |_| {
                    Ok(())
                })
                .optional()?
                .is_some();
            if !exists {
                return Err("Shared project not found".into());
            }
            if input["command"] == "create-invite" {
                workspace::issue(
                    &backend,
                    origin,
                    Some(room),
                    input["label"].as_str().unwrap_or("Teammate"),
                    input["role"].as_str().unwrap_or("write"),
                    false,
                )
                .map_err(|error| error.2)?
            } else {
                let member = input["memberId"].as_str().ok_or("Choose a member ID")?;
                let count = tx.execute(
                    "UPDATE team_members SET revoked=1 WHERE id=?1 AND room=?2 AND revoked=0",
                    rusqlite::params![member, room],
                )?;
                if count == 0 {
                    return Err("Member not found".into());
                }
                json!({"revoked":true})
            }
        }
        Some("list") => {
            let mut query = tx.prepare("SELECT room,name FROM team_projects ORDER BY rowid")?;
            let mut members = tx.prepare(
                "SELECT id,label,role FROM team_members WHERE room=?1 AND revoked=0 ORDER BY id",
            )?;
            let mut items = Vec::new();
            let mut rows = query.query([])?;
            while let Some(row) = rows.next()? {
                let room: String = row.get(0)?;
                let name: String = row.get(1)?;
                let connections = members
                    .query_map([&room], |row| {
                        Ok(
                            json!({"id":row.get::<_,String>(0)?,"label":row.get::<_,String>(1)?,
                        "role":row.get::<_,String>(2)?}),
                        )
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                items.push(json!({"room":room,"name":name,"members":connections}));
            }
            json!({"url":origin,"projects":items})
        }
        _ => return Err("Unknown native shared host action".into()),
    };
    let result = if config["privateTls"] == true {
        crate::relay_tls::pins(result, &crate::relay_tls::certificate(directory)?, origin)?
    } else {
        result
    };
    tx.commit()?;
    Ok(result)
}
