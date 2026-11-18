use crate::{
    Result,
    project_binding::{self, Binding, git, repository_key, repository_root},
    project_init, workspace_client,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

struct Repository {
    root: PathBuf,
    identity: Option<String>,
}

impl Repository {
    fn from(input: &Value) -> Result<Self> {
        let path = input["cwd"]
            .as_str()
            .or_else(|| input["root"].as_str())
            .ok_or("Choose a Git repository")?;
        if path.is_empty() || path.len() > 4096 || path.contains('\0') {
            return Err("Invalid repository directory".into());
        }
        let root = repository_root(Path::new(path))?;
        let identity = git(&root, &["remote", "get-url", "origin"])
            .ok()
            .and_then(|url| repository_key(&url));
        Ok(Self { root, identity })
    }

    fn parent(&self) -> Option<Binding> {
        let enclosing = self.root.parent()?;
        let parent = project_binding::resolve(enclosing).ok()?;
        (parent.root != self.root && parent.grant.is_some()).then_some(parent)
    }

    fn details(&self, binding: Option<&Binding>) -> Value {
        let id = format!(
            "{:x}",
            Sha256::digest(self.root.as_os_str().as_encoded_bytes())
        );
        let mut value = json!({"id":id,"root":self.root,"name":self.root.file_name(),
            "repositoryKey":self.identity,"status":"pending"});
        if project_binding::repository_skipped(&self.root).unwrap_or(false) {
            value["status"] = json!("ignored");
        }
        if let Some(binding) = binding
            && let Some(grant) = &binding.grant
        {
            value["status"] = json!("enrolled");
            value["projectId"] = json!(binding.local_id);
            value["room"] = json!(grant.room);
            value["workspace"] = json!(grant.url);
        }
        value
    }
}

fn choose_workspace(repo: &Repository, input: &Value, profiles: &Value) -> Option<String> {
    let configured = |binding: Binding| {
        let value = binding
            .workspace_profile
            .or_else(|| binding.grant.map(|grant| grant.url))?;
        profiles["workspaces"]
            .as_array()?
            .iter()
            .any(|profile| profile["id"] == value || profile["relay"] == value)
            .then_some(value)
    };
    input["workspace"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            project_binding::resolve(&repo.root)
                .ok()
                .and_then(configured)
        })
        .or_else(|| repo.parent().and_then(configured))
        .or_else(|| match profiles["workspaces"].as_array()?.as_slice() {
            [profile] => profile["id"].as_str().map(str::to_owned),
            _ => None,
        })
}

fn link_parent(repo: &Repository, input: &Value) -> Result<Value> {
    if input["confirm"] != true {
        return Err("Explicit user approval is required to link projects".into());
    }
    let Some(parent) = repo.parent() else {
        return Err("Connect the enclosing repository first".into());
    };
    let state = project_binding::state_root()?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("project-enroll.lock"))?;
    lock.lock()?;
    let child = project_binding::resolve(&repo.root)?;
    let (Some(child_grant), Some(parent_grant)) = (&child.grant, &parent.grant) else {
        return Err("Connect both repositories before linking them".into());
    };
    if child_grant.url != parent_grant.url || child_grant.room == parent_grant.room {
        return Err("Choose two different projects on the same relay".into());
    }
    if let Some(expected) = input["parentRoom"].as_str()
        && expected != parent_grant.room
    {
        return Err("The enclosing repository does not match the approved parent".into());
    }
    let mut registry = registry()?;
    let entry = registry["entries"]
        .as_array_mut()
        .ok_or("Invalid discovery state")?
        .iter_mut()
        .find(|entry| {
            entry["root"] == json!(repo.root)
                && entry["status"] == "enrolled"
                && entry["room"] == child_grant.room
        })
        .ok_or("The subproject needs an explicit local repository enrollment")?;
    let profile = child
        .workspace_profile
        .as_deref()
        .unwrap_or(&child_grant.url);
    let response = workspace_client::action(
        profile,
        &json!({"command":"link-parent",
        "room":child_grant.room,"parentRoom":parent_grant.room}),
    )?;
    if response["project"]["parentRoom"] != parent_grant.room {
        return Err("The relay did not confirm the parent project".into());
    }
    entry["parent"] = json!({"root":parent.root,"room":parent_grant.room});
    workspace_client::save_atomic(&state.join("discovery.json"), &registry)?;
    Ok(response)
}

fn preview(repo: &Repository, input: &Value) -> Result<Value> {
    let binding = project_binding::resolve(&repo.root).ok();
    let mut value = repo.details(binding.as_ref());
    if let Some(parent) = repo.parent()
        && let Some(grant) = &parent.grant
    {
        value["parentCandidate"] = json!({"root":parent.root,"name":parent.root.file_name(),
            "room":grant.room,"workspace":grant.url,"projectId":parent.local_id});
    }
    let profiles = workspace_client::list_profiles()?;
    let selector = choose_workspace(repo, input, &profiles);
    let Some(selector) = selector else {
        value["connected"] = json!(false);
        value["selectionRequired"] = json!(true);
        value["workspaces"] = profiles["workspaces"].clone();
        return Ok(value);
    };
    let listed = workspace_client::action(&selector, &json!({"command":"list"}))?;
    let capabilities = listed["capabilities"].as_array().into_iter().flatten();
    let create_supported = capabilities
        .clone()
        .any(|value| value == "repository-enrollment-v2");
    let nested_supported = capabilities.clone().any(|value| value == "subprojects-v1");
    let mut matched = Value::Null;
    if let Some(key) = &repo.identity
        && create_supported
    {
        matched = workspace_client::action(
            &selector,
            &json!({"command":"repository-match","repositoryKey":key}),
        )?;
    }
    value["matches"] = matched["projects"]
        .as_array()
        .map_or_else(|| json!([]), |items| json!(items));
    value["ambiguous"] = json!(matched["ambiguous"] == true);
    value["projects"] = listed["projects"].clone();
    value["workspaceProfile"] = listed["workspaceProfile"].clone();
    value["workspaces"] = profiles["workspaces"].clone();
    value["workspaceName"] = listed["workspace"]["name"].clone();
    value["relay"] = listed["relay"].clone();
    value["canCreate"] = json!(create_supported && listed["member"]["canCreate"] == true);
    value["subprojectsSupported"] = json!(nested_supported);
    if !create_supported {
        value["relayUpdate"] = json!({"required":true,
            "reason":"This relay predates safe repository creation. Existing projects can still be joined.",
            "next":{"tool":"spool_setup","arguments":{"action":"relay_update","workspace":listed["workspaceProfile"]}}});
    }
    value["connected"] = json!(true);
    Ok(value)
}

fn approve(repo: &Repository, input: &Value) -> Result<Value> {
    if input["confirm"] != true {
        return Err("Explicit confirmation is required to connect this repository".into());
    }
    let profiles = workspace_client::list_profiles()?;
    let selector =
        choose_workspace(repo, input, &profiles).ok_or("Choose a saved workspace connection")?;
    let target = input["room"].as_str();
    let create = input["create"] == true;
    if create == target.is_some() {
        return Err("Choose either an existing project or a new project".into());
    }
    let parent = if let Some(parent_room) = input["parentRoom"].as_str() {
        if !create {
            return Err("Choose create to attach a new subproject".into());
        }
        let parent = repo
            .parent()
            .filter(|parent| {
                parent
                    .grant
                    .as_ref()
                    .is_some_and(|grant| grant.room == parent_room)
            })
            .ok_or("Choose the enrolled enclosing repository as parent")?;
        Some(parent.root)
    } else {
        None
    };
    let requested = if create {
        input["name"]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .or_else(|| repo.root.file_name().and_then(|name| name.to_str()))
            .ok_or("Enter a project name")?
    } else {
        target.ok_or("Choose an existing project")?
    };
    let local = project_init::initialize(&repo.root)?;
    let result = workspace_client::enroll_project(
        &selector,
        &repo.root,
        if create { "create" } else { "join" },
        requested,
        parent.as_deref(),
    )?;
    let binding = project_binding::resolve(&repo.root)?;
    if result["existing"] != true && input["shareConversations"] != false {
        workspace_client::save_atomic(
            &binding.directory.join("integrations.json"),
            &json!({"codex":true}),
        )?;
    }
    if let Some(choice) = input["analyzeExisting"].as_bool() {
        crate::retrospective::choose(&repo.root, choice)?;
    }
    let mut value = repo.details(Some(&binding));
    value["existing"] = result["existing"].clone();
    value["localProjectCreated"] = json!(local["existing"] == false);
    Ok(value)
}

pub fn run(input: &Value) -> Result<Value> {
    if input["command"] == "list" {
        let mut roots = project_binding::registered_roots()?
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        let saved = registry()?;
        roots.extend(
            saved["entries"]
                .as_array()
                .ok_or("Invalid discovery state")?
                .iter()
                .filter_map(|entry| entry["root"].as_str())
                .map(PathBuf::from),
        );
        let entries = roots
            .into_iter()
            .filter_map(|root| {
                let repository = Repository::from(&json!({"cwd":root})).ok()?;
                let binding = project_binding::resolve(&repository.root).ok();
                Some(repository.details(binding.as_ref()))
            })
            .collect::<Vec<_>>();
        return Ok(json!({"entries":entries}));
    }
    let repo = Repository::from(input)?;
    match input["command"].as_str() {
        Some("preview") => preview(&repo, input),
        Some("approve") => approve(&repo, input),
        Some("link-parent") => link_parent(&repo, input),
        Some("ignore" | "propose") => save_discovery(&repo, input["command"] == "ignore"),
        Some("retrospective" | "approve-existing") => {
            if input["confirm"] != true {
                return Err("Explicit user approval is required for historical analysis".into());
            }
            if let Some(choice) = input["analyzeExisting"].as_bool() {
                crate::retrospective::choose(&repo.root, choice)
            } else if let Some(id) = input["handoffId"].as_str() {
                crate::retrospective::complete(&repo.root, id)
            } else {
                Ok(repo.details(project_binding::resolve(&repo.root).ok().as_ref()))
            }
        }

        Some("resolve") => Ok(repo.details(project_binding::resolve(&repo.root).ok().as_ref())),
        _ => Err("Unknown repository action".into()),
    }
}

fn registry() -> Result<Value> {
    let path = project_binding::state_root()?.join("discovery.json");
    Ok(crate::project_paths::optional_json(&path)?.unwrap_or_else(|| json!({"entries":[]})))
}

fn save_discovery(repo: &Repository, ignore: bool) -> Result<Value> {
    let state = project_binding::state_root()?;
    workspace_client::ensure_state(&state)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("project-enroll.lock"))?;
    lock.lock()?;
    if let Ok(binding) = project_binding::resolve(&repo.root)
        && binding.grant.is_some()
    {
        if ignore {
            return Err(
                "This checkout is connected. Pause capture through project controls.".into(),
            );
        }
        return Ok(repo.details(Some(&binding)));
    }
    let path = state.join("discovery.json");
    let mut file = registry()?;
    let entries = file["entries"]
        .as_array_mut()
        .ok_or("Invalid discovery state")?;
    let mut entry = repo.details(None);
    if ignore {
        entry["status"] = json!("ignored");
    }
    if let Some(old) = entries.iter_mut().find(|old| old["root"] == entry["root"]) {
        if old["status"] == "enrolled" {
            return Err(
                "The saved repository binding needs repair before changing discovery".into(),
            );
        }
        if !ignore && old["repositoryKey"] == entry["repositoryKey"] {
            return Ok(old.clone());
        }
        *old = entry.clone();
    } else {
        entries.push(entry.clone());
    }
    workspace_client::save_atomic(&path, &file)?;
    Ok(entry)
}
