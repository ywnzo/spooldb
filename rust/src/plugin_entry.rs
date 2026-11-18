use crate::{Result, mcp, private_files, project_binding, workspace_client};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::SocketAddr,
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn small_file(path: &Path, limit: usize) -> Result<Vec<u8>> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err("Expected a regular packaged file".into());
    }
    let file = fs::File::open(path)?;
    let mut out = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut out)?;
    if out.len() > limit {
        return Err("Packaged file exceeds size limit".into());
    }
    Ok(out)
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn install_hooks(plugin: &Path) -> Result<()> {
    const RUNTIME: &str = "app/runtime/spool-hook-linux-x64";
    const PROTOCOL: &str = "spool-hooks/1";
    const FILES: [&str; 2] = ["app/runtime/spool-hook-darwin-arm64", RUNTIME];
    let hooks = plugin.join("hooks");
    let descriptor: Value =
        serde_json::from_slice(&small_file(&hooks.join("runtime-profile.json"), 16_384)?)?;
    let portable = hooks.join("native-dispatch");
    let dispatcher = String::from_utf8(small_file(&portable.join("run.sh"), 16_384)?)?;
    let manifest = String::from_utf8(small_file(&portable.join("files.sha256"), 16_384)?)?;
    let mut actual = String::new();
    for file in FILES {
        let path = plugin.join(file);
        if fs::canonicalize(&path)?.strip_prefix(plugin).ok() != Some(Path::new(file)) {
            return Err("SpoolDB hook binaries may not be redirected through symlinks".into());
        }
        actual.push_str(&format!(
            "{}  {file}\n",
            sha(&small_file(&path, 32_000_000)?)
        ));
    }
    #[derive(Serialize)]
    struct Fingerprint<'a> {
        protocol: &'a str,
        dispatcher: &'a str,
        runtime: &'a str,
        manifest: &'a str,
    }
    let fingerprint = sha(&serde_json::to_vec(&Fingerprint {
        protocol: PROTOCOL,
        dispatcher: &dispatcher,
        runtime: RUNTIME,
        manifest: &manifest,
    })?);
    if descriptor["protocol"] != PROTOCOL
        || descriptor["runtime"] != RUNTIME
        || descriptor["fingerprint"] != fingerprint
        || manifest != actual
    {
        return Err("SpoolDB hooks do not match their packaged profile".into());
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|home| home.join(".local/share")))
        .ok_or("Cannot locate Codex hook data")?;
    let parent = base.join("spool/codex-hooks");
    workspace_client::ensure_state(&parent)?;
    let target = parent.join(&fingerprint);
    let runtime = format!("{RUNTIME}\n");
    let files = [
        ("run.sh", dispatcher.as_bytes(), 0o700),
        ("files.sha256", manifest.as_bytes(), 0o600),
        ("runtime", runtime.as_bytes(), 0o600),
    ];
    let validate = || -> Result<()> {
        if !fs::symlink_metadata(&target)?.is_dir() {
            return Err("SpoolDB hook profile must be a directory".into());
        }
        for (name, expected, _) in files {
            if small_file(&target.join(name), 16_384)? != expected {
                return Err("Installed SpoolDB hooks were modified".into());
            }
        }
        Ok(())
    };
    if target.try_exists()? {
        return validate();
    }
    let staging = parent.join(format!(".hooks-{}.tmp", private_files::random_id()?));
    private_files::private_dir(&staging)?;
    let result = (|| -> Result<()> {
        for (name, content, mode) in files {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(mode)
                .open(staging.join(name))?;
            file.write_all(content)?;
            file.sync_all()?;
        }
        match fs::rename(&staging, &target) {
            Ok(()) => Ok(()),
            Err(_) if target.try_exists()? => validate(),
            Err(error) => Err(error.into()),
        }
    })();
    if staging.is_dir() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

pub(crate) fn live_origin(state: &Path) -> Option<String> {
    let receipt =
        crate::project_paths::optional_json::<Value>(&state.join("service.json")).ok()??;
    let origin = receipt["origin"].as_str()?;
    healthy_origin(origin).then(|| origin.to_owned())
}

pub(crate) fn healthy_origin(origin: &str) -> bool {
    let address = origin
        .strip_prefix("http://")
        .and_then(|host| host.parse::<SocketAddr>().ok());
    if !address.is_some_and(|address| address.ip().is_loopback()) {
        return false;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_millis(700)))
        .build()
        .into();
    agent
        .get(&format!("{origin}/healthz"))
        .call()
        .ok()
        .and_then(|mut response| {
            let mut body = Vec::new();
            response
                .body_mut()
                .with_config()
                .limit(16_384)
                .reader()
                .read_to_end(&mut body)
                .ok()?;
            serde_json::from_slice::<Value>(&body).ok()
        })
        .is_some_and(|data| data["ok"] == true && data["protocol"] == "spool-relay/1")
}

pub(crate) fn start_companion(state: &Path) -> Result<()> {
    workspace_client::ensure_state(state)?;
    if live_origin(state).is_some() {
        return Ok(());
    }
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(state.join("plugin-companion.log"))?;
    let mut child = Command::new(std::env::current_exe()?)
        .args(["companion", "start"])
        .env("SPOOL_STATE", state)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .process_group(0)
        .spawn()?;
    let wait = Instant::now() + Duration::from_secs(20);
    while Instant::now() < wait {
        if live_origin(state).is_some() {
            return Ok(());
        }
        let _ = child.try_wait()?;
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("SpoolDB companion did not start. See plugin-companion.log in its state directory.".into())
}

fn refresh_updater(state: &Path, app: &Path) -> Result<()> {
    for target in ["plugin", "client"] {
        let settings = crate::project_paths::optional_json::<Value>(
            &state.join(format!("updates-{target}.json")),
        )?;
        let Some(settings) = settings else {
            continue;
        };
        if !matches!(settings["mode"].as_str(), Some("check" | "automatic")) {
            continue;
        }
        let data = settings["paths"]["data"]
            .as_str()
            .ok_or("Missing updater data path")?;
        let base = Path::new(data).join("spool/updater");
        workspace_client::ensure_state(&base)?;
        let runtime = if cfg!(target_os = "macos") {
            "bun-darwin-arm64"
        } else {
            "bun"
        };
        let native = std::env::current_exe()?;
        for (source, name) in [
            (native, "spool-native"),
            (app.join("src/update.js"), "update.js"),
            (app.join("runtime").join(runtime), "bun"),
        ] {
            if !source.is_file() {
                continue;
            }
            let dest = base.join(name);
            let temp = base.join(format!(".update-{}.tmp", private_files::random_id()?));
            let copied = fs::copy(source, &temp).and_then(|_| fs::rename(&temp, &dest));
            if copied.is_err() {
                let _ = fs::remove_file(temp);
            }
            copied?;
        }
    }
    Ok(())
}

pub fn run(plugin: &Path) -> Result<()> {
    let plugin = fs::canonicalize(plugin)?;
    install_hooks(&plugin)?;
    let state = project_binding::state_root()?;
    if let Err(error) = refresh_updater(&state, &plugin.join("app")) {
        eprintln!("SpoolDB updater refresh failed: {error}");
    }
    start_companion(&state)?;
    mcp::serve_projects(Some(&plugin))
}
