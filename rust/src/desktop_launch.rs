use crate::{
    Result, plugin_entry, private_files, project_binding, project_paths, workspace_client,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime},
};

pub fn inbox(path: &Path) -> Result<Vec<Value>> {
    Ok(project_paths::optional_json(path)?.unwrap_or_default())
}

struct Guard(PathBuf);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn edit(path: &Path, change: impl FnOnce(&mut Vec<Value>) -> Result<bool>) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    workspace_client::ensure_state(path.parent().ok_or("Missing invitation state directory")?)?;
    let mut lock = path.as_os_str().to_os_string();
    lock.push(".lock");
    let lock = PathBuf::from(lock);
    for _ in 0..100 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&lock)
        {
            Ok(_file) => {
                let _lock = Guard(lock);
                let mut items = inbox(path)?;
                if change(&mut items)? {
                    private_files::save_atomic(path, &json!(items))?;
                }
                return Ok(());
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                std::thread::sleep(Duration::from_millis(30))
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err("Invitation inbox is busy".into())
}

pub fn dismiss(path: &Path, link: &str) -> Result<()> {
    edit(path, |items| {
        let count = items.len();
        items.retain(|item| item["link"] != link);
        Ok(items.len() != count)
    })
}

pub fn queue(path: &Path, link: &str) -> Result<()> {
    workspace_client::check_invitation(link)?;
    edit(path, |items| {
        if items.iter().any(|item| item["link"] == link) {
            return Ok(false);
        }
        if items.len() >= 16 {
            return Err("Too many pending invitations".into());
        }
        let received =
            DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true);
        items.push(json!({"link":link,"receivedAt":received}));
        Ok(true)
    })
}

fn wait(origin: &str) -> Result<()> {
    let status = Command::new("systemctl")
        .args(["--user", "start", "spool.service"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()?;
    if status.success() {
        for _ in 0..100 {
            if plugin_entry::healthy_origin(origin) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    Err("The SpoolDB background service did not start".into())
}

pub fn run(arguments: &[OsString]) -> Result<()> {
    let mut state = None;
    let mut link = None;
    let mut existing = false;
    let mut options = arguments.iter();
    while let Some(argument) = options.next() {
        match argument.to_str().ok_or("Invalid launcher argument")? {
            "--state" => {
                state = Some(PathBuf::from(
                    options
                        .next()
                        .ok_or("Pass a state directory after --state")?,
                ))
            }
            "--existing" => existing = true,
            value
                if value.starts_with("spool:")
                    || value.starts_with("threadweave:")
                    || value.starts_with("https:")
                    || value.starts_with("http:") =>
            {
                if link.replace(value).is_some() {
                    return Err("Open one SpoolDB invitation at a time".into());
                }
            }
            _ => return Err("Use spool open [INVITATION] [--state DIRECTORY]".into()),
        }
    }
    let state = state.map_or_else(project_binding::state_root, Ok)?;
    let state = std::path::absolute(state)?;
    if let Some(link) = link {
        queue(
            &state.join(if existing {
                "pending-invite.json"
            } else {
                "inbox.json"
            }),
            link,
        )?;
    }
    let origin = if existing {
        let origin = "http://127.0.0.1:8787";
        if !plugin_entry::healthy_origin(origin) {
            wait(origin)?;
        }
        origin.to_owned()
    } else if let Some(origin) = plugin_entry::live_origin(&state) {
        origin
    } else {
        if let Some(home) = std::env::home_dir() {
            let data = std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/share"));
            let receipt =
                project_paths::optional_json::<Value>(&data.join("spool/installation.json"))?;
            if receipt
                .as_ref()
                .and_then(|receipt| receipt["state"].as_str())
                .map(Path::new)
                == Some(state.as_path())
            {
                let _ = Command::new("systemctl")
                    .args(["--user", "start", "spool.service"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        plugin_entry::start_companion(&state)?;
        plugin_entry::live_origin(&state).ok_or("SpoolDB background service is unavailable")?
    };
    if std::env::var("SPOOL_NO_OPEN").as_deref() != Ok("1") {
        let program = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        let mut child = Command::new(program)
            .arg(format!("{origin}/"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    println!("{}", json!({"origin":origin}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invitation_queue_is_compatible_and_deduplicated() -> Result<()> {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        let root =
            std::env::temp_dir().join(format!("spool-inbox-{}", private_files::random_id()?));
        private_files::private_dir(&root)?;
        let result = (|| -> Result<()> {
            let path = root.join("inbox.json");
            let payload =
                json!({"version":1,"url":"https://spool.example.org","code":"A".repeat(43)});
            let link = format!(
                "spool://workspace/v1/{}",
                URL_SAFE_NO_PAD.encode(payload.to_string())
            );
            assert!(queue(&path, "https://spool.example.org").is_err());
            queue(&path, &link)?;
            queue(&path, &link)?;
            assert_eq!(inbox(&path)?.len(), 1);
            dismiss(&path, &link)?;
            assert!(inbox(&path)?.is_empty());
            Ok(())
        })();
        fs::remove_dir_all(root)?;
        result
    }
}
