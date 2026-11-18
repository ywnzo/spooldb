use crate::{Result, desktop_launch, init_cli, private_files, relay_apply, workspace_client};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    io::{self, ErrorKind, IsTerminal},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::SystemTime,
};

const INSTALLER: &str = "# Managed by SpoolDB desktop installer";
const CLI: &str = "# Managed by SpoolDB CLI installer";

struct Paths {
    data: PathBuf,
    config: PathBuf,
    state: PathBuf,
    bin: PathBuf,
}
impl Paths {
    fn user() -> Result<Self> {
        let home = std::env::home_dir().ok_or("Could not locate home directory")?;
        let resolve = |env: &str, fallback: &str| {
            std::path::absolute(
                std::env::var_os(env)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(fallback)),
            )
        };
        Ok(Self {
            data: resolve("XDG_DATA_HOME", ".local/share")?,
            config: resolve("XDG_CONFIG_HOME", ".config")?,
            state: resolve("XDG_STATE_HOME", ".local/state")?,
            bin: resolve("SPOOL_BIN_HOME", ".local/bin")?,
        })
    }
}

fn shell(path: &Path) -> Result<String> {
    let value = path.to_str().ok_or("Invalid installation path")?;
    if value.chars().any(char::is_control) {
        return Err("Unsupported control character in installation path".into());
    }
    Ok(format!("'{}'", value.replace('\'', "'\"'\"'")))
}

fn desktop(path: &Path) -> Result<String> {
    let value = path.to_str().ok_or("Invalid desktop launch path")?;
    if value.chars().any(char::is_control) {
        return Err("Unsupported control character in installation path".into());
    }
    Ok(format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\\\\\")
            .replace('"', "\\\\\"")
            .replace('`', "\\\\`")
            .replace('$', "\\\\$")
            .replace('%', "%%")
    ))
}

fn command(app: &Path, state: &Path) -> Result<String> {
    let native = shell(&app.join("runtime/spool-native-linux-x64"))?;
    let state = shell(state)?;
    Ok(format!(
        r#"#!/bin/sh
{CLI}
export SPOOL_STATE={state}
case "${{1:-}}" in
plugin) ;;
server) ;;
--sharded) [ "$#" -eq 1 ] && exec {native} storage spool.sqlite --sharded ;;
''|--help|help) exec {native} help ;;
open|init|memory|storage|status|discovery|service|workspace|project|update|deploy|--version) ;;
-*) ;;
*) database=$1
   shift
   for argument do
     case "$argument" in --legacy|--sharded) exec {native} storage "$database" "$@" ;; esac
   done
   exec {native} storage "$database" "$@" --legacy ;;
esac
exec {native} "$@"
"#
    ))
}

fn atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let directory = path.parent().ok_or("Invalid installation file")?;
    fs::create_dir_all(directory)?;
    let staged = path.with_file_name(format!(".spool-install-{}", private_files::random_id()?));
    let result = private_files::write_private(&staged, bytes).and_then(|()| {
        fs::set_permissions(&staged, fs::Permissions::from_mode(mode))?;
        fs::rename(&staged, path)?;
        Ok(())
    });
    if result.is_err() {
        let _ = fs::remove_file(staged);
    }
    result
}

struct Previous {
    path: PathBuf,
    content: Option<(Vec<u8>, u32)>,
}
impl Previous {
    fn read(path: PathBuf, marker: Option<&str>) -> Result<Self> {
        let content = match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() < 4_000_000 => {
                let bytes = fs::read(&path)?;
                if let Some(marker) = marker
                    && !String::from_utf8_lossy(&bytes).contains(marker)
                {
                    return Err(format!(
                        "An independently managed file exists at {}",
                        path.display()
                    )
                    .into());
                }
                Some((bytes, meta.permissions().mode() & 0o777))
            }
            Ok(_) => {
                return Err(
                    format!("Invalid existing installation file at {}", path.display()).into(),
                );
            }
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(Self { path, content })
    }
    fn restore(&self) -> Result<()> {
        if let Some((bytes, mode)) = &self.content {
            atomic(&self.path, bytes, *mode)
        } else {
            match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            }
        }
    }
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn exec(program: &str, args: &[&str]) -> Result<()> {
    let result = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !result.success() {
        return Err(format!("{program} exited with {result}").into());
    }
    Ok(())
}

fn base_manifest(bundle: &Path) -> Result<Value> {
    relay_apply::verify_manifest(
        bundle,
        &[
            "runtime/spool-native-linux-x64",
            "package.json",
            "src/desktop/icon.svg",
        ],
    )
}

fn install(bundle: &Path, paths: &Paths, activate: bool, strict: bool) -> Result<Value> {
    let manifest = base_manifest(bundle)?;
    let base = paths.data.join("spool");
    let app = base.join("app");
    let state = paths.state.join("spool");
    let cli = paths.bin.join("spool");
    let unit = paths.config.join("systemd/user/spool.service");
    let entry = paths.data.join("applications/spool.desktop");
    let fallback = paths.config.join("autostart/spool.desktop");
    let receipt = base.join("installation.json");
    workspace_client::ensure_state(&base)?;
    let lock = base.join("install.lock");
    let _lock_file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&lock)
        .map_err(|error| {
            if error.kind() == ErrorKind::AlreadyExists {
                io::Error::new(error.kind(), "Another SpoolDB installer is running")
            } else {
                error
            }
        })?;
    let _lock = Lock(lock);
    let existing = [
        Previous::read(unit.clone(), Some(INSTALLER))?,
        Previous::read(cli.clone(), Some(CLI))?,
        Previous::read(entry.clone(), Some("Name=SpoolDB\n"))?,
        Previous::read(fallback.clone(), Some("Name=SpoolDB background capture\n"))?,
        Previous::read(receipt.clone(), None)?,
    ];
    let update = match fs::symlink_metadata(&app) {
        Ok(meta) if meta.is_dir() && existing[4].content.is_some() => true,
        Ok(_) => return Err("The installation folder contains an unmanaged application".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    let binary = app.join("runtime/spool-native-linux-x64");
    let runtime_path = app.join("runtime");
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
    let systemd = |value: &str| json!(value.replace('%', "%%").replace('$', "$$")).to_string();
    let unit_text = format!(
        "{INSTALLER}\n[Unit]\nDescription=SpoolDB project memory and capture\nStartLimitIntervalSec=60\nStartLimitBurst=5\n[Service]\nType=simple\nExecStart={} companion start\nEnvironment={}\nEnvironment={}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=45\nUMask=0077\n[Install]\nWantedBy=default.target\n",
        systemd(&binary.to_string_lossy()),
        systemd(&format!("SPOOL_STATE={}", state.display())),
        systemd(&format!("PATH={}:{path}", runtime_path.display()))
    );
    let launcher = format!(
        "[Desktop Entry]\nType=Application\nName=SpoolDB\nComment=Shared project memory for coding agents\nExec={} open --state {} %u\nIcon={}\nTerminal=false\nCategories=Development;\nMimeType=x-scheme-handler/spool;\nStartupNotify=false\n",
        desktop(&binary)?,
        desktop(&state)?,
        app.join("src/desktop/icon.svg").display()
    );
    let autostart = format!(
        "[Desktop Entry]\nType=Application\nName=SpoolDB background capture\nExec=/usr/bin/env {} {} companion start\nTerminal=false\n",
        desktop(Path::new(&format!("SPOOL_STATE={}", state.display())))?,
        desktop(&binary)?
    );
    let wrapper = command(&app, &state)?;
    workspace_client::ensure_state(&state)?;
    let staged = Scratch(base.join(format!("app-new-{}", private_files::random_id()?)));
    private_files::private_dir(&staged.0)?;
    let mut copy_source = bundle.as_os_str().to_os_string();
    copy_source.push("/.");
    if !Command::new("/bin/cp")
        .args(["-a", "--"])
        .arg(copy_source)
        .arg(&staged.0)
        .status()?
        .success()
    {
        return Err("Could not stage SpoolDB application".into());
    }
    let prior = base.join(format!("app-previous-{}", private_files::random_id()?));
    if activate && existing[0].content.is_some() {
        exec("systemctl", &["--user", "stop", "spool.service"])?;
    }
    let mut swapped = false;
    let mut moved = false;
    let result = (|| -> Result<Value> {
        if update {
            fs::rename(&app, &prior)?;
            moved = true;
        }
        fs::rename(&staged.0, &app)?;
        swapped = true;
        atomic(&unit, unit_text.as_bytes(), 0o644)?;
        atomic(&entry, launcher.as_bytes(), 0o644)?;
        atomic(&cli, wrapper.as_bytes(), 0o755)?;
        let mut background = "systemd";
        if activate {
            let service = exec("systemctl", &["--user", "daemon-reload"])
                .and_then(|()| exec("systemctl", &["--user", "enable", "--now", "spool.service"]));
            if let Err(error) = service {
                if strict {
                    return Err(error);
                }
                background = "desktop-autostart";
                atomic(&fallback, autostart.as_bytes(), 0o644)?;
            }
        }
        let installed = json!({"cli":cli,"version":manifest["version"],"app":app,"state":state,
            "unit":unit,"desktop":entry,"background":background,"installedAt":DateTime::<Utc>::from(SystemTime::now()).to_rfc3339()});
        private_files::save_atomic(&receipt, &installed)?;
        Ok(installed)
    })();
    if let Err(error) = result {
        let rollback = (|| -> Result<()> {
            if activate && swapped {
                let _ = exec("systemctl", &["--user", "stop", "spool.service"]);
            }
            if swapped {
                fs::remove_dir_all(&app)?;
            }
            if moved {
                fs::rename(&prior, &app)?;
            }
            for file in &existing {
                file.restore()?;
            }
            if activate && existing[0].content.is_some() {
                exec("systemctl", &["--user", "daemon-reload"])?;
                exec("systemctl", &["--user", "start", "spool.service"])?;
            }
            Ok(())
        })();
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!(
                "{error}. Could not restore the previous installation: {rollback}"
            )
            .into()),
        };
    }
    result
}

pub fn run(bundle: &Path, args: &[OsString]) -> Result<()> {
    let bundle = fs::canonicalize(bundle)?;
    let mut verify = false;
    let mut update = false;
    let mut invite = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.to_str().ok_or("Invalid installer argument")? {
            "--verify-only" => verify = true,
            "--update" => update = true,
            "--invite-file" => {
                invite = Some(PathBuf::from(
                    args.next().ok_or("Pass a file after --invite-file")?,
                ))
            }
            _ => return Err("Use --verify-only, --update, --server or --invite-file FILE".into()),
        }
    }
    if verify {
        let manifest = base_manifest(&bundle)?;
        println!(
            "SpoolDB {} package verified.",
            manifest["version"].as_str().unwrap_or("unknown")
        );
        return Ok(());
    }
    let paths = Paths::user()?;
    if update {
        let mut result = install(&bundle, &paths, true, true)?;
        result["updated"] = json!(true);
        println!("{result}");
        return Ok(());
    }
    if !io::stdin().is_terminal() {
        return Err("Run the SpoolDB installer in a terminal".into());
    }
    exec("git", &["--version"]).map_err(|_| "Install Git before installing SpoolDB")?;
    let supplied = invite.map(fs::read_to_string).transpose()?;
    if let Some(link) = &supplied {
        workspace_client::check_invitation(link.trim())?;
    }
    eprintln!(
        "SpoolDB · shared project memory\nApplication: {}\nPrivate state: {}",
        paths.data.join("spool/app").display(),
        paths.state.join("spool").display()
    );
    if !matches!(
        init_cli::prompt("Install SpoolDB? (Y/n)", "Y")?
            .to_lowercase()
            .as_str(),
        "y" | "yes"
    ) {
        return Ok(());
    }
    install(&bundle, &paths, true, false)?;
    if let Some(applications) = paths.data.join("applications").to_str() {
        let _ = exec("update-desktop-database", &[applications]);
    }
    if let Err(error) = exec(
        "xdg-mime",
        &["default", "spool.desktop", "x-scheme-handler/spool"],
    ) {
        eprintln!("Could not register the invitation link handler: {error}");
    }

    let state = paths.state.join("spool");
    eprintln!(
        "SpoolDB installed. CLI command: {}",
        paths.bin.join("spool").display()
    );
    let link = match supplied {
        Some(value) => value,
        None => init_cli::prompt("Paste an invitation, or press Enter to continue", "")?,
    };
    if !link.trim().is_empty() {
        desktop_launch::queue(&state.join("inbox.json"), link.trim())?;
    }
    if init_cli::confirm("Configure the SpoolDB MCP for Codex?")?
        && let Err(error) = init_cli::install_codex_at(
            &state,
            &paths.data.join("spool/app/runtime/spool-native-linux-x64"),
        )
    {
        eprintln!("Codex setup needs attention: {error}");
    }
    if matches!(
        init_cli::prompt("Open SpoolDB? (Y/n)", "Y")?
            .to_lowercase()
            .as_str(),
        "y" | "yes"
    ) {
        desktop_launch::run(&[OsString::from("--state"), state.into_os_string()])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn installs_and_updates_the_native_application_without_mutating_existing_memory() -> Result<()>
    {
        let root =
            std::env::temp_dir().join(format!("spool-desktop-{}", private_files::random_id()?));
        private_files::private_dir(&root)?;
        let root = fs::canonicalize(root)?;
        let scratch = Scratch(root.clone());
        let bundle = root.join("release");
        let paths = Paths {
            data: root.join("data"),
            config: root.join("config"),
            state: root.join("state"),
            bin: root.join("bin with ' quote"),
        };
        let prepare = |version: &str| -> Result<()> {
            let mut files = serde_json::Map::new();
            for (name, text) in [
                ("package.json", json!({"version":version}).to_string()),
                (
                    "runtime/spool-native-linux-x64",
                    "#!/bin/sh\nexit 0\n".to_owned(),
                ),
                ("src/desktop/icon.svg", "<svg/>".to_owned()),
            ] {
                let path = bundle.join(name);
                fs::create_dir_all(path.parent().unwrap())?;
                fs::write(path, text.as_bytes())?;
                files.insert(
                    name.to_owned(),
                    json!(format!("{:x}", Sha256::digest(text))),
                );
            }
            private_files::save_atomic(
                &bundle.join("manifest.json"),
                &json!({"version":version,"files":files}),
            )
        };
        prepare("1.2.3")?;
        let first = install(&bundle, &paths, false, true)?;
        let state = paths.state.join("spool");
        fs::write(state.join("memory"), "existing bytes")?;
        assert_eq!(first["version"], "1.2.3");
        exec("sh", &["-n", paths.bin.join("spool").to_str().unwrap()])?;
        assert!(
            fs::read_to_string(paths.data.join("applications/spool.desktop"))?
                .contains("spool-native-linux-x64")
        );
        prepare("1.2.4")?;
        assert_eq!(install(&bundle, &paths, false, true)?["version"], "1.2.4");
        assert_eq!(fs::read_to_string(state.join("memory"))?, "existing bytes");
        fs::write(bundle.join("runtime/spool-native-linux-x64"), "tampered")?;
        assert!(install(&bundle, &paths, false, true).is_err());
        let receipt = crate::project_paths::optional_json::<Value>(
            &paths.data.join("spool/installation.json"),
        )?
        .unwrap();
        assert_eq!(receipt["version"], "1.2.4");
        drop(scratch);
        Ok(())
    }
}
