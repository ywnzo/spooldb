use crate::project_paths::optional_json;
pub(crate) use crate::project_paths::{
    git, repository_key, repository_root, repository_skipped, state_root,
};
use crate::{Result, relay_client::ConnectionOptions};
use serde::Deserialize;
use std::io::ErrorKind;
use std::{
    fs,
    path::{Path, PathBuf},
};
use url::Url;

#[derive(Deserialize)]
struct Registry {
    projects: Vec<Project>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    root: PathBuf,
    dir: PathBuf,
}

#[derive(Deserialize)]
struct Discovery {
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    root: PathBuf,
    status: String,
    project_id: Option<String>,
    room: Option<String>,
    repository_key: Option<String>,
    workspace_profile: Option<String>,
    parent: Option<Parent>,
}

#[derive(Deserialize)]
struct Parent {
    root: PathBuf,
    room: String,
}

pub struct Binding {
    pub root: PathBuf,
    pub local_id: String,
    pub grant: Option<ConnectionOptions>,
    pub directory: PathBuf,
    pub workspace_profile: Option<String>,
    parent: Option<Parent>,
}

impl Binding {
    pub fn info(&self) -> serde_json::Value {
        match &self.grant {
            Some(grant) => {
                serde_json::json!({"root":self.root,"relay":grant.url,"room":grant.room,"projectId":self.local_id})
            }
            None => {
                serde_json::json!({"root":self.root,"room":self.local_id,"projectId":self.local_id,"mode":"local"})
            }
        }
    }

    pub fn memory(&self, input: &serde_json::Value) -> Result<serde_json::Value> {
        let database = self.directory.join("relay.sqlite");
        let Some(grant) = &self.grant else {
            return crate::relay::local_memory(&database, &self.local_id, input);
        };
        let client = crate::relay_client::Client::new(grant.clone())?;
        let key = crate::capture_export::private_key(grant);
        let local =
            || crate::relay::local_memory_scoped(&database, &self.local_id, input, Some(&key));
        if crate::memory_mutation::command(input) {
            let state = client.request("state", None)?;
            let request = match crate::memory_write::apply_sharing(input, &state["sharing"]) {
                Ok(request) => request,
                Err(error) if error.1 == "SHARING_DISABLED" => {
                    return local()?.ok_or_else(|| "Private memory is unavailable".into());
                }
                Err(error) => return Err(error.2.into()),
            };
            return match client.request("memory", Some(&request)) {
                Ok(value) => Ok(value),
                Err(error) if error.code == "SHARING_DISABLED" => {
                    local()?.ok_or_else(|| "Private memory is unavailable".into())
                }
                Err(error) => Err(error.into()),
            };
        }
        if !database.is_file() {
            return Ok(client.request("memory", Some(input))?);
        }
        let local = local()?;
        if input["command"] == "get"
            && let Some(local) = local
        {
            return Ok(local);
        }
        let mut value = client.request("memory", Some(input))?;
        if let Some(mut local) = local {
            for key in ["tasks", "notes", "results", "relatedConversations"] {
                if let Some(items) = value.get_mut(key).and_then(serde_json::Value::as_array_mut)
                    && let Some(private) = local[key].as_array_mut()
                {
                    items.append(private);
                }
            }
        }
        Ok(value)
    }

    pub fn linked_parent(&self) -> Result<Option<Self>> {
        let Some(link) = &self.parent else {
            return Ok(None);
        };
        let current = self
            .grant
            .as_ref()
            .ok_or("Linked project needs a relay grant")?;
        if !link.root.is_absolute() || link.room == current.room {
            return Err("Invalid linked parent binding".into());
        }
        let parent = resolve(&link.root)?;
        let grant = parent
            .grant
            .as_ref()
            .ok_or("Linked parent needs a relay grant")?;
        if parent.root != link.root
            || grant.room != link.room
            || Url::parse(&grant.url)?.origin() != Url::parse(&current.url)?.origin()
        {
            return Err("The linked parent project is unavailable or its binding changed".into());
        }
        Ok(Some(parent))
    }
}

#[derive(Deserialize)]
struct ProjectConfig {
    root: PathBuf,
    room: String,
}

pub fn check_files(root: &Path, files: &serde_json::Value) -> Result<()> {
    for file in files.as_array().into_iter().flatten() {
        let path = Path::new(
            file.as_str()
                .ok_or("Expected a project-relative file path")?,
        );
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err("File paths must remain inside the current repository".into());
        }
        let mut current = root.to_owned();
        for component in path.components() {
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(meta) if meta.is_dir() && current.join(".git").exists() => {
                    return Err("Use the file’s nested repository as the memory root".into());
                }
                Ok(meta) if meta.is_symlink() => {
                    return Err("File references cannot cross symlinks".into());
                }
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => break,
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

pub(crate) fn allow_local_init(state: &Path, root: &Path) -> Result<()> {
    let entry = optional_json::<Discovery>(&state.join("discovery.json"))?
        .into_iter()
        .flat_map(|value| value.entries)
        .find(|item| item.root == root);
    if let Some(entry) = entry {
        let key = git(root, &["remote", "get-url", "origin"])
            .ok()
            .and_then(|remote| repository_key(&remote));
        if entry.status != "pending" || entry.repository_key != key {
            return Err(
                "This repository needs explicit SpoolDB enrollment or binding repair".into(),
            );
        }
    }
    Ok(())
}

pub fn resolve(cwd: &Path) -> Result<Binding> {
    let root = repository_root(cwd)?;
    let state = fs::canonicalize(state_root()?)?;
    if state.starts_with(&root) || root.starts_with(&state) {
        return Err("Choose a repository outside SpoolDB state".into());
    }
    let primary = if state.join("project.json").is_file() {
        state.clone()
    } else {
        state.join("p")
    };
    let registry = optional_json::<Registry>(&primary.join("projects.json"))?;
    let entry = optional_json::<Discovery>(&state.join("discovery.json"))?
        .into_iter()
        .flat_map(|value| value.entries)
        .find(|item| item.root == root);
    if let Some(entry) = &entry {
        let key = git(&root, &["remote", "get-url", "origin"])
            .ok()
            .and_then(|remote| repository_key(&remote));
        if entry.repository_key != key || entry.status == "ignored" {
            return Err("This repository needs explicit SpoolDB enrollment".into());
        }
    }
    let listed = registry
        .into_iter()
        .flat_map(|value| value.projects)
        .find(|project| fs::canonicalize(&project.root).is_ok_and(|path| path == root));
    let directory = listed
        .as_ref()
        .map(|project| &project.dir)
        .unwrap_or(&primary);
    let directory = fs::canonicalize(directory)?;
    if !directory.starts_with(&state) {
        return Err("Project data is outside SpoolDB state".into());
    }
    let project = optional_json::<ProjectConfig>(&directory.join("project.json"))?
        .ok_or("This repository has no saved SpoolDB project")?;
    if fs::canonicalize(&project.root)? != root
        || listed
            .as_ref()
            .is_some_and(|project_entry| project_entry.id != project.room)
        || entry.as_ref().is_some_and(|item| {
            item.status == "enrolled" && item.project_id.as_deref() != Some(project.room.as_str())
        })
    {
        return Err("Saved SpoolDB project does not match this repository".into());
    }
    let grant = optional_json::<ConnectionOptions>(&directory.join("team.json"))?;
    if let Some(item) = &entry {
        match (&grant, item.status.as_str()) {
            (Some(grant), "enrolled") if item.room.as_deref() == Some(grant.room.as_str()) => {}
            (None, "pending") => {}
            _ => return Err("Saved SpoolDB relay grant does not match this repository".into()),
        }
    }
    Ok(Binding {
        root,
        local_id: project.room,
        directory,
        grant,
        workspace_profile: entry
            .as_ref()
            .and_then(|entry| entry.workspace_profile.clone()),
        parent: entry.and_then(|entry| entry.parent),
    })
}

pub fn registered_roots() -> Result<Vec<PathBuf>> {
    let state = state_root()?;
    let primary = if state.join("project.json").is_file() {
        state
    } else {
        state.join("p")
    };
    let mut roots = std::collections::BTreeSet::new();
    if let Some(project) = optional_json::<ProjectConfig>(&primary.join("project.json"))? {
        roots.insert(project.root);
    }
    if let Some(registry) = optional_json::<Registry>(&primary.join("projects.json"))? {
        roots.extend(registry.projects.into_iter().map(|entry| entry.root));
    }
    Ok(roots.into_iter().collect())
}

pub fn capture_enabled(binding: &Binding) -> Result<bool> {
    #[derive(Deserialize)]
    struct Integrations {
        codex: bool,
    }
    Ok(
        optional_json::<Integrations>(&binding.directory.join("integrations.json"))?
            .is_some_and(|integrations| integrations.codex),
    )
}
