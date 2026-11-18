use crate::Result;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use url::Url;

pub(crate) fn optional_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(4_000_001).read_to_end(&mut bytes)?;
    if bytes.len() > 4_000_000 {
        return Err("Project configuration exceeds byte limit".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| format!("Invalid project configuration at {}", path.display()).into())
}

pub(crate) fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
        ])
        .arg(cwd)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err("Git could not resolve the repository".into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

pub(crate) fn repository_key(remote: &str) -> Option<String> {
    let (host, path) = if let Some((user, scp)) = remote.split_once('@')
        && !user.is_empty()
        && !user.contains(['/', ':'])
        && let Some((host, path)) = scp.split_once(':')
        && !host.contains('/')
    {
        (host.to_ascii_lowercase(), path.to_owned())
    } else {
        let url = Url::parse(remote).ok()?;
        let default = match url.scheme() {
            "http" => 80,
            "https" => 443,
            "ssh" => 22,
            "git" => 9418,
            _ => return None,
        };
        let host = url.host_str()?.to_ascii_lowercase();
        let host = match url.port() {
            Some(port) if port != default => format!("{host}:{port}"),
            _ => host,
        };
        (host, url.path().to_owned())
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if host.is_empty() || path.is_empty() || path.split('/').any(|part| matches!(part, "." | ".."))
    {
        return None;
    }
    Some(format!(
        "{:x}",
        Sha256::digest(format!("{host}/{path}").as_bytes())
    ))
}

pub(crate) static STATE_OVERRIDE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub(crate) fn state_root() -> Result<PathBuf> {
    if let Some(path) = STATE_OVERRIDE.get() {
        return Ok(path.clone());
    }
    if let Some(path) = std::env::var_os("SPOOL_STATE") {
        return Ok(path.into());
    }
    let home = std::env::home_dir().ok_or("Could not resolve the SpoolDB state folder")?;
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    for receipt in [
        config.join("spool/plugin.json"),
        data.join("spool/installation.json"),
    ] {
        if let Some(value) = optional_json::<Value>(&receipt)? {
            let state = value["state"]
                .as_str()
                .ok_or("SpoolDB installation state is unavailable")?;
            return Ok(PathBuf::from(state));
        }
    }
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/state"));
    Ok(state.join("spool"))
}

pub fn repository_root(cwd: &Path) -> Result<PathBuf> {
    Ok(fs::canonicalize(git(
        cwd,
        &["rev-parse", "--show-toplevel"],
    )?)?)
}

pub fn repository_skipped(root: &Path) -> Result<bool> {
    let saved = optional_json::<Value>(&state_root()?.join("discovery.json"))?;
    let entry = saved
        .as_ref()
        .and_then(|data| data["entries"].as_array())
        .into_iter()
        .flatten()
        .find(|entry| {
            entry["root"]
                .as_str()
                .is_some_and(|path| Path::new(path) == root)
                && entry["status"] == "ignored"
        });
    let Some(entry) = entry else { return Ok(false) };
    let key = git(root, &["remote", "get-url", "origin"])
        .ok()
        .and_then(|url| repository_key(&url));
    Ok(entry["repositoryKey"].as_str() == key.as_deref())
}
