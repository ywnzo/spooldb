pub(crate) use crate::private_files::save_atomic;
use crate::{
    Result,
    project_binding::state_root,
    project_init::{private_dir, save},
    relay_client::workspace_request,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use url::Url;

#[derive(Deserialize, Serialize)]
struct Invitation {
    version: u8,
    url: String,
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ca: Option<String>,
}

fn parse(link: &str, workspace: bool) -> Result<Invitation> {
    if link.len() > 40_000 {
        return Err("Invalid workspace invitation".into());
    }
    let url = Url::parse(link).map_err(|_| "Invalid workspace invitation")?;
    let invite_host = if workspace { "workspace" } else { "join" };
    let encoded = match url.scheme() {
        "spool" | "threadweave" if url.host_str() == Some(invite_host) => {
            url.path().strip_prefix("/v1/")
        }
        "http" | "https" if url.path() == "/join" => url.fragment().and_then(|value| {
            if workspace {
                value.strip_prefix("workspace.")
            } else {
                Some(value)
            }
        }),
        _ => None,
    }
    .ok_or("Expected a SpoolDB invitation")?;
    let payload = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Invalid workspace invitation")?;
    let mut invite: Invitation =
        serde_json::from_slice(&payload).map_err(|_| "Invalid workspace invitation")?;
    if invite.version != 1 || !crate::workspace::valid_token(&invite.code) {
        return Err("Invalid workspace invitation".into());
    }
    invite.url = origin(&invite.url)?;
    if matches!(url.scheme(), "https" | "http") && url.origin().ascii_serialization() != invite.url
    {
        return Err("Invitation domain differs from its relay".into());
    }
    Ok(invite)
}

pub(crate) fn retarget_invitation(link: &str, url: &str) -> Result<String> {
    let mut invite = parse(link, true)?;
    invite.url = origin(url)?;
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invite)?);
    Ok(format!("spool://workspace/v1/{encoded}"))
}

fn origin(url: &str) -> Result<String> {
    let parsed = Url::parse(url).map_err(|_| "Invalid workspace relay")?;
    if !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Invalid workspace relay origin".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(crate) fn ensure_state(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path.parent().ok_or("Invalid SpoolDB state directory")?)?;
    ensure_folder(path)
}

fn ensure_folder(path: &Path) -> Result<()> {
    if !path.is_dir() {
        match private_dir(path) {
            Ok(()) => (),
            Err(err)
                if err
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::AlreadyExists)
                    && path.is_dir() => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

pub fn is_workspace_invitation(link: &str) -> Result<bool> {
    let url = Url::parse(link).map_err(|_| "Expected a SpoolDB invitation")?;
    Ok(
        matches!(url.scheme(), "spool" | "threadweave") && url.host_str() == Some("workspace")
            || matches!(url.scheme(), "https" | "http")
                && url
                    .fragment()
                    .is_some_and(|fragment| fragment.starts_with("workspace.")),
    )
}

pub(crate) fn check_invitation(link: &str) -> Result<()> {
    parse(link, is_workspace_invitation(link)?)?;
    Ok(())
}

pub fn invite(link: &str, device: Option<&str>) -> Result<Value> {
    let invite = parse(link, true)?;
    let Some(device) = device else {
        return Ok(workspace_request(
            &invite.url,
            invite.ca.as_deref(),
            &invite.code,
            "preview",
            &json!({}),
        )?);
    };
    let device = device.trim();
    if device.is_empty() || device.encode_utf16().count() > 120 {
        return Err("Enter a device name up to 120 characters".into());
    }
    let state = state_root()?;
    fs::create_dir_all(state.parent().ok_or("Invalid state directory")?)?;
    ensure_folder(&state)?;
    let attempts = state.join("workspace-enrollment");
    let profiles = state.join("workspace-profiles");
    ensure_folder(&attempts)?;
    ensure_folder(&profiles)?;
    let attempt_id = hash(&format!("{}{}", invite.url, invite.code));
    let path = attempts.join(format!("{attempt_id}.json"));
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(attempts.join(format!("{attempt_id}.lock")))?;
    lock.lock()?;
    let mut attempt: Value = if path.try_exists()? {
        serde_json::from_slice(&fs::read(&path)?)?
    } else {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes)?;
        let value = json!({"claim":URL_SAFE_NO_PAD.encode(bytes)});
        save_atomic(&path, &value)?;
        value
    };
    if attempt["connection"].is_null() {
        let claim = attempt["claim"]
            .as_str()
            .filter(|claim| crate::workspace::valid_token(claim))
            .ok_or("Saved invitation claim is invalid")?;
        let enrolled = workspace_request(
            &invite.url,
            invite.ca.as_deref(),
            &invite.code,
            "enroll",
            &json!({"claim":claim,"device":device}),
        )?;
        let mut connection = enrolled["connection"].clone();
        if origin(connection["url"].as_str().ok_or("Missing enrolled relay")?)? != invite.url {
            return Err("Enrolled relay differs from the invitation".into());
        }
        connection["url"] = json!(invite.url);
        if let Some(ca) = &invite.ca {
            connection["ca"] = json!(ca);
        }
        attempt["connection"] = connection;
        save_atomic(&path, &attempt)?;
    }
    let connection = &attempt["connection"];
    if origin(connection["url"].as_str().ok_or("Missing saved relay")?)? != invite.url {
        return Err("Saved relay differs from the invitation".into());
    }
    let token = connection["token"]
        .as_str()
        .ok_or("Missing workspace grant")?;
    let mut listed = workspace_request(
        &invite.url,
        connection["ca"].as_str(),
        token,
        "action",
        &json!({"command":"list"}),
    )?;
    let workspace_id = listed["workspace"]["id"]
        .as_str()
        .ok_or("Missing workspace identity")?;
    let profile_id = hash(&format!("{}#{workspace_id}", invite.url));
    save_atomic(
        &profiles.join(format!("{profile_id}.json")),
        &json!({
            "id":profile_id,"workspace":listed["workspace"],"member":listed["member"],"connection":connection
        }),
    )?;
    listed["connected"] = json!(true);
    listed["relay"] = json!(invite.url);
    listed["workspaceProfile"] = json!(profile_id);
    Ok(listed)
}

#[derive(Deserialize, Serialize)]
struct Profile {
    id: String,
    workspace: Value,
    member: Value,
    connection: WorkspaceGrant,
}

#[derive(Deserialize, Serialize)]
struct WorkspaceGrant {
    url: String,
    token: String,
    ca: Option<String>,
}

fn read_profiles(path: &Path) -> Result<Vec<Profile>> {
    use std::io::Read;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut profiles = Vec::new();
    for entry in entries {
        let entry = entry?;
        let filename = entry.file_name();
        let Some(id) = filename
            .to_str()
            .and_then(|s| s.strip_suffix(".json"))
            .filter(|id| {
                id.len() == 64
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        else {
            continue;
        };
        if !entry.file_type()?.is_file() {
            continue;
        }
        let mut bytes = Vec::new();
        fs::File::open(entry.path())?
            .take(65_537)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 65_536 {
            return Err("Workspace profile exceeds byte limit".into());
        }
        let profile: Profile =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid workspace profile")?;
        if profile.id != id {
            return Err("Workspace profile identity mismatch".into());
        }
        profiles.push(profile);
    }
    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(profiles)
}

fn profiles() -> Result<Vec<Profile>> {
    let state = state_root()?;
    let directory = state.join("workspace-profiles");
    let legacy = state.join("workspace.json");
    if !legacy.try_exists()? {
        return read_profiles(&directory);
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("workspace-migration.lock"))?;
    lock.lock()?;
    let current = read_profiles(&directory)?;
    let Some(mut grant) = crate::project_paths::optional_json::<WorkspaceGrant>(&legacy)? else {
        return Ok(current);
    };
    grant.url = origin(&grant.url)?;
    if !crate::workspace::valid_token(&grant.token) {
        return Err("Invalid saved workspace credential".into());
    }
    if !current
        .iter()
        .any(|item| item.connection.url == grant.url && item.connection.token == grant.token)
    {
        let data = workspace_request(
            &grant.url,
            grant.ca.as_deref(),
            &grant.token,
            "action",
            &json!({"command":"list"}),
        );
        let (workspace, member) = match data {
            Ok(data) if data["workspace"]["id"].is_string() => {
                (data["workspace"].clone(), data["member"].clone())
            }
            _ => {
                let label = Url::parse(&grant.url)?
                    .host_str()
                    .unwrap_or_default()
                    .to_owned();
                (
                    json!({"id":format!("unverified-{}",hash(&grant.token)),"name":format!("Saved connection at {label}")}),
                    Value::Null,
                )
            }
        };
        let workspace_id = workspace["id"]
            .as_str()
            .ok_or("Missing saved workspace identity")?;
        let id = hash(&format!("{}#{workspace_id}", grant.url));
        if !current.iter().any(|item| item.id == id) {
            ensure_folder(&directory)?;
            let path = directory.join(format!("{id}.json"));
            let profile = Profile {
                id,
                workspace,
                member,
                connection: grant,
            };
            let staged = directory.join(format!(
                ".profile-{}.tmp",
                crate::private_files::random_id()?
            ));
            save(&staged, &serde_json::to_value(profile)?)?;
            let saved = fs::hard_link(&staged, path);
            let _ = fs::remove_file(staged);
            match saved {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    read_profiles(&directory)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    let backup = state.join(format!(
        "workspace.json.migrated-{}",
        crate::private_files::random_id()?
    ));
    match fs::rename(&legacy, backup) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    read_profiles(&directory)
}

pub fn list_profiles() -> Result<Value> {
    let items: Vec<_> = profiles()?
        .into_iter()
        .map(|profile| {
            json!({
                "id":profile.id, "name":profile.workspace["name"],"role":profile.member["role"],
                "relay":profile.connection.url
            })
        })
        .collect();
    Ok(json!({"workspaces":items}))
}

fn select_profile<'a>(profiles: &'a [Profile], selector: &str) -> Result<&'a Profile> {
    let exact = profiles.iter().find(|profile| profile.id == selector);
    Ok(if let Some(exact) = exact {
        exact
    } else {
        let mut matching = profiles.iter().filter(|profile| {
            profile.connection.url == selector
                || profile.workspace["name"]
                    .as_str()
                    .is_some_and(|name| name.to_lowercase() == selector.to_lowercase())
        });
        let found = matching
            .next()
            .ok_or("Saved workspace profile is unavailable")?;
        if matching.next().is_some() {
            return Err("Workspace name or relay is ambiguous. Use its profile ID.".into());
        }
        found
    })
}

pub fn disconnect(selector: &str) -> Result<Value> {
    let profiles = profiles()?;
    let profile = select_profile(&profiles, selector)?;
    let path = state_root()?
        .join("workspace-profiles")
        .join(format!("{}.json", profile.id));
    match fs::remove_file(path) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    Ok(
        json!({"connected":false,"removedConnection":profile.id,"workspaces":list_profiles()?["workspaces"]}),
    )
}

pub fn action(selector: &str, body: &Value) -> Result<Value> {
    let profiles = profiles()?;
    let profile = select_profile(&profiles, selector)?;
    let grant = &profile.connection;
    let mut result = workspace_request(
        &grant.url,
        grant.ca.as_deref(),
        &grant.token,
        "action",
        body,
    )?;
    result["connected"] = json!(true);
    result["workspaceProfile"] = json!(profile.id);
    result["relay"] = json!(grant.url);
    Ok(result)
}

pub fn enroll_project(
    selector: &str,
    cwd: &Path,
    mode: &str,
    target: &str,
    parent_path: Option<&Path>,
) -> Result<Value> {
    use crate::project_binding::{git, repository_key, repository_root, resolve};
    let root = repository_root(cwd)?;
    let key = git(&root, &["remote", "get-url", "origin"])
        .ok()
        .and_then(|remote| repository_key(&remote));
    let listing = action(selector, &json!({"command":"list"}))?;
    let selected = listing["workspaceProfile"]
        .as_str()
        .ok_or("Missing workspace profile")?;
    let relay = listing["relay"].as_str().ok_or("Missing workspace relay")?;
    let state = fs::canonicalize(state_root()?)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("project-enroll.lock"))?;
    lock.lock()?;
    let binding = resolve(&root)?;
    if let Some(existing) = &binding.grant {
        if mode == "join" && existing.room == target && origin(&existing.url)? == origin(relay)? {
            return Ok(json!({"project":binding.info(),"existing":true}));
        }
        return Err("This repository already has a saved relay grant".into());
    }
    let parent = if let Some(path) = parent_path {
        if mode != "create"
            || !listing["capabilities"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|v| v == "subprojects-v1")
        {
            return Err(
                "Creating a linked subproject requires an updated relay and create mode".into(),
            );
        }
        let parent = resolve(path)?;
        let grant = parent
            .grant
            .as_ref()
            .ok_or("The parent repository needs a saved relay grant")?;
        if parent.root == root
            || !root.starts_with(&parent.root)
            || origin(&grant.url)? != origin(relay)?
        {
            return Err("Choose an enclosing parent repository on the same relay".into());
        }
        Some(json!({"root":parent.root,"room":grant.room}))
    } else {
        None
    };
    let room = match (mode, key.as_deref()) {
        ("create", Some(key)) => {
            if !listing["capabilities"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|v| v == "repository-enrollment-v2")
            {
                return Err("Update the relay before creating repository projects".into());
            }
            let found = action(
                selected,
                &json!({"command":"repository-match","repositoryKey":key}),
            )?;
            if found["ambiguous"] == true || !found["project"].is_null() {
                return Err("This Git repository already has a shared project. Choose an existing project to join.".into());
            }
            let request = hash(&json!([root, key, selected, target, parent]).to_string());
            let mut input = json!({"command":"repository-enroll","repositoryKey":key,
                "mode":"create","name":target,"requestId":format!("native-{request}")});
            if let Some(parent) = &parent {
                input["parentRoom"] = parent["room"].clone();
            }
            let created = action(selected, &input)?;
            if created["enrollmentMode"] != "create" {
                return Err(
                    "A shared project already exists. Choose it explicitly before joining.".into(),
                );
            }
            if let Some(parent) = &parent
                && created["project"]["parentRoom"] != parent["room"]
            {
                return Err("The relay did not confirm the requested parent".into());
            }
            created["project"]["room"]
                .as_str()
                .ok_or("Missing created project")?
                .to_owned()
        }
        ("create", None) => {
            return Err("Set a supported Git origin before creating a shared project".into());
        }
        ("join", key) if crate::relay::valid_room(target) => {
            if let Some(key) = key {
                action(
                    selected,
                    &json!({"command":"repository-enroll","repositoryKey":key,
                    "mode":"join","room":target}),
                )?;
            }
            target.to_owned()
        }
        _ => return Err("Choose create NAME or join PROJECT_ID".into()),
    };
    let joined = action(selected, &json!({"command":"join","room":room}))?;
    let grant = &joined["connection"];
    let grant_url = grant["url"].as_str().ok_or("Missing project grant relay")?;
    let _: crate::relay_client::ConnectionOptions =
        serde_json::from_value(grant.clone()).map_err(|_| "Invalid project relay grant")?;
    if origin(grant_url)? != origin(relay)? || grant["room"] != room {
        return Err("The project grant differs from the selected project".into());
    }
    save_binding(&state, &binding, grant, Some(selected), parent)?;
    Ok(json!({"project":resolve(&root)?.info(),"existing":false}))
}

fn save_binding(
    state: &Path,
    binding: &crate::project_binding::Binding,
    grant: &Value,
    profile: Option<&str>,
    parent: Option<Value>,
) -> Result<()> {
    let root = &binding.root;
    let key = crate::project_binding::git(root, &["remote", "get-url", "origin"])
        .ok()
        .and_then(|remote| crate::project_binding::repository_key(&remote));
    let discovery_path = state.join("discovery.json");
    let mut discovery: Value = match fs::read(&discovery_path) {
        Ok(bytes) if bytes.len() <= 4_000_000 => serde_json::from_slice(&bytes)?,
        Ok(_) => return Err("Repository discovery exceeds byte limit".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({"entries":[]}),
        Err(error) => return Err(error.into()),
    };
    let entries = discovery["entries"]
        .as_array_mut()
        .ok_or("Invalid discovery state")?;
    let mut entry = json!({"id":hash(root.to_str().ok_or("Invalid repository path")?),"root":root,
        "name":root.file_name(),"repositoryKey":key,"status":"enrolled","workspace":grant["url"],
        "workspaceProfile":profile,"room":grant["room"],"projectId":binding.local_id});
    if let Some(parent) = parent {
        entry["parent"] = parent;
    }
    if let Some(old) = entries
        .iter_mut()
        .find(|value| value["root"] == entry["root"])
    {
        if old["status"] != "pending" {
            return Err(
                "Repository enrollment state changed. Review the binding before retrying.".into(),
            );
        }
        *old = entry;
    } else {
        entries.push(entry);
    }
    let team = binding.directory.join("team.json");
    save(&team, grant)?;
    if let Err(error) = save_atomic(&discovery_path, &discovery) {
        let _ = fs::remove_file(team);
        return Err(error);
    }
    Ok(())
}

pub fn project_invitation(
    link: &str,
    cwd: Option<&Path>,
    device: &str,
    capture: bool,
) -> Result<Value> {
    let invite = parse(link, false)?;
    let call = |action: &str, input: &Value| {
        crate::relay_client::project_invite(
            &invite.url,
            invite.ca.as_deref(),
            &invite.code,
            action,
            input,
        )
    };
    let Some(cwd) = cwd else {
        let mut preview = call("preview", &json!({}))?;
        preview["relay"] = json!(invite.url);
        preview["privateCertificate"] = json!(invite.ca.is_some());
        return Ok(preview);
    };
    let device = device.trim();
    if device.is_empty() || device.encode_utf16().count() > 120 {
        return Err("Enter a device name up to 120 characters".into());
    }
    crate::project_init::initialize(cwd)?;
    let state = fs::canonicalize(state_root()?)?;
    let enrollment_lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("project-enroll.lock"))?;
    enrollment_lock.lock()?;
    let binding = crate::project_binding::resolve(cwd)?;
    let attempts = binding.directory.join("join-attempts");
    ensure_folder(&attempts)?;
    let id = hash(&format!("{}{}", invite.url, invite.code));
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(attempts.join(format!("{id}.lock")))?;
    lock.lock()?;
    let path = attempts.join(format!("{id}.json"));
    let mut attempt: Value = if path.try_exists()? {
        serde_json::from_slice(&fs::read(&path)?)?
    } else {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes)?;
        let value = json!({"claim":URL_SAFE_NO_PAD.encode(bytes)});
        save_atomic(&path, &value)?;
        value
    };
    if binding.grant.is_some() && attempt["connection"].is_null() {
        return Err("This repository already has a relay connection".into());
    }
    if attempt["connection"].is_null() {
        let result = call("redeem", &json!({"claim":attempt["claim"],"device":device}))?;
        attempt["connection"] = result["connection"].clone();
        save_atomic(&path, &attempt)?;
    }
    let mut grant = attempt["connection"].clone();
    let pinned = invite.ca.as_deref();
    if origin(grant["url"].as_str().ok_or("Missing project relay")?)? != invite.url {
        return Err("Project grant differs from the invitation".into());
    }
    if let Some(ca) = pinned {
        grant["ca"] = json!(ca);
    }
    let options: crate::relay_client::ConnectionOptions =
        serde_json::from_value(grant.clone()).map_err(|_| "Invalid project relay grant")?;
    if let Some(existing) = &binding.grant {
        if origin(&existing.url)? != invite.url
            || existing.room != options.room
            || existing.token != options.token
        {
            return Err("This repository already has a different relay grant".into());
        }
    } else {
        crate::relay_client::Client::new(options)?.request("state", None)?;
        save_binding(&state, &binding, &grant, None, None)?;
    }
    if capture {
        save_atomic(
            &binding.directory.join("integrations.json"),
            &json!({"codex":true}),
        )?;
    }
    Ok(
        json!({"joined":true,"project":{"id":binding.local_id,"root":binding.root,"name":binding.root.file_name()}}),
    )
}
