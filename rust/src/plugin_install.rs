use crate::{
    Result, plugin_entry, private_files, project_binding, project_paths, relay_retention::metadata,
    workspace_client,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn install() -> Result<Value> {
    let exe = std::env::current_exe()?;
    let source = exe
        .parent()
        .and_then(Path::parent)
        .ok_or("Could not locate SpoolDB installation")?
        .join("local-marketplace");
    if !source.is_dir() {
        return Err("This build does not contain a bundled Codex marketplace. Install ywnzo/spooldb from Codex's Plugins page.".into());
    }
    let home = std::env::home_dir().ok_or("Could not locate home directory")?;
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let destination = data.join("spool/plugin-marketplace");
    workspace_client::ensure_state(destination.parent().ok_or("Invalid marketplace path")?)?;
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(destination.with_extension("lock"))?;
    lock.try_lock()
        .map_err(|_| "Another SpoolDB plugin installation is in progress")?;
    let prior = match metadata(&destination)? {
        Some(meta) if meta.is_dir() => {
            let receipt =
                project_paths::optional_json::<Value>(&destination.join("spool-marketplace.json"))?;
            if receipt.is_none_or(|value| value["managedBy"] != "SpoolDB") {
                return Err("An unmanaged marketplace already exists".into());
            }
            true
        }
        Some(_) => return Err("An unmanaged marketplace already exists".into()),
        None => false,
    };
    let stage = Stage(destination.with_extension(format!("new-{}", private_files::random_id()?)));
    private_files::private_dir(&stage.0)?;
    let mut path = source.into_os_string();
    path.push("/.");
    if !Command::new("/bin/cp")
        .args(["-a", "--"])
        .arg(path)
        .arg(&stage.0)
        .stdin(Stdio::null())
        .status()?
        .success()
    {
        return Err("Could not stage the bundled marketplace".into());
    }
    let plugin = stage.0.join("plugins/spooldb");
    let descriptor =
        project_paths::optional_json::<Value>(&plugin.join(".codex-plugin/plugin.json"))?
            .ok_or("Missing bundled plugin descriptor")?;
    let version = descriptor["version"]
        .as_str()
        .ok_or("Missing bundled plugin version")?;
    if descriptor["name"] != "spooldb" {
        return Err("Invalid bundled marketplace".into());
    }
    plugin_entry::install_hooks(&fs::canonicalize(&plugin)?)?;
    private_files::save(
        &stage.0.join("spool-marketplace.json"),
        &json!({"managedBy":"SpoolDB","version":version}),
    )?;
    let saved = destination.with_extension(format!("previous-{}", private_files::random_id()?));
    if prior {
        fs::rename(&destination, &saved)?;
    }
    if let Err(error) = fs::rename(&stage.0, &destination) {
        if prior {
            fs::rename(saved, &destination)?;
        }
        return Err(error.into());
    }
    // Codex owns its marketplace registration and all hook trust.
    let settings = config.join("spool/plugin.json");
    workspace_client::ensure_state(settings.parent().ok_or("Invalid plugin settings path")?)?;
    private_files::save_atomic(
        &settings,
        &json!({"state":std::path::absolute(project_binding::state_root()?)?}),
    )?;
    let program = [
        "/Applications/Codex.app/Contents/Resources/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
    ]
    .into_iter()
    .find(|path| Path::new(path).is_file())
    .unwrap_or("codex");
    let marketplace = destination.to_str().ok_or("Invalid marketplace path")?;
    for args in [
        vec!["plugin", "marketplace", "add", marketplace, "--json"],
        vec!["plugin", "add", "spooldb@spooldb", "--json"],
    ] {
        let output = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .output()?;
        if !output.status.success() {
            return Err(format!("Codex could not register SpoolDB ({}). The local marketplace is available at {marketplace}.",
                output.status).into());
        }
    }
    Ok(
        json!({"marketplace":destination,"plugin":destination.join("plugins/spooldb"),"installed":true,
        "hookReviewRequired":true,"restartRequired":true,"setupSkill":"spooldb:setup",
        "message":"Review the SpoolDB hooks in Codex and open a new chat to finish setup."}),
    )
}
