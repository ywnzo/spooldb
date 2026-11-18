use crate::{Result, init_cli, private_files, project_paths, release_download};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, IsTerminal},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub fn run(
    state: &Path,
    action: &str,
    target: Option<&str>,
    mode: Option<&str>,
    yes: bool,
) -> Result<Value> {
    let home = std::env::home_dir().ok_or("Could not locate the home directory")?;
    let path = |name: &str, suffix: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(suffix))
    };
    let data = path("XDG_DATA_HOME", ".local/share");
    let receipt = data.join("spool/installation.json");
    let target = target.unwrap_or(if receipt.try_exists()? {
        "client"
    } else {
        "plugin"
    });
    if !matches!(target, "client" | "plugin") {
        return Err("Choose --target client or plugin".into());
    }
    let mut settings =
        project_paths::optional_json::<Value>(&state.join(format!("updates-{target}.json")))?
            .unwrap_or_else(|| json!({"mode":"off","lastCheck":null}));
    if !settings.is_object() {
        return Err("Invalid updater settings".into());
    }
    settings["target"] = json!(target);
    settings["state"] = json!(state);
    settings["paths"] = json!({"data":data,"config":path("XDG_CONFIG_HOME",".config"),
        "state":path("XDG_STATE_HOME",".local/state"),"bin":path("SPOOL_BIN_HOME",".local/bin")});
    if action == "status" {
        return Ok(settings);
    }
    if matches!(action, "enable" | "disable") {
        let mode = if action == "disable" {
            "off"
        } else {
            mode.unwrap_or("automatic")
        };
        if !matches!(mode, "off" | "check" | "automatic") {
            return Err("Choose --mode check or automatic".into());
        }
        if mode != "off" && !yes {
            if !io::stdin().is_terminal() {
                return Err("Use --yes to opt in to scheduled updates".into());
            }
            if !init_cli::confirm(&format!("Enable daily {mode} updates for {target}?"))? {
                return Ok(json!({"cancelled":true}));
            }
        }
        let config = state.join(format!("updates-{target}.json"));
        return configure(&config, settings, &home, mode);
    }
    if !matches!(action, "" | "check") {
        return Err("Use spool update [check|status|enable|disable]".into());
    }
    let _lock = if action == "check" {
        None
    } else {
        crate::workspace_client::ensure_state(state)?;
        let config = state.join(format!("updates-{target}.json"));
        Some(lock(&config)?.ok_or("Another update is running")?)
    };
    execute(&settings, action == "check", yes, false)
}

fn execute(settings: &Value, check_only: bool, yes: bool, scheduled: bool) -> Result<Value> {
    let target = settings["target"]
        .as_str()
        .ok_or("Missing updater target")?;
    let receipt = Path::new(
        settings["paths"]["data"]
            .as_str()
            .ok_or("Missing updater data path")?,
    )
    .join("spool/installation.json");
    let installed = if target == "client" {
        project_paths::optional_json::<Value>(&receipt)?
            .ok_or("Client updates require an installer-managed SpoolDB installation")?
    } else {
        let list = codex(settings, &["plugin", "list", "--json"])?;
        let plugin = list["installed"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|plugin| plugin["pluginId"] == "spooldb@spooldb")
            .ok_or("SpoolDB is not installed from its Codex marketplace")?;
        if scheduled && !check_only && plugin["enabled"] == false {
            return Ok(json!({"skipped":"the plugin is disabled in Codex"}));
        }
        if plugin["marketplaceSource"]["sourceType"] == "local" {
            return Err("Install SpoolDB from ywnzo/spooldb in Codex before updating".into());
        }
        plugin.clone()
    };
    let current = installed["version"]
        .as_str()
        .ok_or("Missing installed version")?;
    let mut checked = release_download::check(current)?;
    if check_only {
        return Ok(checked);
    }
    if checked["available"] != true {
        checked["updated"] = json!(false);
        return Ok(checked);
    }
    let latest = checked["latest"]
        .as_str()
        .ok_or("Missing available version")?;
    if !yes {
        if !io::stdin().is_terminal() {
            return Err(format!(
                "Update available: {latest}. Run spool update --yes to install it."
            )
            .into());
        }
        if !init_cli::confirm(&format!("Update {target} from {current} to {latest}?"))? {
            return Ok(json!({"updated":false,"cancelled":true}));
        }
    }
    if target == "client" {
        apply_client(&checked["release"], settings)?;
        checked["message"] =
            json!("Client updated. Project memory and connections were preserved.");
    } else {
        apply_plugin(latest, settings)?;
        checked["restartRequired"] = json!(true);
        checked["hookReviewRequired"] = json!(true);
        checked["message"] = json!(
            "Plugin updated through Codex. Start a new chat and review any changed hooks in Codex."
        );
    }
    checked["updated"] = json!(true);
    Ok(checked)
}

pub fn scheduled(config: &Path) -> Result<Value> {
    use chrono::{DateTime, SecondsFormat, Utc};
    use std::time::SystemTime;
    if !config.try_exists()? {
        return Ok(json!({"skipped":"disabled"}));
    }
    let Some(_lock) = lock(config)? else {
        return Ok(json!({"skipped":"another update is running"}));
    };
    let Some(mut settings) = project_paths::optional_json::<Value>(config)? else {
        return Ok(json!({"skipped":"disabled"}));
    };
    let automatic = match settings["mode"].as_str() {
        Some("automatic") => true,
        Some("check") => false,
        Some("off") => return Ok(json!({"skipped":"disabled"})),
        _ => return Err("Invalid scheduled update mode".into()),
    };
    let now = DateTime::<Utc>::from(SystemTime::now());
    let recently_checked = settings["lastCheck"]
        .as_str()
        .and_then(|last| DateTime::parse_from_rfc3339(last).ok())
        .is_some_and(|last| now.signed_duration_since(last) < chrono::Duration::days(1));
    if recently_checked {
        return Ok(json!({"skipped":"checked recently"}));
    }
    if settings["target"] == "plugin" {
        let state = Path::new(
            settings["state"]
                .as_str()
                .ok_or("Missing updater state path")?,
        );
        if active_leases(&state.join("plugin-leases"))? {
            return Ok(json!({"skipped":"an agent session is active"}));
        }
    }
    let stamp = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let result = execute(&settings, !automatic, true, true);
    match &result {
        Ok(update) if update["skipped"].is_null() => {
            settings["lastCheck"] = json!(stamp);
            settings["lastResult"] = update.clone();
            settings["error"] = Value::Null;
        }
        Err(error) => {
            settings["lastAttempt"] = json!(stamp);
            settings["error"] = json!(error.to_string());
        }
        _ => return result,
    }
    private_files::save_atomic(config, &settings)?;
    result
}

fn active_leases(directory: &Path) -> Result<bool> {
    let leases = match fs::read_dir(directory) {
        Ok(leases) => leases,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    for entry in leases {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && let Ok(Some(lease)) = project_paths::optional_json::<Value>(&entry.path())
            && running(&lease["pid"])
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn running(value: &Value) -> bool {
    value
        .as_u64()
        .and_then(|pid| i32::try_from(pid).ok())
        .filter(|pid| *pid > 1)
        .and_then(rustix::process::Pid::from_raw)
        .is_some_and(|pid| {
            matches!(
                rustix::process::test_kill_process(pid),
                Ok(()) | Err(rustix::io::Errno::PERM)
            )
        })
}

struct UpdateLock(PathBuf);
impl Drop for UpdateLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.0.join("owner.json"));
        let _ = fs::remove_dir(&self.0);
    }
}

fn lock(config: &Path) -> Result<Option<UpdateLock>> {
    let mut path = config.as_os_str().to_os_string();
    path.push(".lock");
    let path = PathBuf::from(path);
    match private_files::private_dir(&path) {
        Ok(()) => {}
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|io| io.kind() == io::ErrorKind::AlreadyExists) =>
        {
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.is_dir()
                || metadata
                    .modified()?
                    .elapsed()
                    .is_ok_and(|age| age.as_secs() < 21_600)
            {
                return Ok(None);
            }
            let owner = path.join("owner.json");
            if project_paths::optional_json::<Value>(&owner)?
                .is_some_and(|owner| running(&owner["pid"]))
            {
                return Ok(None);
            }
            if owner.try_exists()? {
                fs::remove_file(&owner)?;
            }
            fs::remove_dir(&path)?;
            match private_files::private_dir(&path) {
                Ok(()) => {}
                Err(error)
                    if error
                        .downcast_ref::<io::Error>()
                        .is_some_and(|io| io.kind() == io::ErrorKind::AlreadyExists) =>
                {
                    return Ok(None);
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    }
    let lock = UpdateLock(path);
    private_files::save(
        &lock.0.join("owner.json"),
        &json!({"pid":std::process::id()}),
    )?;
    Ok(Some(lock))
}

fn codex_command(settings: &Value) -> Command {
    let fallback = [
        "/Applications/Codex.app/Contents/Resources/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
    ];
    let program = settings["codex"]
        .as_str()
        .or_else(|| fallback.into_iter().find(|path| Path::new(path).is_file()))
        .unwrap_or("codex");
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    if let Some(home) = settings["codexHome"].as_str() {
        command.env("CODEX_HOME", home);
    }
    command
}

fn codex(settings: &Value, args: &[&str]) -> Result<Value> {
    let output = codex_command(settings).args(args).output()?;
    if !output.status.success() {
        return Err(format!("Codex plugin command exited with {}", output.status).into());
    }
    if output.stdout.is_empty() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_slice(&output.stdout)?)
    }
}

fn apply_plugin(latest: &str, settings: &Value) -> Result<()> {
    // The marketplace upgrade can print ordinary text even though add/list return JSON.
    let status = codex_command(settings)
        .args(["plugin", "marketplace", "upgrade", "spooldb"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()?;
    if !status.success() {
        return Err("Could not upgrade the SpoolDB Codex marketplace".into());
    }
    let installed = codex(settings, &["plugin", "add", "spooldb@spooldb", "--json"])?;
    if installed["version"] != latest {
        return Err("The marketplace is not ready for this release. Retry later.".into());
    }
    if let Some(root) = installed["installedPath"].as_str() {
        let bootstrap = Path::new(root).join("scripts/bootstrap.sh");
        if bootstrap.is_file()
            && !Command::new("sh")
                .arg(bootstrap)
                .arg(root)
                .status()?
                .success()
        {
            return Err("SpoolDB plugin bootstrap failed".into());
        }
        refresh_native(&Path::new(root).join("app"), settings)?;
    }
    Ok(())
}

fn refresh_native(app: &Path, settings: &Value) -> Result<()> {
    let data = Path::new(
        settings["paths"]["data"]
            .as_str()
            .ok_or("Missing updater data path")?,
    );
    let directory = data.join("spool/updater");
    let suffix = if cfg!(target_os = "macos") {
        "darwin-arm64"
    } else {
        "linux-x64"
    };
    let source = app.join(format!("runtime/spool-native-{suffix}"));
    if !directory.is_dir() || !source.is_file() {
        return Ok(());
    }
    copy_updater(&source, &directory)
}

fn copy_updater(source: &Path, directory: &Path) -> Result<()> {
    let temporary = directory.join(format!(".spool-native-{}.tmp", private_files::random_id()?));
    let result = fs::copy(source, &temporary)
        .and_then(|_| fs::rename(&temporary, directory.join("spool-native")));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result?;
    Ok(())
}

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn apply_client(release: &Value, settings: &Value) -> Result<()> {
    if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        return Err(
            "The standalone updater supports Linux x86-64. Use the Codex plugin on Apple Silicon."
                .into(),
        );
    }
    let staging =
        std::env::temp_dir().join(format!("spool-update-{}", private_files::random_id()?));
    private_files::private_dir(&staging)?;
    let staging = Staging(staging);
    let installer = staging.0.join("spool-linux-x64.run");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&installer)?;
    release_download::installer(release, &mut file)?;
    file.sync_all()?;
    drop(file);
    let mut command = Command::new("sh");
    command.arg(installer).arg("--update").stdin(Stdio::null());
    for (variable, key) in [
        ("XDG_DATA_HOME", "data"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_STATE_HOME", "state"),
        ("SPOOL_BIN_HOME", "bin"),
    ] {
        command.env(
            variable,
            settings["paths"][key]
                .as_str()
                .ok_or("Incomplete installation paths")?,
        );
    }
    if !command.status()?.success() {
        return Err("SpoolDB installer failed".into());
    }
    let data = Path::new(
        settings["paths"]["data"]
            .as_str()
            .ok_or("Missing updater data path")?,
    );
    refresh_native(&data.join("spool/app"), settings)?;
    Ok(())
}

const SCHEDULER_MARKER: &str = "# Managed by SpoolDB updater";

fn configure(config: &Path, mut settings: Value, home: &Path, mode: &str) -> Result<Value> {
    use chrono::{DateTime, SecondsFormat, Utc};
    let target = settings["target"]
        .as_str()
        .ok_or("Missing updater target")?
        .to_owned();
    let paths = &settings["paths"];
    let data = PathBuf::from(paths["data"].as_str().ok_or("Missing updater data path")?);
    let systemd = Path::new(
        paths["config"]
            .as_str()
            .ok_or("Missing updater configuration path")?,
    )
    .join("systemd/user");
    let timer_name = format!("spool-update-{target}.timer");
    let unit = systemd.join(format!("spool-update-{target}.service"));
    let timer = systemd.join(&timer_name);
    let label = format!("dev.spooldb.update.{target}");
    let agent = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let linux = cfg!(target_os = "linux");
    if !linux && !cfg!(target_os = "macos") {
        return Err("Scheduled updates support Linux and macOS".into());
    }
    let files = if linux {
        vec![&unit, &timer]
    } else {
        vec![&agent]
    };
    for file in &files {
        match fs::symlink_metadata(file) {
            Ok(metadata)
                if metadata.is_file()
                    && metadata.len() < 16384
                    && fs::read_to_string(file)?.contains(SCHEDULER_MARKER) => {}
            Ok(_) => {
                return Err(
                    format!("An unmanaged update scheduler exists at {}", file.display()).into(),
                );
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    if mode != "off" && target == "client" && !data.join("spool/installation.json").is_file() {
        return Err("Client updates require an installer-managed SpoolDB installation".into());
    }
    crate::workspace_client::ensure_state(
        config.parent().ok_or("Missing updater state directory")?,
    )?;
    let _lock = lock(config)?.ok_or("Another update is running")?;
    let domain = format!("gui/{}", rustix::process::getuid().as_raw());
    let agent_path = agent.to_str().ok_or("Invalid launch-agent path")?;
    settings["mode"] = json!(mode);
    let configured_at = DateTime::<Utc>::from(std::time::SystemTime::now());
    settings["configuredAt"] = json!(configured_at.to_rfc3339_opts(SecondsFormat::Millis, true));
    settings["codexHome"] = json!(
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
    );
    if mode == "off" {
        private_files::save_atomic(config, &settings)?;
        if linux {
            let _ = scheduler_command("systemctl", &["--user", "disable", "--now", &timer_name]);
        } else {
            let _ = scheduler_command("launchctl", &["bootout", &domain, agent_path]);
        }
        for file in files {
            match fs::remove_file(file) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if linux {
            let _ = scheduler_command("systemctl", &["--user", "daemon-reload"]);
        }
        return Ok(settings);
    }

    if target == "plugin" && settings["codex"].is_null() {
        let executable = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
            .map(|directory| directory.join("codex"))
            .find(|path| path.is_absolute() && path.is_file())
            .or_else(|| {
                [
                    "/Applications/Codex.app/Contents/Resources/codex",
                    "/Applications/ChatGPT.app/Contents/Resources/codex",
                ]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())
            })
            .ok_or("Install the Codex CLI command before enabling plugin updates")?;
        settings["codex"] = json!(executable);
    }
    let directory = data.join("spool/updater");
    crate::workspace_client::ensure_state(&directory)?;
    copy_updater(&std::env::current_exe()?, &directory)?;
    let executable = directory.join("spool-native");
    let arguments = [
        executable
            .to_str()
            .ok_or("Invalid updater executable path")?,
        "update-scheduled",
        config.to_str().ok_or("Invalid updater settings path")?,
    ];

    if linux {
        fs::create_dir_all(&systemd)?;
        let escaped = arguments
            .map(|value| json!(value.replace('%', "%%").replace('$', "$$")).to_string())
            .join(" ");
        write_scheduler(
            &unit,
            &format!(
                "{SCHEDULER_MARKER}\n[Unit]\nDescription=SpoolDB update check\n[Service]\nType=oneshot\nTimeoutStartSec=10min\nUMask=0077\nExecStart={escaped}\n"
            ),
        )?;
        write_scheduler(
            &timer,
            &format!(
                "{SCHEDULER_MARKER}\n[Unit]\nDescription=SpoolDB automatic updates\n[Timer]\nOnBootSec=5m\nOnCalendar=hourly\nRandomizedDelaySec=5m\nPersistent=true\n[Install]\nWantedBy=timers.target\n"
            ),
        )?;
    } else {
        fs::create_dir_all(agent.parent().ok_or("Invalid launch agent path")?)?;
        let xml = arguments
            .map(|value| {
                let value = value
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;");
                format!("<string>{value}</string>")
            })
            .join("");
        write_scheduler(
            &agent,
            &format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><!-- {SCHEDULER_MARKER} --><key>Label</key><string>{label}</string><key>ProgramArguments</key><array>{xml}</array><key>StartInterval</key><integer>3600</integer><key>RunAtLoad</key><true/></dict></plist>\n"
            ),
        )?;
    }
    private_files::save_atomic(config, &settings)?;
    if linux {
        scheduler_command("systemctl", &["--user", "daemon-reload"])?;
        scheduler_command("systemctl", &["--user", "enable", "--now", &timer_name])?;
    } else {
        let _ = scheduler_command("launchctl", &["bootout", &domain, agent_path]);
        scheduler_command("launchctl", &["bootstrap", &domain, agent_path])?;
    }
    settings["message"] =
        json!("Updates are checked daily. Changed plugin hooks still require Codex review.");
    Ok(settings)
}

fn write_scheduler(path: &Path, text: &str) -> Result<()> {
    let staged = path.with_file_name(format!(
        ".spool-scheduler-{}.tmp",
        private_files::random_id()?
    ));
    let result = private_files::write_private(&staged, text.as_bytes())
        .and_then(|()| Ok(fs::rename(&staged, path)?));
    if result.is_err() {
        let _ = fs::remove_file(staged);
    }
    result
}

fn scheduler_command(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(format!("{program} could not configure SpoolDB updates: {status}").into());
    }
    Ok(())
}
