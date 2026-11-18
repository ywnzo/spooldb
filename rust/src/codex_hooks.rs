use crate::{
    Result,
    private_files::{private_dir, save_atomic},
    project_paths,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const BACKGROUND_PROMPT: &str = "This is an app-generated request for a suggested next user message. The user did not write this message.";

fn hash(text: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(text))
}

fn lifecycle_path(dir: &Path, root: &Path, session: &str) -> Result<PathBuf> {
    let root = root.to_str().ok_or("Repository path is not UTF-8")?;
    Ok(dir
        .join("lifecycle")
        .join(format!("{}-{}.json", hash(session), &hash(root)[..16])))
}

fn record(root: &Path, session: &str, event: &str, ignored: bool) -> Result<()> {
    let state = project_paths::state_root()?;
    let path = lifecycle_path(&state, root, session)?;
    let directory = path.parent().ok_or("Invalid lifecycle directory")?;
    if !directory.try_exists()? {
        fs::create_dir_all(&state)?;
        match private_dir(directory) {
            Ok(()) => (),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) => {}
            Err(error) => return Err(error),
        }
    }
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    let time = chrono::DateTime::from_timestamp_secs(seconds)
        .ok_or("Invalid lifecycle timestamp")?
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut value = json!({"sessionId":session,"root":root,"ignored":ignored,
        "guidanceSent":!ignored,"startedAt":time});
    if event == "UserPromptSubmit" && !ignored {
        value["lastPromptAt"] = json!(time);
    }
    save_atomic(&path, &value)
}

#[allow(dead_code)] // Only the MCP executable reads hook receipts.
pub fn ignored(root: &Path, session: &str) -> bool {
    let read = || -> Result<bool> {
        let path = lifecycle_path(&project_paths::state_root()?, root, session)?;
        let mut data = Vec::new();
        fs::File::open(path)?.take(65_537).read_to_end(&mut data)?;
        if data.len() > 65_536 {
            return Ok(false);
        }
        let value: Value = serde_json::from_slice(&data)?;
        Ok(value["sessionId"] == session && value["ignored"] == true)
    };
    read().unwrap_or(false)
}

pub fn run(event: &str, input: &Value) -> Result<Value> {
    if !matches!(event, "SessionStart" | "UserPromptSubmit") {
        return Ok(json!({}));
    }
    let Some(session) = input["session_id"]
        .as_str()
        .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 200)
    else {
        return Ok(json!({}));
    };
    let path = Path::new(
        input["cwd"]
            .as_str()
            .filter(|path| path.len() <= 4096)
            .ok_or("Invalid working directory")?,
    );
    if !path.is_absolute() {
        return Ok(json!({}));
    }
    let root = project_paths::repository_root(path)?;
    if project_paths::repository_skipped(&root).unwrap_or(false) {
        return Ok(json!({}));
    }
    if let Ok(file) = fs::File::open(root.join(".codex/config.toml")) {
        let mut bytes = String::new();
        file.take(1_000_000).read_to_string(&mut bytes)?;
        if bytes.contains("# BEGIN SPOOL MANAGED") {
            return Ok(json!({}));
        }
    }
    let ignored = event == "UserPromptSubmit"
        && input["prompt"]
            .as_str()
            .is_some_and(|prompt| prompt.starts_with(BACKGROUND_PROMPT));
    let _ = record(&root, session, event, ignored);
    if ignored {
        return Ok(json!({}));
    }
    let digest = hash(session);
    let hint = format!(
        "SpoolDB is optional. If prior project memory would help, consider project_context or memory_search with the current Git root. You can continue directly if it is irrelevant or unavailable. Save durable findings or a handoff only when useful and follow the project sharing settings. Connecting a repository requires explicit user approval. Task for this Codex session: codex-{}.",
        &digest[..24],
    );
    Ok(json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":hint}}))
}
