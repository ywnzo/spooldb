use crate::{
    Result, private_files, relay_recovery,
    relay_retention::{metadata, regular_json, uuid},
    relay_update::Installation,
    release_download,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    os::unix::{
        fs::{FileTypeExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::Path,
    process::{Command, Stdio},
    time::{Duration, SystemTime},
};

fn now() -> DateTime<Utc> {
    DateTime::<Utc>::from(SystemTime::now())
}
fn stamp() -> String {
    now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn age(value: &Value) -> Option<chrono::Duration> {
    let time = DateTime::parse_from_rfc3339(value.as_str()?).ok()?;
    Some(now().signed_duration_since(time))
}

fn hash(input: &Value) -> String {
    format!("{:x}", Sha256::digest(input.to_string()))
}
fn revision(status: &Value) -> String {
    hash(&json!([
        status["enabled"] == true,
        status["backupRetention"],
        status["artifactRetention"]
    ]))
}
fn plan_hash(plan: &Value) -> String {
    fn names(value: &Value) -> Vec<String> {
        let mut items = value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        items.sort_unstable();
        items
    }
    hash(&json!([
        names(&plan["removed"]),
        names(&plan["artifacts"]["removedImages"]),
        names(&plan["artifacts"]["removedReleases"])
    ]))
}

fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|entries| {
        entries.len() == keys.len() && keys.iter().all(|key| entries.contains_key(*key))
    })
}

fn validate(input: &Value) -> Result<&str> {
    let action = input["action"]
        .as_str()
        .ok_or("Choose a maintenance action")?;
    if action == "status" && exact(input, &["action"]) {
        return Ok(action);
    }
    if !matches!(
        action,
        "check" | "update" | "configure" | "preview" | "cleanup" | "recover"
    ) || input["requestId"].as_str().is_none_or(|id| !uuid(id))
    {
        return Err("Choose a supported maintenance action and a UUID request ID".into());
    }
    if action == "configure" {
        let settings = &input["settings"];
        if !exact(input, &["action", "requestId", "settings"])
            || !exact(
                settings,
                &[
                    "automatic",
                    "expectedRevision",
                    "backupRetention",
                    "artifactRetention",
                ],
            )
            || !settings["automatic"].is_boolean()
            || settings["expectedRevision"].as_str().is_none_or(|value| {
                value.len() != 64 || !value.bytes().all(|c| matches!(c,b'0'..=b'9'|b'a'..=b'f'))
            })
        {
            return Err("Invalid maintenance settings".into());
        }
        for key in ["backupRetention", "artifactRetention"] {
            let policy = &settings[key];
            if !exact(policy, &["keep", "maxAgeDays"])
                || policy["keep"]
                    .as_u64()
                    .is_none_or(|n| !(1..=100).contains(&n))
                || policy["maxAgeDays"]
                    .as_u64()
                    .is_none_or(|n| !(1..=3650).contains(&n))
            {
                return Err("Retention requires 1–100 copies and 1–3650 days".into());
            }
        }
    } else if action == "cleanup" {
        if !exact(input, &["action", "requestId", "previewId"])
            || input["previewId"].as_str().is_none_or(|id| !uuid(id))
        {
            return Err("Preview cleanup before applying it".into());
        }
    } else if !exact(input, &["action", "requestId"]) {
        return Err("Unexpected maintenance parameters".into());
    }
    Ok(action)
}

fn live(pid: i32) -> bool {
    pid > 1
        && rustix::process::Pid::from_raw(pid).is_some_and(|pid| {
            matches!(
                rustix::process::test_kill_process(pid),
                Ok(()) | Err(rustix::io::Errno::PERM)
            )
        })
}

fn public(job: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for key in [
        "id",
        "action",
        "status",
        "createdAt",
        "completedAt",
        "result",
        "error",
    ] {
        if let Some(item) = job.get(key) {
            result.insert(key.to_owned(), item.clone());
        }
    }
    Value::Object(result)
}

fn jobs(root: &Path) -> Result<Vec<Value>> {
    let directory = root.join("control-jobs");
    crate::workspace_client::ensure_state(&directory)?;
    let mut jobs = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
            .is_none_or(|id| !uuid(id))
        {
            continue;
        }
        let path = entry.path();
        let Some(mut job) = regular_json(&path)? else {
            continue;
        };
        let alive = job["pid"]
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .is_some_and(live);
        let abandoned = job["status"] == "running" && !alive
            || job["status"] == "queued"
                && age(&job["createdAt"]).is_some_and(|age| age > chrono::Duration::minutes(1));
        if abandoned {
            job["status"] = json!("failed");
            job["error"] =
                json!("Maintenance was interrupted. Refresh relay status before retrying.");
            job["completedAt"] = json!(stamp());
            private_files::save_atomic(&path, &job)?;
        }
        jobs.push((path, job));
    }
    jobs.sort_by(|a, b| b.1["createdAt"].as_str().cmp(&a.1["createdAt"].as_str()));
    let mut recent = Vec::new();
    for (index, (path, job)) in jobs.into_iter().enumerate() {
        if index < 20 || pending(&job) {
            recent.push(job);
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(recent)
}

fn pending(job: &Value) -> bool {
    matches!(job["status"].as_str(), Some("queued" | "running"))
}

fn operation(installation: &Installation) -> Result<(bool, bool, bool)> {
    let lock = installation.lock_path();
    let present = metadata(&lock)?.is_some();
    let pid = fs::read_to_string(lock.join("pid"))
        .ok()
        .and_then(|value| value.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 1);
    Ok((present, pid.is_some(), pid.is_some_and(live)))
}

fn status(config: &Path, installation: &Installation) -> Result<Value> {
    let status = installation.status()?;
    let jobs = jobs(&installation.root)?;
    let (lock, known, live) = operation(installation)?;
    let journal = installation
        .root
        .join("relay-update-journal.json")
        .try_exists()?;
    let disk = rustix::fs::statvfs(&installation.root)?;
    let settings = regular_json(config)?.ok_or("Missing managed relay settings")?;
    let engine = relay_recovery::absolute_executable(
        settings["engine"].as_str().ok_or("Missing relay engine")?,
    )?;
    let container = relay_recovery::run(engine, &["container", "inspect", "spool-relay"])
        .ok()
        .and_then(|value| serde_json::from_str::<Value>(&value).ok());
    let timer = Command::new("systemctl")
        .args([
            "show",
            "spool-relay-update.timer",
            "--property=NextElapseUSecRealtime",
            "--value",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    Ok(
        json!({"supported":true,"version":status["current"],"automatic":status["enabled"]==true,
        "backupRetention":status["backupRetention"],"artifactRetention":status["artifactRetention"],
        "revision":revision(&status),"needsRecovery":journal || lock&&known&&!live,
        "canRecover":!live&&(journal||lock&&known),"busy":lock||jobs.iter().any(pending),
        "relayRunning":container.and_then(|data|data[0]["State"]["Running"].as_bool()),
        "timerNext":timer,"disk":{"availableBytes":disk.f_bavail.saturating_mul(disk.f_bsize),
            "totalBytes":disk.f_blocks.saturating_mul(disk.f_bsize)},
        "backupCleanup":status["backupCleanup"],"artifactCleanup":status["artifactCleanup"],
        "jobs":jobs.iter().take(5).map(public).collect::<Vec<_>>()}),
    )
}

fn accept(config: &Path, input: &Value) -> Result<Value> {
    let action = validate(input)?;
    let installation = Installation::open(config)?;
    if action == "status" {
        return status(config, &installation);
    }
    let id = input["requestId"].as_str().ok_or("Missing request ID")?;
    let current = jobs(&installation.root)?;
    let path = installation
        .root
        .join("control-jobs")
        .join(format!("{id}.json"));
    if let Some(prior) = regular_json(&path)? {
        if prior["action"] != action
            || prior["settings"] != input["settings"]
            || prior["previewId"] != input["previewId"]
        {
            return Err("Request ID already used for another action".into());
        }
        return Ok(json!({"accepted":true,"job":public(&prior)}));
    }
    if current.iter().any(pending) {
        return Err("Another maintenance action is already running".into());
    }
    let (lock, _, live) = operation(&installation)?;
    if lock && (action != "recover" || live) {
        return Err("Relay update is busy or needs recovery".into());
    }
    let mut job = json!({"id":id,"action":action,"status":"queued","createdAt":stamp(),
        "fingerprint":hash(&json!([action,input["settings"],input["previewId"]]))});
    for key in ["settings", "previewId"] {
        if let Some(value) = input.get(key) {
            job[key] = value.clone();
        }
    }
    private_files::save(&path, &job)?;
    let child = Command::new(std::env::current_exe()?)
        .args(["relay-control-worker", id])
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match child {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(error) => {
            job["status"] = json!("failed");
            job["error"] = json!(error.to_string());
            job["completedAt"] = json!(stamp());
            private_files::save_atomic(&path, &job)?;
            return Err(error.into());
        }
    }
    Ok(json!({"accepted":true,"job":public(&job)}))
}

pub fn worker(config: &Path, id: &str) -> Result<()> {
    if !rustix::process::getuid().is_root() || !uuid(id) {
        return Err("Invalid relay maintenance worker".into());
    }
    let installation = Installation::open(config)?;
    let directory = installation.root.join("control-jobs");
    let path = directory.join(format!("{id}.json"));
    let mut job = regular_json(&path)?.ok_or("Missing maintenance job")?;
    if job["status"] != "queued" {
        return Ok(());
    }
    let mut request = json!({"action":job["action"],"requestId":id});
    for key in ["settings", "previewId"] {
        if let Some(value) = job.get(key) {
            request[key] = value.clone();
        }
    }
    validate(&request)?;
    job["status"] = json!("running");
    job["pid"] = json!(std::process::id());
    private_files::save_atomic(&path, &job)?;
    let result = run_job(&installation, &directory, &job);
    job["completedAt"] = json!(stamp());
    match result {
        Ok(result) => {
            job["result"] = result;
            job["status"] = json!("succeeded");
        }
        Err(error) => {
            job["error"] = json!(error.to_string().chars().take(1600).collect::<String>());
            job["status"] = json!("failed");
        }
    }
    private_files::save_atomic(&path, &job)
}

fn run_job(installation: &Installation, directory: &Path, job: &Value) -> Result<Value> {
    match job["action"].as_str() {
        Some("check") => {
            let result = release_download::check(&installation.current)?;
            Ok(
                json!({"current":result["current"],"latest":result["latest"],"available":result["available"]}),
            )
        }
        Some("update") => {
            let _lock = installation.lock()?;
            let result = installation.update()?;
            Ok(
                json!({"current":result["current"],"latest":result["latest"],"updated":result["updated"]==true}),
            )
        }
        Some("recover") => installation.recover(),
        Some("preview") => {
            let _lock = installation.lock()?;
            let mut result = installation.cleanup(true)?;
            result["planHash"] = json!(plan_hash(&result));
            Ok(result)
        }
        Some("cleanup") => {
            let _lock = installation.lock()?;
            let id = job["previewId"]
                .as_str()
                .filter(|id| uuid(id))
                .ok_or("Invalid preview ID")?;
            let preview = regular_json(&directory.join(format!("{id}.json")))?
                .ok_or("Missing cleanup preview")?;
            let clean = |result: &Value| {
                [&result["errors"], &result["artifacts"]["errors"]]
                    .iter()
                    .all(|errors| errors.as_array().is_none_or(Vec::is_empty))
            };
            if preview["action"] != "preview"
                || preview["status"] != "succeeded"
                || !clean(&preview["result"])
                || age(&preview["completedAt"]).is_none_or(|age| age > chrono::Duration::minutes(5))
            {
                return Err("A successful recent cleanup preview is required".into());
            }
            let current = installation.cleanup(true)?;
            if !clean(&current) || preview["result"]["planHash"] != plan_hash(&current) {
                return Err("Cleanup plan changed. Preview cleanup again.".into());
            }
            installation.cleanup(false)
        }
        Some("configure") => {
            let _lock = installation.lock()?;
            let settings = &job["settings"];
            if settings["expectedRevision"] != revision(&installation.status()?) {
                return Err("Settings changed. Refresh and try again.".into());
            }
            installation.configure(settings["automatic"] == true, Some(settings))?;
            Ok(json!({"saved":true}))
        }
        _ => Err("Unsupported maintenance job".into()),
    }
}

fn serve_one(config: &Path, mut socket: UnixStream) -> Result<()> {
    let timeout = Some(Duration::from_secs(6));
    socket.set_read_timeout(timeout)?;
    socket.set_write_timeout(timeout)?;
    let mut line = Vec::new();
    BufReader::new(&socket)
        .take(20_001)
        .read_until(b'\n', &mut line)?;
    if line.len() > 20_000 || line.last() != Some(&b'\n') {
        return Err("Invalid maintenance request frame".into());
    }
    let reply = serde_json::from_slice(&line)
        .map_err(|error| error.into())
        .and_then(|input| accept(config, &input))
        .unwrap_or_else(|error| json!({"error":error.to_string()}));
    serde_json::to_writer(&mut socket, &reply)?;
    socket.write_all(b"\n")?;
    Ok(())
}

pub fn serve(config: &Path) -> Result<()> {
    if !rustix::process::getuid().is_root() {
        return Err("Relay control requires root".into());
    }
    let config = std::path::absolute(config)?;
    let installation = Installation::open(&config)?;
    let directory = installation.root.join("control");
    if !metadata(&directory)?.is_some_and(|meta| meta.is_dir()) {
        return Err("Missing managed relay control directory".into());
    }
    let path = directory.join("agent.sock");
    if let Some(meta) = metadata(&path)? {
        if !meta.file_type().is_socket() {
            return Err("Unmanaged control socket path".into());
        }
        match UnixStream::connect(&path) {
            Ok(_) => return Err("Relay control is already running".into()),
            Err(error) if error.kind() == ErrorKind::ConnectionRefused => fs::remove_file(&path)?,
            Err(error) => return Err(error.into()),
        }
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o660))?;
    std::os::unix::fs::chown(&path, Some(0), Some(1000))?;
    for stream in listener.incoming() {
        if let Err(error) = serve_one(&config, stream?) {
            eprintln!("Relay maintenance request failed: {error}");
        }
    }
    Ok(())
}

pub fn install(config: &Path, settings: &Value) -> Result<()> {
    if settings["hostControl"] != true {
        return Ok(());
    }
    const MARKER: &str = "# Managed by SpoolDB relay control";
    let root = config
        .parent()
        .ok_or("Missing relay installation directory")?;
    let app = Path::new(
        settings["app"]
            .as_str()
            .ok_or("Missing installed relay application")?,
    );
    let program = app.join("runtime/spool-native-linux-x64");
    let unit = Path::new("/etc/systemd/system/spool-relay-control.service");
    if let Some(file) = metadata(unit)?
        && (!file.is_file() || file.len() > 32_768 || !fs::read_to_string(unit)?.contains(MARKER))
    {
        return Err("Unmanaged relay control service".into());
    }
    let quote = |path: &Path| json!(path.to_string_lossy().replace('%', "%%").replace('$', "$$"));
    let program = if settings["relayBackend"] != "rust" {
        let bun = app.join("runtime/bun");
        let script = app.join("src/relay-control-service.js");
        if ![&bun, &script].into_iter().all(|path| path.is_file()) {
            return Err("The previous relay control program is missing".into());
        }
        format!("{} {}", quote(&bun), quote(&script))
    } else {
        if !metadata(&program)?.is_some_and(|file| file.is_file()) {
            return Err("The installed relay control binary is missing".into());
        }
        format!("{} relay-control", quote(&program))
    };
    let config_arg = quote(config);
    let text = format!(
        "{MARKER}\n[Unit]\nDescription=SpoolDB owner maintenance control\nAfter=network-online.target spool-shared.service\nWants=network-online.target\n[Service]\nType=simple\nExecStart={program} {config_arg}\nRestart=on-failure\nRestartSec=3\nKillMode=process\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n"
    );
    let pending = unit.with_file_name(format!(
        ".spool-control-{}.tmp",
        private_files::random_id()?
    ));
    let result = private_files::write_private(&pending, text.as_bytes())
        .and_then(|()| Ok(fs::rename(&pending, unit)?));
    if result.is_err() {
        let _ = fs::remove_file(pending);
    }
    result?;
    private_files::save_atomic(
        &root.join("relay-control-runtime.json"),
        &json!({"previous":settings}),
    )?;
    for args in [
        vec!["daemon-reload"],
        vec!["enable", "spool-relay-control.service"],
        vec!["restart", "spool-relay-control.service"],
    ] {
        if !Command::new("systemctl")
            .args(args)
            .stdin(Stdio::null())
            .status()?
            .success()
        {
            return Err("Could not activate the relay control service".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maintenance_input_rejects_unexpected_fields_and_requires_a_preview() {
        let id = "00000000-0000-0000-0000-000000000002";
        assert_eq!(validate(&json!({"action":"status"})).unwrap(), "status");
        assert!(validate(&json!({"action":"status","requestId":id})).is_err());
        assert!(validate(&json!({"action":"cleanup","requestId":id})).is_err());
        let request = json!({"action":"cleanup","requestId":id,"previewId":id});
        assert_eq!(validate(&request).unwrap(), "cleanup");
        let plan =
            json!({"removed":["z","a"],"artifacts":{"removedImages":["c"],"removedReleases":[]}});
        assert_eq!(
            plan_hash(&plan),
            format!("{:x}", Sha256::digest(br#"[["a","z"],["c"],[]]"#))
        );
        let status = json!({"enabled":true,"backupRetention":{"keep":3,"maxAgeDays":30},
            "artifactRetention":{"keep":4,"maxAgeDays":60}});
        assert_eq!(
            revision(&status),
            format!(
                "{:x}",
                Sha256::digest(br#"[true,{"keep":3,"maxAgeDays":30},{"keep":4,"maxAgeDays":60}]"#)
            )
        );
    }
}
