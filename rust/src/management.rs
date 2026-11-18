use crate::{
    Result, local_web, private_files,
    project_binding::{self, Binding},
    project_init, workspace_client,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::{self, IsTerminal, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

struct Arguments<'a> {
    options: BTreeMap<&'a str, &'a str>,
    words: Vec<&'a str>,
    json: bool,
    invite_stdin: bool,
    no_capture: bool,
    no_agents: bool,
    yes: bool,
    create: bool,
    resume: bool,
    connect: Option<bool>,
    workers_ai: Option<bool>,
    dry_run: bool,
    can_create: Option<bool>,
}

impl<'a> Arguments<'a> {
    fn parse(values: &'a [OsString]) -> Result<Self> {
        let mut args = Self {
            options: BTreeMap::new(),
            words: Vec::new(),
            json: false,
            invite_stdin: false,
            no_capture: false,
            no_agents: false,
            yes: false,
            create: false,
            resume: false,
            connect: None,
            workers_ai: None,
            dry_run: false,
            can_create: None,
        };
        let mut next = values.iter();
        while let Some(value) = next.next() {
            let value = value.to_str().ok_or("Invalid CLI argument")?;
            let Some(option) = value.strip_prefix("--") else {
                args.words.push(value);
                continue;
            };
            let (key, inline) = option
                .split_once('=')
                .map_or((option, None), |(key, value)| (key, Some(value)));
            match key {
                "json" if inline.is_none() => args.json = true,
                "invite-stdin" if inline.is_none() => args.invite_stdin = true,
                "no-capture" if inline.is_none() => args.no_capture = true,
                "no-agents" if inline.is_none() => args.no_agents = true,
                "yes" if inline.is_none() => args.yes = true,
                "create" if inline.is_none() => args.create = true,
                "resume" if inline.is_none() => args.resume = true,
                "workers-ai" | "no-workers-ai" if inline.is_none() => {
                    let choice = key == "workers-ai";
                    if args.workers_ai.is_some_and(|prior| prior != choice) {
                        return Err("Choose --workers-ai or --no-workers-ai".into());
                    }
                    args.workers_ai = Some(choice);
                }
                "connect" | "no-connect" if inline.is_none() => {
                    let choice = key == "connect";
                    if args.connect.is_some_and(|prior| prior != choice) {
                        return Err("Choose --connect or --no-connect".into());
                    }
                    args.connect = Some(choice);
                }

                "dry-run" if inline.is_none() => args.dry_run = true,
                "allow-create" | "no-create" if inline.is_none() => {
                    let value = key == "allow-create";
                    if args.can_create.is_some_and(|prior| prior != value) {
                        return Err("Choose --allow-create or --no-create".into());
                    }
                    args.can_create = Some(value);
                }

                "server-state" | "state" | "root" | "workspace" | "project" | "device"
                | "invite-file" | "request-id" | "label" | "role" | "room" | "name" | "target"
                | "mode" | "deploy-dir" | "url" | "account-id" | "workspace-name" | "backend" => {
                    let value = inline
                        .or_else(|| next.next().and_then(|value| value.to_str()))
                        .filter(|value| !value.is_empty() && !value.starts_with("--"))
                        .ok_or_else(|| format!("Missing value for --{key}"))?;
                    args.options.insert(key, value);
                }
                _ => return Err(format!("Unknown option --{key}").into()),
            }
        }
        if let Some(state) = args.get("state") {
            crate::project_paths::STATE_OVERRIDE
                .set(std::path::absolute(state)?)
                .map_err(|_| "SpoolDB state already selected")?;
        }
        Ok(args)
    }

    fn get(&self, key: &str) -> Option<&'a str> {
        self.options.get(key).copied()
    }

    fn cwd(&self) -> Result<PathBuf> {
        Ok(self
            .get("root")
            .map(PathBuf::from)
            .map_or_else(std::env::current_dir, Ok)?)
    }

    fn bound(&self) -> Result<Binding> {
        if let Some(selector) = self.get("project") {
            let mut matches = local_web::projects()?.into_iter().filter(|binding| {
                local_web::public_project(binding)["id"] == selector
                    || binding.root.file_name().and_then(|part| part.to_str()) == Some(selector)
            });
            let binding = matches.next().ok_or("Selected project is unavailable")?;
            if matches.next().is_some() {
                return Err("Project selector is ambiguous. Use --root or the project ID".into());
            }
            if self.get("root").is_some()
                && project_binding::repository_root(&self.cwd()?)? != binding.root
            {
                return Err("Project selector differs from the current repository".into());
            }
            return Ok(binding);
        }
        project_binding::resolve(&self.cwd()?)
    }

    fn invitation(&self) -> Result<String> {
        let mut link = String::new();
        if let Some(file) = self.get("invite-file") {
            if self.invite_stdin {
                return Err("Choose one invitation input".into());
            }
            std::fs::File::open(file)?
                .take(40_001)
                .read_to_string(&mut link)?;
        } else if self.invite_stdin {
            io::stdin().take(40_001).read_to_string(&mut link)?;
        } else if io::stdin().is_terminal() {
            eprint!("Paste the private invitation link: ");
            io::stderr().flush()?;
            io::stdin().read_line(&mut link)?;
        } else {
            return Err("Pass --invite-stdin or --invite-file".into());
        }
        if link.len() > 40_000 || link.trim().is_empty() {
            return Err("Invalid invitation input".into());
        }
        Ok(link.trim().to_owned())
    }
}

fn workspace_selector(args: &Arguments<'_>, entries: &[Value]) -> Option<String> {
    args.get("workspace")
        .map(str::to_owned)
        .or_else(|| {
            args.bound().ok().and_then(|binding| {
                binding
                    .workspace_profile
                    .or_else(|| binding.grant.map(|grant| grant.url))
            })
        })
        .or_else(|| {
            if let [entry] = entries {
                entry["id"].as_str().map(str::to_owned)
            } else {
                None
            }
        })
}

fn selected_workspace(args: &Arguments<'_>) -> Result<String> {
    let profiles = workspace_client::list_profiles()?;
    let entries = profiles["workspaces"]
        .as_array()
        .ok_or("Invalid saved workspace list")?;
    workspace_selector(args, entries)
        .ok_or_else(|| "Choose a relay with --workspace or run this in a connected checkout".into())
}

fn shared_project(args: &Arguments<'_>, selected: &str, project: Option<&str>) -> Result<String> {
    let listed = workspace_client::action(selected, &json!({"command":"list"}))?;
    let projects = listed["projects"]
        .as_array()
        .ok_or("Invalid shared project list")?;
    let matches = if let Some(project) = project {
        let project_name = project.to_lowercase();
        projects
            .iter()
            .filter(|item| {
                item["room"] == project
                    || item["name"]
                        .as_str()
                        .is_some_and(|name| name.to_lowercase() == project_name)
            })
            .collect::<Vec<_>>()
    } else if let Some(grant) = args.bound().ok().and_then(|binding| binding.grant)
        && listed["relay"] == grant.url
    {
        projects
            .iter()
            .filter(|item| item["room"] == grant.room)
            .collect()
    } else if projects.len() == 1 {
        vec![&projects[0]]
    } else {
        Vec::new()
    };
    match matches.as_slice() {
        [room] => Ok(room["room"]
            .as_str()
            .ok_or("Invalid shared project room")?
            .to_owned()),
        [] => Err("Specify an available shared project name or ID".into()),
        _ => Err("The name matches multiple shared projects. Use the project ID".into()),
    }
}

fn finish_join(root: &Path, args: &Arguments<'_>, mut result: Value) -> Result<Value> {
    let binding = project_binding::resolve(root)?;
    let settings_path = binding.directory.join("integrations.json");
    let mut settings =
        crate::project_paths::optional_json::<Value>(&settings_path)?.unwrap_or_else(|| json!({}));
    if !settings.is_object() {
        return Err("Invalid integration settings".into());
    }
    settings["codex"] = json!(!args.no_capture);
    workspace_client::save_atomic(&settings_path, &settings)?;
    if !args.no_agents
        && let Err(error) = crate::init_cli::install_codex()
    {
        result["agentError"] = json!(error.to_string());
    }
    result["project"] = local_web::public_project(&binding);
    result["joined"] = json!(true);
    Ok(result)
}

fn sharing(args: &Arguments<'_>, selector: &str, room: Option<&str>) -> Result<Value> {
    use crate::init_cli::prompt;
    let mut query = json!({"command":if room.is_some(){"project-sharing"}else{"sharing"}});
    if let Some(room) = room {
        query["room"] = json!(room);
    }
    let current = workspace_client::action(selector, &query)?;
    if args.json || !io::stdin().is_terminal() {
        return Ok(current);
    }
    let key = if room.is_some() {
        "overrides"
    } else {
        "sharing"
    };
    let settings = current[key]
        .as_object()
        .ok_or("Relay sharing settings are unavailable")?;
    let mut edited = serde_json::Map::new();
    for (category, value) in settings {
        let choice = if room.is_some() {
            let default = match value.as_bool() {
                Some(true) => "shared",
                Some(false) => "private",
                None => "inherit",
            };
            let answer = prompt(&format!("{category} (shared/private/inherit)"), default)?;
            match answer.to_ascii_lowercase().as_str() {
                "shared" => Value::Bool(true),
                "private" => Value::Bool(false),
                "inherit" => Value::Null,
                _ => {
                    return Err(
                        "Choose shared, private, or inherit. Settings were not changed.".into(),
                    );
                }
            }
        } else {
            let default = if value == true { "Y" } else { "N" };
            let answer = prompt(&format!("Share {category}? (y/n)"), default)?;
            match answer.to_ascii_lowercase().as_str() {
                "yes" | "y" => Value::Bool(true),
                "no" | "n" => Value::Bool(false),
                _ => return Err("Answer yes or no. Settings were not changed.".into()),
            }
        };
        edited.insert(category.clone(), choice);
    }
    if &edited == settings {
        return Ok(current);
    }
    query["sharing"] = Value::Object(edited);
    query["expectedRevision"] = json!(
        current["sharingRevision"]
            .as_u64()
            .ok_or("Missing sharing revision")?
    );
    workspace_client::action(selector, &query)
}

fn usage(args: &Arguments<'_>, selector: &str) -> Result<Value> {
    let info =
        workspace_client::action(selector, &json!({"command":"retrieval","action":"status"}))?;
    let current = info
        .get("usage")
        .filter(|value| value.is_object())
        .ok_or("The selected relay does not expose usage statistics")?;
    if args.words.get(2) != Some(&"limits") {
        return Ok(current.clone());
    }
    if !io::stdin().is_terminal() {
        return Err("Run workspace usage limits in an interactive terminal".into());
    }
    let limits = current["limits"]
        .as_object()
        .ok_or("Relay usage limits are unavailable")?;
    let revision = limits
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or("Missing limits revision")?;
    let mut edited = serde_json::Map::new();
    for (key, label) in [
        ("dailyCharacters", "Daily external characters"),
        ("dailyRequests", "Daily external requests"),
        (
            "projectDailyCharacters",
            "Daily external characters per project",
        ),
    ] {
        let default = limits
            .get(key)
            .and_then(Value::as_u64)
            .ok_or("Missing relay usage limit")?
            .to_string();
        let value = crate::init_cli::prompt(&format!("{label} (0 = unlimited)"), &default)?
            .parse::<u64>()
            .ok()
            .filter(|value| *value <= 1_000_000_000)
            .ok_or("Enter a whole number from 0 to 1,000,000,000. Limits were not changed.")?;
        edited.insert(key.into(), json!(value));
    }
    let edited = workspace_client::action(
        selector,
        &json!({"command":"retrieval","action":"limits",
        "expectedRevision":revision,"limits":edited}),
    )?;
    Ok(edited["usage"].clone())
}

fn delete_conversations(args: &Arguments<'_>, selector: &str, room: &str) -> Result<Value> {
    let before = workspace_client::action(
        selector,
        &json!({"command":"delete-conversations","room":room}),
    )?;
    let count = before["messages"]
        .as_u64()
        .ok_or("Relay did not return a deletion preview")?;
    if args.dry_run || count == 0 {
        return Ok(before);
    }
    print_result(&before, args.json)?;
    if !args.yes {
        if !io::stdin().is_terminal() {
            return Err(
                "Deletion requires interactive confirmation or --yes after user approval".into(),
            );
        }
        if !crate::init_cli::confirm(&format!(
            "Delete {count} shared conversation messages from this project?"
        ))? {
            return Ok(json!({"cancelled":true}));
        }
    }
    let token = before["deletionToken"]
        .as_str()
        .ok_or("Missing deletion preview token")?;
    let id = args
        .get("request-id")
        .map(str::to_owned)
        .map_or_else(private_files::random_id, Ok)?;
    workspace_client::action(
        selector,
        &json!({"command":"delete-conversations","room":room,"confirm":true,
        "deletionToken":token,"requestId":id}),
    )
}

fn workspace_invite(args: &Arguments<'_>, selector: &str) -> Result<Value> {
    use crate::init_cli::prompt;
    let interactive = io::stdin().is_terminal() && !args.json;
    let label = match (args.get("label"), interactive) {
        (Some(label), _) => label.to_owned(),
        (None, true) => prompt("Name this invitation", "Teammate")?,
        _ => "Teammate".into(),
    };
    let role = match (args.get("role"), interactive) {
        (Some(role), _) => role.to_owned(),
        (None, true) => {
            eprintln!(
                "1. All projects, read and write\n2. All projects, read only\n3. Selected projects\n4. Workspace administrator"
            );
            match prompt("Choose access", "1")?.as_str() {
                "1" => "writer",
                "2" => "reader",
                "3" => "member",
                "4" => "admin",
                _ => return Err("Choose one of the numbered options".into()),
            }
            .to_owned()
        }
        _ => "member".into(),
    };
    if label.trim().is_empty() || label.encode_utf16().count() > 120 {
        return Err("Enter a name of 1–120 characters".into());
    }
    if !matches!(role.as_str(), "member" | "reader" | "writer" | "admin") {
        return Err("Choose member, reader, writer or admin".into());
    }
    let can_create = match args.can_create {
        Some(value) => value,
        None if interactive => crate::init_cli::confirm("Allow creating shared projects?")?,
        None => true,
    };
    workspace_client::action(
        selector,
        &json!({"command":"invite-member","label":label.trim(),"role":role,"canCreate":can_create}),
    )
}

fn workspace(args: &Arguments<'_>) -> Result<Value> {
    let action = args.words.get(1).copied().unwrap_or("status");
    if action == "switch" {
        return Err("Choose a saved connection with --workspace or bind it to this repository with spool init".into());
    }
    if action == "connect" {
        let device = args.get("device").unwrap_or("CLI client");
        return workspace_client::invite(&args.invitation()?, Some(device));
    }
    let profiles = workspace_client::list_profiles()?;
    if action == "saved" {
        return Ok(profiles);
    }
    let entries = profiles["workspaces"]
        .as_array()
        .ok_or("Invalid saved workspace list")?;
    let matched = workspace_selector(args, entries);
    let Some(selector) = matched else {
        if action == "status" {
            return Ok(
                json!({"connected":false,"selectionRequired":!entries.is_empty(),"workspaces":entries}),
            );
        }
        if entries.is_empty() && matches!(action, "projects" | "members") {
            return Ok(json!([]));
        }
        return Err("Choose a relay with --workspace or run this in a connected checkout".into());
    };
    match action {
        "disconnect" => return workspace_client::disconnect(&selector),
        "invite" => return workspace_invite(args, &selector),
        "revoke" => {
            let id = args.words.get(2).ok_or("Specify a member ID")?;
            return workspace_client::action(
                &selector,
                &json!({"command":"revoke-member","memberId":id}),
            );
        }
        _ => {}
    }
    if action == "sharing" {
        return sharing(args, &selector, None);
    }
    if action == "usage" {
        return usage(args, &selector);
    }
    if action == "create" {
        let name = args.words.get(2).ok_or("Specify the project name")?;
        let id = args
            .get("request-id")
            .map(str::to_owned)
            .map_or_else(private_files::random_id, Ok)?;
        return workspace_client::action(
            &selector,
            &json!({"command":"create","name":name,"requestId":id}),
        );
    }
    let listed = workspace_client::action(&selector, &json!({"command":"list"}))?;
    match action {
        "status" => Ok(listed),
        "projects" | "members" => Ok(listed[action]
            .as_array()
            .map_or_else(|| json!([]), |items| json!(items))),
        _ => Err("Unknown workspace action".into()),
    }
}

fn status(args: &Arguments<'_>) -> Result<Value> {
    match args.bound() {
        Ok(binding) => local_web::project_state(&binding),
        Err(error) if args.get("root").is_some() || args.get("project").is_some() => Err(error),
        Err(_) => {
            let state = project_binding::state_root()?;
            let service =
                crate::project_paths::optional_json::<Value>(&state.join("service.json"))?;
            Ok(
                json!({"running":service.is_some(),"setup":project_binding::registered_roots()?.is_empty(),
                "origin":service.and_then(|value|value["origin"].as_str().map(str::to_owned)),"repositoryConnected":false}),
            )
        }
    }
}

fn project(args: &Arguments<'_>) -> Result<Value> {
    let action = args.words.get(1).copied().unwrap_or("status");
    match action {
        "list" => Ok(
            json!({"projects":local_web::projects()?.iter().map(local_web::public_project).collect::<Vec<_>>()}),
        ),
        "status" => status(args),
        "select" => {
            let id = args
                .words
                .get(2)
                .copied()
                .ok_or("Specify a local project ID")?;
            let binding = local_web::projects()?
                .into_iter()
                .find(|binding| binding.local_id == id)
                .ok_or("Selected project is unavailable")?;
            let state = project_binding::state_root()?;
            workspace_client::save_atomic(&state.join("cli.json"), &json!({"project":id}))?;
            local_web::project_state(&binding)
        }
        "capture" => local_web::capture_project(&args.bound()?),
        "agents" => {
            args.bound()?;
            local_web::connect_agents()
        }

        "join-invite" => {
            let root = Path::new(
                args.words
                    .get(2)
                    .copied()
                    .or(args.get("root"))
                    .ok_or("Specify a local Git checkout")?,
            );
            let link = args.invitation()?;
            let result = workspace_client::project_invitation(
                &link,
                Some(root),
                args.get("device").unwrap_or("CLI client"),
                false,
            )?;
            finish_join(root, args, result)
        }
        "accept-invite" => {
            let selected = selected_workspace(args)?;
            workspace_client::action(
                &selected,
                &json!({"command":"accept-project","link":args.invitation()?}),
            )
        }
        "sharing" | "delete-conversations" => {
            let selected = selected_workspace(args)?;
            let room = shared_project(args, &selected, args.words.get(2).copied())?;
            if action == "sharing" {
                sharing(args, &selected, Some(&room))
            } else {
                delete_conversations(args, &selected, &room)
            }
        }
        "invite" | "connections" | "revoke" | "join" => {
            let selected = selected_workspace(args)?;
            let room = shared_project(args, &selected, args.words.get(2).copied())?;
            match action {
                "invite" => workspace_client::action(
                    &selected,
                    &json!({"command":"invite-project","room":room,
                    "label":args.get("label").unwrap_or("Teammate"),"role":args.get("role").unwrap_or("write")}),
                ),
                "join" => {
                    let root = Path::new(
                        args.words
                            .get(3)
                            .copied()
                            .or(args.get("root"))
                            .ok_or("Specify a local Git checkout")?,
                    );
                    project_init::initialize(root)?;
                    let result =
                        workspace_client::enroll_project(&selected, root, "join", &room, None)?;
                    finish_join(root, args, result)
                }
                _ => {
                    let data = workspace_client::action(
                        &selected,
                        &json!({"command":"project-members","room":room}),
                    )?;
                    if action == "connections" {
                        return Ok(data);
                    }
                    let selector = args
                        .words
                        .get(3)
                        .ok_or("Specify an active connection label")?;
                    let matching = data["members"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|member| {
                            (member["revoked"] == false || member["revoked"] == 0)
                                && (member["id"] == *selector || member["label"] == *selector)
                        })
                        .collect::<Vec<_>>();
                    let [member] = matching.as_slice() else {
                        return Err("Use a label or ID that matches one active connection".into());
                    };
                    workspace_client::action(
                        &selected,
                        &json!({"command":"revoke-project-member","room":room,"memberId":member["id"]}),
                    )
                }
            }
        }

        "add" => {
            let root = args
                .words
                .get(2)
                .copied()
                .or(args.get("root"))
                .ok_or("Specify a local Git checkout")?;
            let data = project_init::initialize(Path::new(root))?;
            let binding = project_binding::resolve(Path::new(root))?;
            Ok(json!({"project":local_web::public_project(&binding),"existing":data["existing"]}))
        }
        "pause" | "resume" => {
            let binding = args.bound()?;
            let path = binding.directory.join("integrations.json");
            let mut settings =
                crate::project_paths::optional_json::<Value>(&path)?.unwrap_or_else(|| json!({}));
            if !settings.is_object() {
                return Err("Invalid integration settings".into());
            }
            settings["codex"] = json!(action == "resume");
            workspace_client::save_atomic(&path, &settings)?;
            local_web::project_state(&binding)
        }
        _ => Err("Unknown project action".into()),
    }
}

fn discovery(args: &Arguments<'_>) -> Result<Value> {
    let action = args.words.get(1).copied().unwrap_or("list");
    if action == "enable" {
        return local_web::connect_agents();
    }
    let mut input = json!({"command":action});
    if action != "list" {
        let cwd = args
            .words
            .get(2)
            .map(PathBuf::from)
            .map_or_else(|| args.cwd(), Ok)?;
        input["cwd"] = json!(std::path::absolute(cwd)?);
    }
    if let Some(workspace) = args.get("workspace") {
        input["workspace"] = json!(workspace);
    }
    if action == "link-parent" {
        if !args.yes {
            if !io::stdin().is_terminal() {
                return Err("Use --yes after explicit approval to link projects".into());
            }
            if !crate::init_cli::confirm(
                "Link this project to its enclosing repository's shared project?",
            )? {
                return Ok(json!({"linked":false,"cancelled":true}));
            }
        }
        input["confirm"] = json!(true);
    }
    if action == "approve" {
        let selected = selected_workspace(args)?;
        input["workspace"] = json!(selected);
        if !args.yes {
            let mut preview = input.clone();
            preview["command"] = json!("preview");
            eprintln!(
                "{}",
                serde_json::to_string_pretty(&crate::discovery::run(&preview)?)?
            );
            if !io::stdin().is_terminal() {
                return Err("Use --yes after explicit user approval or run in a terminal".into());
            }
            if !crate::init_cli::confirm("Connect this checkout and share its project memory?")? {
                return Ok(json!({"connected":false,"cancelled":true}));
            }
        }
        input["confirm"] = json!(true);
        input["shareConversations"] = json!(false);
        input["create"] = json!(args.create);
        if let Some(room) = args.get("room") {
            input["room"] = json!(room);
        }
        if let Some(name) = args.get("name") {
            input["name"] = json!(name);
        }
    }
    crate::discovery::run(&input)
}

fn server(args: &Arguments<'_>) -> Result<Value> {
    let request = match args.words.as_slice() {
        ["server", "status"] => json!({"command":"list"}),
        ["server", "workspace", "init", name] => json!({"command":"workspace-init","name":name}),
        ["server", "workspace", "owner-invite"] => json!({"command":"workspace-owner-invite"}),
        ["server", "project", "create", name] => json!({"command":"create","name":name}),
        ["server", "project", "invite", room] => json!({"command":"create-invite","room":room,
            "label":args.get("label").unwrap_or("Teammate"),"role":args.get("role").unwrap_or("write")}),
        ["server", "project", "revoke", room, member] => {
            json!({"command":"revoke","room":room,"memberId":member})
        }
        _ => return Err(
            "Use spool server status, workspace init|owner-invite, or project create|invite|revoke"
                .into(),
        ),
    };
    if let Some(config) = std::env::var_os("SPOOL_CONTAINER_CONFIG") {
        return container_request(Path::new(&config), &request);
    }
    let directory = if let Some(path) = args
        .get("server-state")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("SPOOL_SERVER_STATE").map(PathBuf::from))
    {
        path
    } else if let Some(path) = crate::server_install::configured_state()? {
        path
    } else {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::home_dir().map(|home| home.join(".local/state")))
            .map(|state| state.join("spool-server"))
            .ok_or("Could not locate relay state. Pass --server-state.")?
    };
    crate::team_host::compatible_request(&directory, &request)
}

fn container_request(path: &Path, request: &Value) -> Result<Value> {
    let config: Value = crate::project_paths::optional_json(path)?
        .ok_or("Managed relay configuration is missing")?;
    let engine = match config["engine"].as_str() {
        Some(engine @ ("/usr/bin/docker" | "/usr/bin/podman"))
            if config["managedBy"] == "SpoolDB" =>
        {
            engine
        }
        _ => return Err("Invalid managed relay configuration".into()),
    };
    let program = if config["relayBackend"] == "rust" {
        &["/app/spool-native", "team-host"][..]
    } else {
        &["bun", "src/team-host.js"][..]
    };
    let mut child = Command::new(engine)
        .args(["exec", "-i", "spool-relay"])
        .args(program)
        .args(["request", "/data"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Could not write the host request")?;
    serde_json::to_writer(&mut stdin, request)?;
    drop(stdin);
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!(
            "Container relay administration exited with {}",
            output.status
        )
        .into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn service(args: &Arguments<'_>) -> Result<()> {
    let (scope, operation) = match args.words.as_slice() {
        [
            "service",
            scope @ ("client" | "server"),
            operation @ ("start" | "stop" | "restart" | "status" | "logs"),
        ] => (*scope, *operation),
        _ => return Err("Use spool service client|server start|stop|restart|status|logs".into()),
    };
    let system = scope == "server" && std::env::var("SPOOL_SYSTEM_SERVICE").as_deref() == Ok("1");
    let unit = if scope == "client" {
        "spool.service"
    } else {
        "spool-shared.service"
    };
    let program = if operation == "logs" {
        "journalctl"
    } else {
        "systemctl"
    };
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    if !system {
        command.arg("--user");
    }
    if operation == "logs" {
        command.args(["-u", unit, "-n", "100", "--no-pager"]);
    } else {
        command.args([operation, unit, "--no-pager"]);
    }
    let output = command.output()?;
    let text = String::from_utf8_lossy(&output.stdout);
    if !text.trim().is_empty() {
        println!("{}", text.trim_end());
    }
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Service command failed ({}): {}",
            output.status,
            error.trim()
        )
        .into());
    }
    Ok(())
}

pub fn run(values: &[OsString]) -> Result<()> {
    let args = Arguments::parse(values)?;
    if args.words.first().copied() == Some("service") {
        return service(&args);
    }
    if args.words.as_slice() == ["deploy", "cloudflare"] {
        let state = project_binding::state_root()?;
        let common = crate::cloudflare_deploy::Resume {
            state: &state,
            directory: args.get("deploy-dir"),
            name: args.get("name"),
            url: args.get("url"),
            connect: args.connect,
            json: args.json,
        };
        return if args.resume {
            crate::cloudflare_deploy::resume(common)
        } else {
            crate::cloudflare_publish::run(crate::cloudflare_publish::Publish {
                common,
                account: args.get("account-id"),
                workspace: args.get("workspace-name"),
                backend: args.get("backend"),
                ai: args.workers_ai,
                dry: args.dry_run,
                yes: args.yes,
            })
        };
    }
    if args.words.as_slice() == ["server", "setup", "advanced"] {
        return crate::server_install::advanced();
    }
    if args.words.as_slice() == ["server", "setup"] {
        let executable = std::env::current_exe()?;
        let bundle = executable
            .parent()
            .and_then(Path::parent)
            .ok_or("Could not locate the installer bundle")?;
        return crate::server_install::setup(bundle);
    }
    if args.words.as_slice() == ["server", "control"] {
        let config = std::env::var_os("SPOOL_CONTAINER_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/opt/spooldb/containers.json"));
        return crate::relay_control::serve(&config);
    }
    let outcome = match args.words.first().copied() {
        Some("workspace") => workspace(&args)?,
        Some("project") => project(&args)?,
        Some("status") => status(&args)?,
        Some("discovery") => discovery(&args)?,
        Some("server") => server(&args)?,
        Some("plugin") if args.words.as_slice() == ["plugin", "install"] => {
            crate::plugin_install::install()?
        }
        Some("update")
            if args.get("target") == Some("relay")
                || std::env::var_os("SPOOL_CONTAINER_CONFIG").is_some() =>
        {
            crate::relay_update::cli(
                args.words.get(1).copied().unwrap_or(""),
                args.yes,
                args.dry_run,
            )?
        }
        Some("update") => crate::client_update::run(
            &project_binding::state_root()?,
            args.words.get(1).copied().unwrap_or(""),
            args.get("target"),
            args.get("mode"),
            args.yes,
        )?,
        _ => return Err("Use spool workspace, project or status".into()),
    };
    print_result(&outcome, args.json)
}

fn print_result(outcome: &Value, json: bool) -> Result<()> {
    if json {
        println!("{outcome}");
    } else if let Some(link) = outcome["browserLink"]
        .as_str()
        .or_else(|| outcome["link"].as_str())
    {
        println!("{link}");
        if let Some(expires) = outcome["expiresAt"].as_str() {
            println!("Expires: {expires}");
        }
    } else {
        println!("{}", serde_json::to_string_pretty(outcome)?);
    }
    Ok(())
}
