use crate::{Result, private_files, relay_artifacts, relay_retention, release_download};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::SystemTime,
};

const DEFAULT_CONFIG: &str = "/opt/spooldb/containers.json";
const CLI: &str = "/usr/local/bin/spool";

pub(crate) struct Installation {
    config: PathBuf,
    pub(crate) root: PathBuf,
    state: PathBuf,
    pub(crate) current: String,
}

impl Installation {
    pub(crate) fn open(config: &Path) -> Result<Self> {
        let config = std::path::absolute(config)?;
        let root = config
            .parent()
            .ok_or("Invalid installation directory")?
            .to_owned();
        let installed = relay_retention::regular_json(&config)?
            .ok_or("Managed relay configuration is missing")?;
        let app = PathBuf::from(
            installed["app"]
                .as_str()
                .ok_or("Missing installed release path")?,
        );
        if installed["managedBy"] != "SpoolDB"
            || !matches!(
                installed["engine"].as_str(),
                Some("/usr/bin/podman" | "/usr/bin/docker")
            )
            || app.parent() != Some(root.join("releases").as_path())
            || !relay_retention::metadata(&app)?.is_some_and(|metadata| metadata.is_dir())
        {
            return Err("Expected a managed SpoolDB container installation".into());
        }
        let package = relay_retention::regular_json(&app.join("package.json"))?
            .ok_or("Installed package receipt is missing")?;
        let current = package["version"]
            .as_str()
            .ok_or("Installed release version is missing")?
            .to_owned();
        release_download::version(&current)?;
        let state = root.join("relay-updates.json");
        Ok(Self {
            config,
            root,
            state,
            current,
        })
    }

    pub(crate) fn settings(&self) -> Result<Value> {
        let settings = relay_retention::regular_json(&self.state)?.unwrap_or_else(|| json!({}));
        if !settings.is_object() {
            return Err("Invalid relay update settings".into());
        }
        Ok(settings)
    }

    pub(crate) fn status(&self) -> Result<Value> {
        let mut status = self.settings()?;
        status["current"] = json!(self.current);
        status["config"] = json!(self.config);
        for category in ["backupRetention", "artifactRetention"] {
            let keep = retention_setting(&status[category], "keep", 3, 100)?;
            let age = retention_setting(&status[category], "maxAgeDays", 30, 3650)?;
            status[category] = json!({"keep":keep,"maxAgeDays":age});
        }
        Ok(status)
    }

    pub(crate) fn cleanup(&self, preview: bool) -> Result<Value> {
        let mut backups = relay_retention::maintain_backups(&self.config, preview)?;
        backups["artifacts"] =
            relay_artifacts::maintain(&self.config, Path::new(CLI), preview, &backups)?;
        Ok(backups)
    }

    pub(crate) fn configure(&self, automatic: bool, policy: Option<&Value>) -> Result<Value> {
        const MARKER: &str = "# Managed by SpoolDB relay updater";
        let units = Path::new("/etc/systemd/system");
        let service = units.join("spool-relay-update.service");
        let timer = units.join("spool-relay-update.timer");
        for unit in [&service, &timer] {
            if let Some(meta) = relay_retention::metadata(unit)?
                && (!meta.is_file()
                    || meta.len() > 32_768
                    || !fs::read_to_string(unit)?.contains(MARKER))
            {
                return Err(
                    format!("An unmanaged updater unit exists at {}", unit.display()).into(),
                );
            }
        }
        let before = self.settings()?;
        let mut settings = before.clone();
        settings["enabled"] = json!(automatic);
        if let Some(policy) = policy {
            for key in ["backupRetention", "artifactRetention"] {
                settings[key] = policy[key].clone();
            }
        }
        let set_timer = |enabled| -> Result<()> {
            for args in [
                vec!["daemon-reload"],
                vec![
                    if enabled { "enable" } else { "disable" },
                    "--now",
                    "spool-relay-update.timer",
                ],
            ] {
                let status = Command::new("systemctl")
                    .args(args)
                    .stdin(Stdio::null())
                    .status()?;
                if !status.success() {
                    return Err("Could not configure the SpoolDB relay update timer".into());
                }
            }
            Ok(())
        };
        let service_text = format!(
            "{MARKER}\n[Unit]\nDescription=Check and safely update SpoolDB relay\nAfter=network-online.target spool-shared.service\nWants=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/spool update --target relay --yes\nUMask=0077\nTimeoutStartSec=1800\n"
        );
        let timer_text = format!(
            "{MARKER}\n[Unit]\nDescription=Daily SpoolDB relay update check\n[Timer]\nOnCalendar=*-*-* 04:00:00\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n"
        );
        fs::write(service, service_text)?;
        fs::write(timer, timer_text)?;
        private_files::save_atomic(&self.state, &settings)?;
        if let Err(error) = set_timer(automatic) {
            private_files::save_atomic(&self.state, &before)?;
            let _ = set_timer(before["enabled"] == true);
            return Err(error);
        }
        self.status()
    }

    pub(crate) fn update(&self) -> Result<Value> {
        let cleanup = self
            .cleanup(false)
            .unwrap_or_else(|error| json!({"errors":[{"error":error.to_string()}]}));
        let mut next = None::<String>;
        let result = (|| -> Result<Value> {
            let mut checked = release_download::check(&self.current)?;
            if checked["available"] != true {
                checked["backupCleanup"] = cleanup;
                return Ok(checked);
            }
            let latest = checked["latest"]
                .as_str()
                .ok_or("Missing release version")?;
            next = Some(latest.to_owned());
            if self.settings()?["failedVersion"] == latest {
                return Err("This release previously failed validation. Inspect relay-updates.json before retrying.".into());
            }
            let temporary = std::env::temp_dir().join(format!(
                "spool-relay-update-{}",
                private_files::random_id()?
            ));
            private_files::private_dir(&temporary)?;
            let staged = Staged(temporary);
            let installer = staged.0.join("update.run");
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&installer)?;
            release_download::installer(&checked["release"], &mut file)?;
            file.sync_all()?;
            drop(file);
            let status = Command::new("/bin/sh")
                .arg(installer)
                .arg("--relay-update")
                .arg(&self.config)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .status()?;
            if !status.success() {
                return Err(format!("Relay installer failed: {status}").into());
            }
            let installed = Self::open(&self.config)?;
            if installed.current != latest {
                return Err("Relay installer did not publish the expected release".into());
            }
            checked["updated"] = json!(true);
            Ok(checked)
        })();
        if result
            .as_ref()
            .is_ok_and(|checked| checked["updated"] != true)
        {
            return result;
        }
        let mut settings = self.settings()?;
        let now = DateTime::<Utc>::from(SystemTime::now());
        settings["lastCheck"] = json!(now.to_rfc3339_opts(SecondsFormat::Millis, true));
        match &result {
            Ok(checked) => {
                settings["updatedTo"] = checked["latest"].clone();
                settings["failedVersion"] = Value::Null;
                settings["error"] = Value::Null;
            }
            Err(error) => {
                settings["failedVersion"] = json!(next);
                settings["error"] = json!(error.to_string());
            }
        }
        private_files::save_atomic(&self.state, &settings)?;
        result
    }

    pub(crate) fn lock_path(&self) -> PathBuf {
        let mut path = OsString::from(self.root.as_os_str());
        path.push(".operation.lock");
        PathBuf::from(path)
    }

    pub(crate) fn recover(&self) -> Result<Value> {
        let guard = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.root.join("relay-recovery.lock"))?;
        guard
            .try_lock()
            .map_err(|_| "Another relay recovery is running")?;
        let journal = self.root.join("relay-update-journal.json");
        let path = self.lock_path();
        if !journal.try_exists()? {
            if relay_retention::metadata(&path)?.is_some_and(|entry| entry.is_dir())
                && fs::read_to_string(path.join("pid"))
                    .ok()
                    .and_then(|pid| pid.trim().parse::<u32>().ok())
                    .is_some_and(|pid| pid > 1)
            {
                crate::relay_recovery::allow_recovery(&path)?;
                let _lock = OperationLock(path);
                return Ok(json!({"recovered":true,"abandonedOperationCleared":true}));
            }
            return Err("No interrupted relay transaction was found".into());
        }
        if let Some(metadata) = relay_retention::metadata(&path)? {
            if !metadata.is_dir() {
                return Err("Relay update lock is not a directory".into());
            }
            crate::relay_recovery::allow_recovery(&path)?;
            match fs::remove_file(path.join("pid")) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        } else {
            private_files::private_dir(&path)?;
        }
        let lock = OperationLock(path);
        let mut owner = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(lock.0.join("pid"))?;
        writeln!(owner, "{}", std::process::id())?;
        owner.sync_all()?;
        let mut result = crate::relay_recovery::recover(&self.config, Path::new(CLI))?;
        fs::remove_file(journal)?;
        result["backupCleanup"] = self.cleanup(false)?;
        Ok(result)
    }

    pub(crate) fn lock(&self) -> Result<OperationLock> {
        if self.root.join("relay-update-journal.json").try_exists()? {
            return Err("Interrupted update: run sudo spool update recover".into());
        }
        let path = self.lock_path();
        match private_files::private_dir(&path) {
            Ok(()) => {}
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == ErrorKind::AlreadyExists) =>
            {
                return Err("Another relay operation is running or needs recovery".into());
            }
            Err(error) => return Err(error),
        }
        let lock = OperationLock(path);
        let mut owner = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(lock.0.join("pid"))?;
        writeln!(owner, "{}", std::process::id())?;
        owner.sync_all()?;
        Ok(lock)
    }
}

fn retention_setting(settings: &Value, name: &str, default: u64, max: u64) -> Result<u64> {
    settings
        .get(name)
        .map_or(Some(default), Value::as_u64)
        .filter(|value| (1..=max).contains(value))
        .ok_or_else(|| "Relay retention requires keep=1–100 and maxAgeDays=1–3650".into())
}

pub(crate) struct OperationLock(PathBuf);
impl Drop for OperationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.0.join("pid"));
        let _ = fs::remove_dir(&self.0);
    }
}

struct Staged(PathBuf);
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn cli(action: &str, yes: bool, dry_run: bool) -> Result<Value> {
    let config = std::env::var_os("SPOOL_CONTAINER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG));
    let installed = Installation::open(&config)?;
    match action {
        "status" => return installed.status(),
        "check" => return release_download::check(&installed.current),
        "" | "cleanup" | "recover" | "enable" | "disable" => {}
        _ => return Err("Use spool update [status|check|cleanup|recover] --target relay".into()),
    }
    if !rustix::process::getuid().is_root() {
        return Err("Use sudo to manage the relay".into());
    }
    if action == "enable"
        && !yes
        && (!std::io::IsTerminal::is_terminal(&std::io::stdin())
            || !crate::init_cli::confirm(
                "Enable daily relay updates with health checks and rollback?",
            )?)
    {
        return Err("Use --yes to opt in to scheduled relay updates".into());
    }
    if action.is_empty() && !yes {
        return Err("Run sudo spool update --yes to update the relay now".into());
    }
    if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        return Err("Managed relay updates require Linux x86-64".into());
    }
    if action == "recover" {
        return installed.recover();
    }
    let _lock = installed.lock()?;
    let installed = Installation::open(&config)?;
    if matches!(action, "enable" | "disable") {
        installed.configure(action == "enable", None)
    } else if action == "cleanup" {
        installed.cleanup(dry_run)
    } else {
        installed.update()
    }
}
