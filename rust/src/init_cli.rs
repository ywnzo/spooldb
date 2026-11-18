use crate::{Result, discovery, project_binding, retrospective, workspace_client};
use serde_json::{Value, json};
use std::{
    io::{self, IsTerminal, Write},
    path::Path,
};

pub(crate) fn prompt(label: &str, default: &str) -> Result<String> {
    let mut output = io::stderr().lock();
    if default.is_empty() {
        write!(output, "{label}: ")?;
    } else {
        write!(output, "{label} [{default}]: ")?;
    }
    output.flush()?;
    let mut input = String::new();
    if io::stdin().read_line(&mut input)? == 0 {
        return Err("Setup cancelled at end of input".into());
    }
    let input = input.trim();
    Ok(if input.is_empty() { default } else { input }.to_owned())
}

pub(crate) fn confirm(label: &str) -> Result<bool> {
    Ok(matches!(
        prompt(label, "N")?.to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

fn choose<T>(label: &str, options: &[(String, T)]) -> Result<usize> {
    for (position, (description, _)) in options.iter().enumerate() {
        eprintln!("{}. {description}", position + 1);
    }
    let position = prompt(label, "1")?.parse::<usize>()?;
    position
        .checked_sub(1)
        .filter(|index| *index < options.len())
        .ok_or_else(|| "Choose one of the numbered options".into())
}

enum Plan {
    Existing,
    Join(String),
    Create(Option<String>),
    Invite,
    ProjectInvite(String),
}

pub fn run(
    cwd: &Path,
    mut selected: Option<String>,
    invite: Option<String>,
    device: &str,
) -> Result<Value> {
    if !io::stdin().is_terminal() {
        return Err("spool init requires an interactive terminal for sharing approval".into());
    }
    let root = project_binding::repository_root(cwd)?;
    eprintln!("SpoolDB · Connect this project\nFolder: {}", root.display());
    let repo = discovery::run(&json!({"command":"preview","cwd":root}))?;
    let already_connected = repo["status"] == "enrolled";
    let mut invitation = invite;
    if !already_connected && selected.is_none() && invitation.is_none() {
        let profiles = workspace_client::list_profiles()?;
        let mut options: Vec<_> = profiles["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                Some((
                    format!("{} · {}", entry["name"].as_str()?, entry["relay"].as_str()?),
                    Some(entry["id"].as_str()?.to_owned()),
                ))
            })
            .collect();
        options.push(("Use an invitation".into(), None));
        let index = if options.len() == 1 {
            0
        } else {
            choose("Choose the relay for this repository", &options)?
        };
        selected = options.swap_remove(index).1;
        if selected.is_none() {
            invitation = Some(prompt(
                "Paste a workspace or project invitation (Enter to cancel)",
                "",
            )?);
        }
    }

    let (plan, name) = loop {
        if let Some(link) = invitation.take() {
            if link.is_empty() {
                return Ok(json!({"cancelled":true}));
            }
            if workspace_client::is_workspace_invitation(&link)? {
                let preview = workspace_client::invite(&link, None)?;
                let name = preview["workspace"]["name"]
                    .as_str()
                    .unwrap_or("this workspace");
                if !confirm(&format!("Connect this computer to {name}?"))? {
                    return Ok(json!({"cancelled":true}));
                }
                let joined = workspace_client::invite(&link, Some(device))?;
                selected = Some(
                    joined["workspaceProfile"]
                        .as_str()
                        .ok_or("Workspace connection missing")?
                        .to_owned(),
                );
            } else {
                let preview = workspace_client::project_invitation(&link, None, device, false)?;
                let name = preview["project"]
                    .as_str()
                    .ok_or("Project invitation has no project")?
                    .to_owned();
                eprintln!("Relay: {}", preview["relay"].as_str().unwrap_or_default());
                break (Plan::ProjectInvite(link), name);
            }
        }
        if already_connected {
            eprintln!("Relay: {}", repo["workspace"].as_str().unwrap_or_default());
            break (
                Plan::Existing,
                repo["name"].as_str().unwrap_or("this project").to_owned(),
            );
        }
        let selector = selected
            .as_deref()
            .ok_or("Choose a relay or an invitation")?;
        let preview =
            discovery::run(&json!({"command":"preview","cwd":root,"workspace":selector}))?;
        let mut options = Vec::new();
        for project in preview["matches"].as_array().into_iter().flatten() {
            if let (Some(room), Some(name)) = (project["room"].as_str(), project["name"].as_str()) {
                options.push((
                    format!("Join {name} (matches this repository)"),
                    Plan::Join(room.into()),
                ));
            }
        }
        if options.is_empty() {
            if preview["canCreate"] == true {
                if preview["subprojectsSupported"] == true
                    && preview["relay"] == preview["parentCandidate"]["workspace"]
                    && let Some(room) = preview["parentCandidate"]["room"].as_str()
                {
                    let name = preview["parentCandidate"]["name"]
                        .as_str()
                        .unwrap_or("the enclosing project");
                    options.push((
                        format!("Create a subproject of {name}"),
                        Plan::Create(Some(room.into())),
                    ));
                }
                options.push((
                    "Create a separate shared project".into(),
                    Plan::Create(None),
                ));
            }
            for project in preview["projects"].as_array().into_iter().flatten() {
                if let (Some(room), Some(name)) =
                    (project["room"].as_str(), project["name"].as_str())
                {
                    options.push((format!("Join {name}"), Plan::Join(room.into())));
                }
            }
        }
        options.push(("Use an invitation".into(), Plan::Invite));
        eprintln!("Relay: {}", preview["relay"].as_str().unwrap_or_default());
        let index = choose("Choose an option", &options)?;
        let (description, plan) = options.swap_remove(index);
        match plan {
            Plan::Invite => {
                invitation = Some(prompt(
                    "Paste a workspace or project invitation (Enter to cancel)",
                    "",
                )?)
            }
            Plan::Create(_) => {
                break (
                    plan,
                    prompt("Project name", repo["name"].as_str().unwrap_or_default())?,
                );
            }
            _ => break (plan, description),
        }
    };

    eprintln!("Project: {name}");
    if !confirm("Connect this folder and enable shared project memory?")? {
        return Ok(json!({"cancelled":true}));
    }
    let share = !matches!(plan, Plan::Existing)
        && confirm("Also capture saved Codex conversations under this project’s sharing policy?")?;
    match plan {
        Plan::Existing => {}
        Plan::ProjectInvite(link) => {
            workspace_client::project_invitation(&link, Some(&root), device, share)?;
        }
        Plan::Join(room) => {
            discovery::run(
                &json!({"command":"approve","cwd":root,"workspace":selected,"confirm":true,"shareConversations":share,"room":room}),
            )?;
        }
        Plan::Create(parent) => {
            discovery::run(
                &json!({"command":"approve","cwd":root,"workspace":selected,"confirm":true,"shareConversations":share,"create":true,"name":name,"parentRoom":parent}),
            )?;
        }
        Plan::Invite => unreachable!("Invitations are converted to a project plan before approval"),
    }
    if retrospective::status(&root).is_ok_and(|status| status["status"] == "offered") {
        retrospective::choose(
            &root,
            confirm(
                "Analyze existing local Codex chats into durable project memory in a new session?",
            )?,
        )?;
    }
    let binding = project_binding::resolve(&root)?;
    eprintln!("Connected: {}", root.display());
    let codex_ready = if confirm("Connect this installation to Codex?")? {
        match install_codex() {
            Ok(()) => {
                eprintln!("Start a new Codex session and review any new SpoolDB hooks.");
                true
            }
            Err(error) => {
                eprintln!("Memory is connected. Codex setup needs attention: {error}");
                false
            }
        }
    } else {
        false
    };
    Ok(json!({"connected":true, "project":binding.info(),"codexReady":codex_ready}))
}

const CODEX_BEGIN: &str = "# BEGIN SPOOL DISCOVERY";
const CODEX_END: &str = "# END SPOOL DISCOVERY";

pub(crate) fn install_codex() -> Result<()> {
    install_codex_at(&project_binding::state_root()?, &std::env::current_exe()?)
}

pub(crate) fn install_codex_at(state: &Path, executable: &Path) -> Result<()> {
    use std::fs;
    let state = fs::canonicalize(state)?;
    let codex = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::home_dir().map(|home| home.join(".codex")))
        .ok_or("Could not find the Codex configuration directory")?;
    workspace_client::ensure_state(&codex)?;
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(codex.join(".spool-config.lock"))?;
    lock.lock()?;
    let config = codex.join("config.toml");
    let previous = match fs::symlink_metadata(&config) {
        Ok(entry) if entry.file_type().is_file() && entry.len() <= 2_000_000 => {
            fs::read_to_string(&config)?
        }
        Ok(_) => {
            return Err(
                "Codex config is not a regular configuration file or exceeds the size limit".into(),
            );
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let updated = codex_config(&previous, executable, &state)?;
    if updated == previous {
        return Ok(());
    }
    let backups = state.join("integration-backups");
    workspace_client::ensure_state(&backups)?;
    let unique = crate::private_files::random_id()?;
    crate::private_files::write_private(
        &backups.join(format!("global-codex-{unique}.toml")),
        previous.as_bytes(),
    )?;
    let staged = codex.join(format!(".spool-{unique}.toml"));
    crate::private_files::write_private(&staged, updated.as_bytes())?;
    if let Err(error) = fs::rename(&staged, &config) {
        let _ = fs::remove_file(staged);
        return Err(error.into());
    }
    Ok(())
}

fn codex_config(previous: &str, executable: &Path, state: &Path) -> Result<String> {
    let executable = executable
        .to_str()
        .ok_or("Invalid installed executable path")?;
    let state = state.to_str().ok_or("Invalid state path")?;
    if [executable, state]
        .iter()
        .any(|value| value.chars().any(char::is_control))
    {
        return Err("Control characters in installation paths are unsupported".into());
    }
    let prior = match (previous.find(CODEX_BEGIN), previous.find(CODEX_END)) {
        (None, None) => previous.to_owned(),
        (Some(start), Some(end)) if start < end => format!(
            "{}{}",
            &previous[..start],
            &previous[end + CODEX_END.len()..]
        ),
        _ => return Err("Incomplete managed SpoolDB configuration".into()),
    };
    if prior
        .lines()
        .any(|line| line.trim().starts_with("[plugins.") && line.contains("spooldb@"))
    {
        return Ok(if prior == previous {
            previous.to_owned()
        } else {
            prior
        });
    }
    if prior
        .lines()
        .any(|line| matches!(line.trim(), "[mcp_servers.spool]" | "[mcp_servers.spooldb]"))
    {
        return Err("Codex already has a separately managed SpoolDB MCP server".into());
    }
    let quoted = serde_json::to_string;
    let quote_shell = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let mut config = format!(
        "{}\n\n{CODEX_BEGIN}\n[mcp_servers.spool]\ncommand = {}\nargs = [\"project-mcp\"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n\n[mcp_servers.spool.env]\nSPOOL_STATE = {}\n",
        prior.trim_end(),
        quoted(executable)?,
        quoted(state)?
    );
    for event in ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt"] {
        let command = format!(
            "/usr/bin/env {} {} codex-hook {event}",
            quote_shell(&format!("SPOOL_STATE={state}")),
            quote_shell(executable)
        );
        config.push_str(&format!("\n[[hooks.{event}]]\n[[hooks.{event}.hooks]]\ntype = \"command\"\ncommand = {}\ntimeout = 3\n",quoted(command.as_str())?));
    }
    config.push_str(CODEX_END);
    config.push('\n');
    Ok(config)
}

pub fn command(args: &[std::ffi::OsString]) -> Result<()> {
    let mut selected = None;
    let mut invitation = None;
    let mut device = None;
    let mut print_json = false;
    let mut args = args.iter();
    while let Some(option) = args.next() {
        let option = option.to_str().ok_or("Invalid setup option")?;
        let (key, inline) = option
            .split_once('=')
            .map_or((option, None), |(key, value)| (key, Some(value)));
        let mut value = || -> Result<String> {
            inline
                .or_else(|| args.next().and_then(|arg| arg.to_str()))
                .filter(|value| !value.is_empty() && !value.starts_with("--"))
                .map(str::to_owned)
                .ok_or_else(|| format!("Missing value for {key}").into())
        };
        match key {
            "--workspace" => selected = Some(value()?),
            "--invite-file" => {
                use std::io::Read;
                let mut input = String::new();
                std::fs::File::open(value()?)?
                    .take(40_001)
                    .read_to_string(&mut input)?;
                if input.len() > 40_000 {
                    return Err("Invitation exceeds byte limit".into());
                }
                invitation = Some(input.trim().to_owned());
            }
            "--device" => device = Some(value()?),
            "--json" if inline.is_none() => print_json = true,
            "--help" if inline.is_none() => {
                println!(
                    "Usage: spool init [--workspace NAME] [--invite-file PATH] [--device NAME] [--json]"
                );
                return Ok(());
            }
            _ => return Err(format!("Unknown spool init option: {key}").into()),
        }
    }
    let device = device
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|value| value.trim().to_owned())
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Codex".into());
    let result = run(&std::env::current_dir()?, selected, invitation, &device)?;
    if print_json {
        println!("{result}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_configuration_preserves_other_integrations_and_is_idempotent() {
        let before = "model = \"example\"\n\n[mcp_servers.other]\ncommand = \"other\"\n";
        let binary = Path::new("/opt/spool app/spool-native");
        let state = Path::new("/home/alice's data/spool");
        let config = codex_config(before, binary, state).unwrap();
        assert!(config.starts_with(before.trim_end()));
        assert_eq!(config.matches("type = \"command\"").count(), 4);
        assert!(config.contains("args = [\"project-mcp\"]"));
        assert_eq!(codex_config(&config, binary, state).unwrap(), config);
        assert!(codex_config("[mcp_servers.spool]\ncommand = \"owned\"\n", binary, state).is_err());
    }
}
