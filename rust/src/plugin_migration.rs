use crate::{
    Result, codex_history, private_files, project_binding, relay_retention::metadata,
    workspace_client,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

const MARKERS: [(&str, &str); 3] = [
    ("# BEGIN SPOOL DISCOVERY", "# END SPOOL DISCOVERY"),
    ("# BEGIN SPOOL MANAGED", "# END SPOOL MANAGED"),
    ("# BEGIN THREADWEAVE MANAGED", "# END THREADWEAVE MANAGED"),
];

fn remove_blocks(contents: &str) -> Result<String> {
    let mut output = String::with_capacity(contents.len());
    let mut active = None;
    let mut seen = [false; 3];
    for line in contents.split_inclusive('\n') {
        let text = line.trim_end_matches(['\r', '\n']);
        if let Some(index) = MARKERS.iter().position(|(start, _)| text == *start) {
            if active.is_some() || seen[index] {
                return Err("Duplicate or overlapping SpoolDB managed block".into());
            }
            seen[index] = true;
            active = Some(index);
        } else if let Some(index) = MARKERS.iter().position(|(_, end)| text == *end) {
            if active != Some(index) {
                return Err("Unmatched SpoolDB managed block marker".into());
            }
            active = None;
        } else if active.is_none() {
            output.push_str(line);
        }
    }
    if active.is_some() {
        return Err("Incomplete SpoolDB managed block".into());
    }
    Ok(output)
}

fn trusted(root: &Path, plugin: &Path) -> Result<bool> {
    let app = [
        "/Applications/Codex.app/Contents/Resources/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
    ]
    .into_iter()
    .find(|path| Path::new(path).is_file())
    .unwrap_or("codex");
    let mut rpc = codex_history::History::start(Path::new(app))?;
    let data = rpc.request("hooks/list", json!({"cwds":[root]}))?;
    let source = plugin.join("hooks/hooks.json");
    Ok(data["data"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|value| value["cwd"] == json!(root))
        .is_some_and(|entry| {
            let hooks = entry["hooks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|hook| {
                    hook["sourcePath"] == json!(source)
                        && hook["command"].as_str().is_some_and(|command| {
                            command.contains("/spool/codex-hooks/")
                                || command.contains("scripts/spool.sh")
                        })
                })
                .collect::<Vec<_>>();
            hooks.len() == 4
                && hooks.iter().all(|hook| hook["trustStatus"] == "trusted")
                && entry["errors"].as_array().is_none_or(Vec::is_empty)
        }))
}

fn configuration_files(root: &Path) -> Result<std::collections::BTreeSet<PathBuf>> {
    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|home| home.join(".codex")))
        .ok_or("Could not locate Codex configuration")?;
    let project_config = root.join(".codex");
    if metadata(&project_config)?.is_some_and(|entry| !entry.is_dir()) {
        return Err("Repository Codex configuration directory is symlinked or invalid".into());
    }
    Ok(std::collections::BTreeSet::from([
        codex.join("config.toml"),
        root.join(".codex/config.toml"),
    ]))
}

pub fn legacy_configuration(root: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for path in configuration_files(root)? {
        if metadata(&path)?.is_some_and(|file| file.is_file() && file.len() < 2_000_000)
            && fs::read_to_string(&path)?
                .lines()
                .any(|line| MARKERS.iter().any(|(begin, _)| line == *begin))
        {
            paths.push(path);
        }
    }
    Ok(paths)
}

pub fn migrate(root: &Path, plugin: Option<&Path>, approved: bool) -> Result<Value> {
    if !approved {
        return Err(
            "Explicit approval is required to migrate the existing SpoolDB integration".into(),
        );
    }
    let root = project_binding::repository_root(root)?;
    let files = configuration_files(&root)?;
    let mut changes = Vec::new();
    let mut locks = Vec::new();
    for path in files {
        let Some(meta) = metadata(&path)? else {
            continue;
        };
        if !meta.is_file() || meta.len() > 2_000_000 {
            return Err("Codex configuration is not a supported regular file".into());
        }
        let lock = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(path.with_file_name(".spool-config.lock"))?;
        lock.lock()?;
        locks.push(lock);
        let original = fs::read_to_string(&path)?;
        let edited = remove_blocks(&original)?;
        if original != edited {
            changes.push((path, original, edited));
        }
    }
    if changes.is_empty() {
        return Ok(json!({"migrated":true,"changed":[],"restartRequired":false}));
    }
    if !plugin.is_some_and(|plugin| trusted(&root, plugin).unwrap_or(false)) {
        return Ok(
            json!({"migrated":false,"needsHookReview":true,"message":"Review and trust the four SpoolDB plugin hooks in Codex, then retry migration."}),
        );
    }
    let backups = project_binding::state_root()?.join("integration-backups");
    workspace_client::ensure_state(&backups)?;
    let mut result = Vec::new();
    for (path, original, edited) in changes {
        let id = private_files::random_id()?;
        let backup = backups.join(format!("plugin-migration-{id}.toml"));
        private_files::write_private(&backup, original.as_bytes())?;
        let staged = path.with_file_name(format!(".spool-migration-{id}.tmp"));
        let change = private_files::write_private(&staged, edited.as_bytes())
            .and_then(|()| Ok(fs::rename(&staged, &path)?));
        if change.is_err() {
            let _ = fs::remove_file(staged);
        }
        change?;
        result.push(json!({"path":path,"backup":backup}));
    }
    Ok(json!({"migrated":true,"changed":result,"restartRequired":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_only_complete_managed_blocks_and_leaves_other_config_byte_for_byte() {
        let before = "model = \"x\"\r\n# BEGIN SPOOL MANAGED\r\nlegacy=true\r\n# END SPOOL MANAGED\r\n[mcp_servers.other]\r\ncommand = \"other\"";
        assert_eq!(
            remove_blocks(before).unwrap(),
            "model = \"x\"\r\n[mcp_servers.other]\r\ncommand = \"other\""
        );
        assert!(remove_blocks("# BEGIN SPOOL MANAGED\nmissing end\n").is_err());
    }
}
