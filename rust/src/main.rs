mod adapter_ingress;
mod adapter_runner;
#[path = "../shared/bundle_export.rs"]
mod bundle_export;
mod bundles;
mod capture;
mod capture_export;
mod client_update;
mod cloudflare_deploy;
mod cloudflare_publish;
mod codex_history;
mod codex_hooks;
mod companion;
#[path = "../shared/deletion.rs"]
mod deletion;
mod desktop_install;
mod desktop_launch;
mod discovery;
mod documents;
mod embeddings;
mod git_bridge;
mod git_evidence;
mod init_cli;
mod local_embeddings;
mod local_source;
mod local_web;
mod management;
mod manifest;
mod mcp;
mod memory_cli;
#[path = "../shared/memory_context.rs"]
mod memory_context;
mod memory_index;
#[path = "../shared/memory_mutation.rs"]
mod memory_mutation;
#[path = "../shared/memory_page.rs"]
mod memory_page;
#[path = "../shared/memory_record.rs"]
mod memory_record;
#[path = "../shared/memory_search.rs"]
mod memory_search;
#[path = "../shared/memory_write.rs"]
mod memory_write;
mod native_memory;
mod plugin_entry;
mod plugin_install;
mod plugin_migration;
mod private_files;
mod project_binding;
mod project_init;
mod project_paths;
#[path = "../shared/radix.rs"]
mod radix;
mod relay;
mod relay_apply;
mod relay_artifacts;
mod relay_client;
mod relay_control;
mod relay_ops;
mod relay_recovery;
mod relay_retention;
mod relay_tls;
mod relay_update;
mod relay_volume;
mod release_download;
mod retrieval_settings;
mod retrospective;
#[path = "../shared/review.rs"]
mod review;
#[path = "../shared/review_diff.rs"]
mod review_diff;
mod server_install;
#[path = "../shared/shard_message.rs"]
mod shard_message;
mod shards;
mod snapshots;
#[path = "../shared/source.rs"]
mod source;
mod storage_cli;
mod storage_legacy;
mod storage_submit;
mod sync;
mod team_host;
#[path = "../shared/vectors.rs"]
mod vectors;
mod vps_install;
#[path = "../shared/workspace.rs"]
mod workspace;
mod workspace_client;

use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{env, error::Error, io::Read, path::Path, process::ExitCode};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn validate_frontier(db: &Transaction<'_>, room: &str) -> Result<()> {
    let (heads, indexed): (String, Option<String>) = db.query_row(
        "SELECT r.heads, i.heads FROM shard_refs r LEFT JOIN memory_index i ON i.room=r.room
         WHERE r.name=?1 AND r.room=?2",
        params![format!("relay-{room}"), room],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if indexed.as_deref() != Some(format!("retrieval-v3:{heads}").as_str()) {
        return Err(
            "Memory index is missing or stale. Refresh it with the memory-index command.".into(),
        );
    }
    Ok(())
}

fn get_indexed(db: &Transaction<'_>, room: &str, id: &str) -> Result<Value> {
    let (data, title, text, task_id, sequence, lifecycle): (String, String, String, Option<String>, i64, Option<String>) =
        db.query_row(
            "SELECT d.data,d.title,d.text,d.task_id,d.seq,s.data
             FROM memory_docs d LEFT JOIN memory_state s ON s.room=d.room AND s.id=d.id
             WHERE d.room=?1 AND d.id=?2 AND COALESCE(json_extract(d.data,'$.lifecycleControl'),0)<>1",
            params![room, id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)),
        )?;
    let mut record: Value = serde_json::from_str(&data)?;
    let fields = record.as_object_mut().ok_or("Invalid memory record")?;
    for (key, value) in [
        ("title", json!(title)),
        ("text", json!(text)),
        ("taskId", json!(task_id)),
        ("sequence", json!(sequence)),
        (
            "lifecycle",
            match lifecycle {
                Some(state) => serde_json::from_str(&state)?,
                None => json!({"status":"active","revision":0}),
            },
        ),
    ] {
        fields.insert(key.into(), value);
    }
    Ok(record)
}

fn search(db: &Transaction<'_>, room: &str, query: &str) -> Result<Value> {
    if query.encode_utf16().count() > 1000 {
        return Err("Search must be at most 1000 characters".into());
    }
    let mut tokens = Vec::new();
    for token in query.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-') {
        if token.chars().any(char::is_alphanumeric) && !tokens.contains(&token) {
            tokens.push(token);
            if tokens.len() == 16 {
                break;
            }
        }
    }
    if tokens.is_empty() {
        return Ok(json!({"results":[]}));
    }
    let expression = tokens
        .iter()
        .map(|token| format!(r#""{token}""#))
        .collect::<Vec<_>>()
        .join(" OR ");
    let mut statement = db.prepare(
        "SELECT d.id FROM memory_fts
         JOIN memory_docs d ON d.room=memory_fts.room AND d.id=memory_fts.id
         LEFT JOIN memory_state s ON s.room=d.room AND s.id=d.id
         WHERE memory_fts MATCH ?1 AND d.room=?2
         AND d.kind IN ('finding','decision','blocker','handoff')
         AND COALESCE(json_extract(d.data,'$.lifecycleControl'),0)<>1
         AND COALESCE(s.status,'active') NOT IN ('archived','resolved','superseded')
         AND NOT EXISTS (
           SELECT 1 FROM memory_docs task WHERE task.room=d.room AND task.task_id=d.task_id
           AND task.kind='task'
           AND instr(task.text, 'Current request (source text, not verified findings):'||char(10)||
             'This is an app-generated request for a suggested next user message. The user did not write this message.')=1
         )
         ORDER BY bm25(memory_fts,0,0,3,1),d.seq DESC LIMIT 10",
    )?;
    let ids = statement.query_map(params![expression, room], |row| row.get::<_, String>(0))?;
    let records = ids
        .map(|id| get_indexed(db, room, &id?))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"results":records}))
}

fn version() -> Result<String> {
    let package: Value = serde_json::from_str(include_str!("../../package.json"))?;
    Ok(package["version"]
        .as_str()
        .ok_or("Missing version")?
        .to_owned())
}

fn run() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if let [command, bundle] = args.as_slice()
        && command == "server-setup"
    {
        return server_install::setup(std::path::Path::new(bundle));
    }
    if let [command, bundle, domain, automatic] = args.as_slice()
        && command == "vps-install"
    {
        return vps_install::run(
            std::path::Path::new(bundle),
            domain.to_str().ok_or("Invalid relay domain")?,
            automatic == "automatic",
        );
    }
    if let [command, bundle, options @ ..] = args.as_slice()
        && command == "desktop-install"
    {
        return desktop_install::run(std::path::Path::new(bundle), options);
    }
    if args.is_empty()
        || args
            .first()
            .is_some_and(|command| command == "help" || command == "--help")
    {
        println!(
            "SpoolDB • shared project memory\n\nspool open | init | project | workspace | memory | discovery | service | update\nspool deploy cloudflare | server | storage DATABASE\n\nRun spool init from a Git checkout to connect a project."
        );
        return Ok(());
    }
    if args.first().is_some_and(|command| command == "open") {
        return desktop_launch::run(&args[1..]);
    }
    if let [command, config] = args.as_slice()
        && command == "update-scheduled"
    {
        println!(
            "{}",
            client_update::scheduled(std::path::Path::new(config))?
        );
        return Ok(());
    }
    if let [command, config, mode] = args.as_slice()
        && command == "relay-backup-retention"
    {
        let dry_run = match mode.to_str() {
            Some("preview") => true,
            Some("prune") => false,
            _ => return Err("Choose preview or prune".into()),
        };
        println!(
            "{}",
            relay_retention::maintain_backups(std::path::Path::new(config), dry_run)?
        );
        return Ok(());
    }
    if let [command, config, mode, cli] = args.as_slice()
        && command == "relay-artifact-retention"
    {
        let dry_run = match mode.to_str() {
            Some("preview") => true,
            Some("prune") => false,
            _ => return Err("Choose preview or prune".into()),
        };
        let plan: Value = serde_json::from_reader(std::io::stdin().lock().take(4_000_001))?;
        println!(
            "{}",
            relay_artifacts::maintain(
                std::path::Path::new(config),
                std::path::Path::new(cli),
                dry_run,
                &plan
            )?
        );
        return Ok(());
    }
    if let [command, config, bundle] = args.as_slice()
        && command == "relay-apply"
    {
        println!(
            "{}",
            relay_apply::apply(std::path::Path::new(config), std::path::Path::new(bundle))?
        );
        return Ok(());
    }
    match args.as_slice() {
        [command, config] if command == "relay-control" => {
            return relay_control::serve(std::path::Path::new(config));
        }
        [command, id, config] if command == "relay-control-worker" => {
            return relay_control::worker(
                std::path::Path::new(config),
                id.to_str().ok_or("Invalid job ID")?,
            );
        }
        _ => {}
    }
    if args
        .first()
        .and_then(|command| command.to_str())
        .is_some_and(|command| {
            matches!(
                command,
                "workspace"
                    | "project"
                    | "status"
                    | "discovery"
                    | "server"
                    | "update"
                    | "service"
                    | "deploy"
                    | "plugin"
            )
        })
    {
        return management::run(&args);
    }
    if args.first().is_some_and(|command| command == "memory") {
        return memory_cli::run(&args[1..]);
    }
    if args.first().is_some_and(|command| command == "init") {
        return init_cli::command(&args[1..]);
    }
    if let [command, database, flags @ ..] = args.as_slice()
        && command == "storage"
    {
        if database == "--help" {
            println!("Usage: spool storage DATABASE [--legacy|--sharded] < requests.jsonl");
            return Ok(());
        }
        let (layout, arguments) = match flags.split_last() {
            Some((flag, args)) if flag == "--legacy" => (storage_cli::Layout::Legacy, args),
            Some((flag, args)) if flag == "--sharded" => (storage_cli::Layout::Sharded, args),
            _ => (storage_cli::Layout::Detect, flags),
        };
        let database = Path::new(database);
        return match arguments {
            [] => storage_cli::serve(database, layout),
            [action, root, rest @ ..] if action == "watch" && rest.len() <= 1 => {
                let interval = rest
                    .first()
                    .map(|value| {
                        value
                            .to_str()
                            .ok_or("Invalid watch interval")
                            .and_then(|text| {
                                text.parse::<u64>().map_err(|_| "Invalid watch interval")
                            })
                    })
                    .transpose()?
                    .unwrap_or(1000);
                storage_cli::watch(database, layout, Path::new(root), interval)
            }
            [action, harness, root, options @ ..] if action == "run" => {
                let mut branch = None;
                let mut write = false;
                for option in options {
                    let option = option.to_str().ok_or("Invalid run option")?;
                    if option == "--write" {
                        write = true;
                    } else if !option.starts_with('-') && branch.is_none() {
                        branch = Some(option);
                    } else {
                        return Err(
                            "Use storage DATABASE run codex|claude ROOT [BRANCH] [--write]".into(),
                        );
                    }
                }
                let mut prompt = String::new();
                std::io::stdin()
                    .take(4_000_001)
                    .read_to_string(&mut prompt)?;
                let code = tokio::runtime::Runtime::new()?.block_on(adapter_runner::run(
                    database,
                    layout,
                    harness.to_str().ok_or("Invalid harness")?,
                    Path::new(root),
                    branch.unwrap_or("main"),
                    write,
                    prompt,
                ))?;
                if code != 0 {
                    std::process::exit(i32::from(code));
                }
                Ok(())
            }
            _ => Err(
                "Use spool storage DATABASE [watch ROOT [INTERVAL]] [--legacy|--sharded]".into(),
            ),
        };
    }
    if let [command, root] = args.as_slice()
        && command == "plugin-mcp"
    {
        return plugin_entry::run(Path::new(root));
    }
    if let [command, action, data, backup] = args.as_slice()
        && command == "relay-volume"
    {
        return relay_volume::run(
            action.to_str().ok_or("Invalid volume action")?,
            Path::new(data),
            Path::new(backup),
        );
    }
    if let [command, origin] = args.as_slice()
        && command == "relay-health"
    {
        println!(
            "{}",
            relay_client::health(origin.to_str().ok_or("Invalid health origin")?)?
        );
        return Ok(());
    }
    if args.as_slice() == ["--version"] {
        println!("SpoolDB {} (Rust)", version()?);
        return Ok(());
    }
    if let [command, event] = args.as_slice()
        && command == "codex-hook"
    {
        let result = (|| -> Result<Value> {
            let mut bytes = Vec::new();
            std::io::stdin().take(1_000_001).read_to_end(&mut bytes)?;
            if bytes.len() > 1_000_000 {
                return Ok(json!({}));
            }
            let input: Value = serde_json::from_slice(&bytes)?;
            codex_hooks::run(event.to_str().unwrap_or_default(), &input)
        })();
        println!("{}", result.unwrap_or_else(|_| json!({})));
        return Ok(());
    }
    if let [command, port] = args.as_slice()
        && command == "local-web"
    {
        return tokio::runtime::Runtime::new()?.block_on(local_web::serve(
            port.to_str().ok_or("Invalid local port")?.parse()?,
        ));
    }
    if let [command, key] = args.as_slice()
        && command == "local-embed"
    {
        let mut bytes = Vec::new();
        std::io::stdin().take(524_289).read_to_end(&mut bytes)?;
        if bytes.len() > 524_288 {
            return Err("Embedding input exceeds byte limit".into());
        }
        let texts: Vec<String> =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid embedding input")?;
        let model = local_embeddings::Model::load(key.to_str().ok_or("Invalid model")?, 2, None)?;
        let vectors = model.embed(&texts.iter().map(String::as_str).collect::<Vec<_>>())?;
        println!("{}", json!({"model":model.id,"vectors":vectors}));
        return Ok(());
    }
    if let [command, mode, executable @ ..] = args.as_slice()
        && command == "companion"
        && executable.len() <= 1
    {
        let executable = executable
            .first()
            .map(Path::new)
            .unwrap_or(Path::new("codex"));
        if mode == "once" {
            println!("{}", companion::Companion::default().cycle(executable)?);
        } else if mode == "start" {
            tokio::runtime::Runtime::new()?.block_on(companion::serve(
                executable.to_owned(),
                std::time::Duration::from_secs(10),
            ))?;
        } else {
            return Err("Choose companion once or companion start".into());
        }
        return Ok(());
    }
    if let [command, mode, directory, options @ ..] = args.as_slice()
        && command == "team-host"
    {
        if mode == "setup" {
            let [origin, name, tls @ ..] = options else {
                return Err("Use team-host setup DIRECTORY ORIGIN WORKSPACE_NAME".into());
            };
            let private_tls = match tls {
                [] => false,
                [flag] if flag == "--tls" => true,
                _ => {
                    return Err(
                        "Use team-host setup DIRECTORY ORIGIN WORKSPACE_NAME [--tls]".into(),
                    );
                }
            };
            println!(
                "{}",
                team_host::setup(
                    Path::new(directory),
                    origin.to_str().ok_or("Invalid origin")?,
                    name.to_str().ok_or("Invalid workspace name")?,
                    private_tls,
                )?
            );
        } else if mode == "request" && options.is_empty() {
            let mut data = Vec::new();
            std::io::stdin().take(20_001).read_to_end(&mut data)?;
            if data.len() > 20_000 {
                return Err("Host request exceeds byte limit".into());
            }
            println!(
                "{}",
                team_host::request(Path::new(directory), &serde_json::from_slice(&data)?)?
            );
        } else if mode == "start" {
            let mut host = "127.0.0.1".parse::<std::net::IpAddr>()?;
            let mut port = 8878_u16;
            let mut origin = None;
            for option in options {
                let option = option.to_str().ok_or("Invalid host option")?;
                match option.split_once('=') {
                    Some(("--port", value)) => port = value.parse()?,
                    Some(("--host", value)) => host = value.parse()?,
                    Some(("--origin", value)) => origin = Some(value),
                    _ => return Err("Use --port=PORT, --host=IP or --origin=URL".into()),
                }
            }
            team_host::start(
                Path::new(directory),
                std::net::SocketAddr::new(host, port),
                origin,
            )?;
        } else {
            return Err("Use team-host start STATE or team-host request STATE".into());
        }
        return Ok(());
    }
    if let [command, cwd] = args.as_slice()
        && command == "capture-share"
    {
        let binding = project_binding::resolve(Path::new(cwd))?;
        let grant = binding.grant.as_ref().ok_or("No relay configured")?;
        println!(
            "{}",
            capture_export::export(&binding.directory, &binding.local_id, grant)?
        );
        return Ok(());
    }
    if let [command, cwd] = args.as_slice()
        && command == "capture-publish"
    {
        let binding = project_binding::resolve(Path::new(cwd))?;
        println!(
            "{}",
            capture::publish_local(&binding.directory, &binding.local_id)?
        );
        return Ok(());
    }
    if let [command, cwd, executable @ ..] = args.as_slice()
        && command == "capture-codex"
        && executable.len() <= 1
    {
        let binding = project_binding::resolve(Path::new(cwd))?;
        let executable = executable
            .first()
            .map(Path::new)
            .unwrap_or(Path::new("codex"));
        let result = codex_history::poll(
            &binding.root,
            &binding.directory.join("capture.sqlite"),
            executable,
        )?;
        capture::publish_local(&binding.directory, &binding.local_id)?;
        println!("{result}");
        return Ok(());
    }
    if let [command, database, branch] = args.as_slice()
        && command == "capture-import"
    {
        let mut bytes = Vec::new();
        std::io::stdin().take(16_000_001).read_to_end(&mut bytes)?;
        if bytes.len() > 16_000_000 {
            return Err("Capture input exceeds byte limit".into());
        }
        let messages: Vec<capture::Message> =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid capture page")?;
        println!(
            "{}",
            capture::store(
                Path::new(database),
                branch.to_str().ok_or("Invalid branch")?,
                &messages
            )?
        );
        return Ok(());
    }
    if let [command, path] = args.as_slice()
        && command == "project-init"
    {
        println!("{}", project_init::initialize(Path::new(path))?);
        return Ok(());
    }
    if args.len() == 1 && args[0] == "project-mcp" {
        return mcp::serve_projects(None);
    }
    if let [command, database, branch, mode] = args.as_slice()
        && command == "sync"
    {
        let mut data = Vec::new();
        std::io::stdin().take(65_537).read_to_end(&mut data)?;
        if data.len() > 65_536 {
            return Err("Sync configuration exceeds byte limit".into());
        }
        let connection = serde_json::from_slice(&data).map_err(|_| "Invalid sync configuration")?;
        let client = relay_client::Client::new(connection)?;
        println!(
            "{}",
            sync::run(
                Path::new(database),
                &client,
                branch.to_str().ok_or("Invalid branch")?,
                mode.to_str().ok_or("Invalid mode")?
            )?
        );
        return Ok(());
    }

    if let [command, cwd, action] = args.as_slice()
        && command == "project-request"
    {
        let action = action.to_str().ok_or("Invalid relay action")?;
        if !matches!(action, "state" | "memory") {
            return Err("Project request supports state and memory".into());
        }
        let binding = project_binding::resolve(Path::new(cwd))?;
        let input = if action == "state" {
            None
        } else {
            let mut data = Vec::new();
            std::io::stdin().take(16_000_001).read_to_end(&mut data)?;
            if data.len() > 16_000_000 {
                return Err("Project request input exceeds byte limit".into());
            }
            Some(serde_json::from_slice(&data).map_err(|_| "Invalid project request input")?)
        };
        let result = match input {
            Some(input) => binding.memory(&input)?,
            None => relay_client::Client::new(binding.grant.ok_or("No relay configured")?)?
                .request(action, None)?,
        };
        println!("{result}");
        return Ok(());
    }
    if let [command, profile, cwd, mode, target, parent @ ..] = args.as_slice()
        && command == "project-enroll"
        && parent.len() <= 1
    {
        println!(
            "{}",
            workspace_client::enroll_project(
                profile.to_str().ok_or("Invalid profile selector")?,
                Path::new(cwd),
                mode.to_str().ok_or("Invalid enrollment mode")?,
                target.to_str().ok_or("Invalid enrollment target")?,
                parent.first().map(Path::new),
            )?
        );
        return Ok(());
    }
    if args.len() == 1 && args[0] == "workspace-profiles" {
        println!("{}", workspace_client::list_profiles()?);
        return Ok(());
    }
    if let [command, profile] = args.as_slice()
        && command == "workspace-action"
    {
        let mut bytes = Vec::new();
        std::io::stdin().take(20_001).read_to_end(&mut bytes)?;
        if bytes.len() > 20_000 {
            return Err("Workspace action exceeds byte limit".into());
        }
        let body: Value = serde_json::from_slice(&bytes)?;
        println!(
            "{}",
            workspace_client::action(profile.to_str().ok_or("Invalid profile selector")?, &body)?
        );
        return Ok(());
    }
    if let [command, device @ ..] = args.as_slice()
        && command == "workspace-invite"
        && device.len() <= 1
    {
        let device = device
            .first()
            .map(|value| value.to_str().ok_or("Invalid device name"))
            .transpose()?;
        let mut link = String::new();
        std::io::stdin().take(40_001).read_to_string(&mut link)?;
        if link.len() > 40_000 {
            return Err("Workspace invitation exceeds byte limit".into());
        }
        println!("{}", workspace_client::invite(link.trim(), device)?);
        return Ok(());
    }
    if let [command, action] = args.as_slice()
        && command == "workspace-request"
    {
        #[derive(serde::Deserialize)]
        struct Request {
            url: String,
            ca: Option<String>,
            credential: String,
            body: Value,
        }
        let mut data = Vec::new();
        std::io::stdin().take(32_769).read_to_end(&mut data)?;
        if data.len() > 32_768 {
            return Err("Workspace connection input exceeds byte limit".into());
        }
        let input: Request =
            serde_json::from_slice(&data).map_err(|_| "Invalid workspace input")?;
        println!(
            "{}",
            relay_client::workspace_request(
                &input.url,
                input.ca.as_deref(),
                &input.credential,
                action.to_str().ok_or("Invalid workspace action")?,
                &input.body
            )?
        );
        return Ok(());
    }
    if let [command, action] = args.as_slice()
        && command == "relay-request"
    {
        #[derive(serde::Deserialize)]
        struct Request {
            #[serde(flatten)]
            connection: relay_client::ConnectionOptions,
            body: Option<Value>,
        }
        let mut data = Vec::new();
        std::io::stdin().take(16_004_097).read_to_end(&mut data)?;
        if data.len() > 16_004_096 {
            return Err("Relay request input exceeds byte limit".into());
        }
        let input: Request =
            serde_json::from_slice(&data).map_err(|_| "Invalid relay request input")?;
        let client = relay_client::Client::new(input.connection)?;
        println!(
            "{}",
            client.request(
                action.to_str().ok_or("Invalid relay action")?,
                input.body.as_ref()
            )?
        );
        return Ok(());
    }

    if let [command, database, target] = args.as_slice()
        && command == "backup"
    {
        println!(
            "{}",
            relay_ops::backup(Path::new(database), Path::new(target))?
        );
        return Ok(());
    }
    if let [command, id, room, access @ ..] = args.as_slice()
        && command == "credential"
        && access.len() <= 1
    {
        let role = match access.first() {
            Some(value) => value.to_str().ok_or("Invalid role")?,
            None => "write",
        };
        println!(
            "{}",
            relay_ops::credential(
                id.to_str().ok_or("Invalid principal")?,
                room.to_str().ok_or("Invalid room")?,
                role,
            )?
        );
        return Ok(());
    }

    if let [command, database, config, address] = args.as_slice()
        && command == "relay"
    {
        return tokio::runtime::Runtime::new()?.block_on(relay::serve(
            database.into(),
            config.into(),
            address.to_str().ok_or("Invalid address")?.parse()?,
        ));
    }
    if let [command, database, room] = args.as_slice()
        && command == "memory-index"
    {
        let mut db =
            Connection::open_with_flags(Path::new(database), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(memory_index::SCHEMA)?;
        let heads = memory_index::refresh(&tx, room.to_str().ok_or("Invalid room ID")?)?;
        tx.commit()?;
        println!("{}", serde_json::to_string(&json!({"heads": heads}))?);
        return Ok(());
    }
    if let [command, database, room] = args.as_slice()
        && command == "mcp"
    {
        return mcp::serve(Path::new(database), room.to_str().ok_or("Invalid room ID")?);
    }
    if let [command, database, branch] = args.as_slice()
        && command == "bundle-import"
    {
        const MAX_INPUT: u64 = 48_000_000;
        let mut input = String::new();
        std::io::stdin()
            .take(MAX_INPUT + 1)
            .read_to_string(&mut input)?;
        if input.len() as u64 > MAX_INPUT || input.encode_utf16().count() > 16_000_000 {
            return Err("Bundle too large".into());
        }
        let bundle = serde_json::from_str(&input)?;
        let mut db =
            Connection::open_with_flags(Path::new(database), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = bundles::import(&tx, branch.to_str().ok_or("Invalid branch")?, &bundle)?;
        tx.commit()?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    if let [command, database, room, branch] = args.as_slice()
        && command == "message-add"
    {
        let room = room.to_str().ok_or("Invalid room ID")?;
        let branch = branch.to_str().ok_or("Invalid branch")?;
        const MAX_INPUT: u64 = 6_100_000;
        let mut input = Vec::new();
        std::io::stdin()
            .take(MAX_INPUT + 1)
            .read_to_end(&mut input)?;
        if input.len() as u64 > MAX_INPUT {
            return Err("Message submission too large".into());
        }
        let input = serde_json::from_slice(&input)?;
        let mut db =
            Connection::open_with_flags(Path::new(database), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = shards::append_message(&tx, room, branch, &input)?;
        tx.commit()?;
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    if let [command, database, room, branch, since] = args.as_slice()
        && command == "bundle-export"
    {
        let mut db =
            Connection::open_with_flags(Path::new(database), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let tx = db.transaction()?;
        let result = bundles::export(
            &tx,
            room.to_str().ok_or("Invalid room ID")?,
            branch.to_str().ok_or("Invalid branch")?,
            serde_json::from_str(since.to_str().ok_or("Invalid sync frontier")?)?,
        )?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    let [command, database, room, value] = args.as_slice() else {
        return Err(
            "Usage: spool-native relay DATABASE CONFIG ADDRESS | backup DATABASE NEW_BACKUP_FILE | credential PRINCIPAL ROOM [read|write] | get DATABASE ROOM RECORD_ID | search DATABASE ROOM QUERY | document-get DATABASE ROOM KEY | manifest-get DATABASE ROOM KEY | bundle-import DATABASE BRANCH | bundle-export DATABASE ROOM BRANCH SINCE_JSON | message-add DATABASE ROOM BRANCH | room-create DATABASE ROOM BRANCH | memory-index DATABASE ROOM | mcp DATABASE ROOM".into(),
        );
    };
    let command = command.to_str().ok_or("Invalid command")?;
    if command == "room-create" {
        let room = room.to_str().ok_or("Invalid room ID")?;
        let branch = value.to_str().ok_or("Invalid branch")?;
        let mut db =
            Connection::open_with_flags(Path::new(database), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = shards::create_room(&tx, room, branch)?;
        tx.commit()?;
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    if !matches!(command, "get" | "search" | "manifest-get" | "document-get") {
        return Err("Expected get, search, manifest-get, or document-get".into());
    }
    let room = room.to_str().ok_or("Invalid room ID")?;
    let value = value.to_str().ok_or("Invalid record ID or query")?;
    let mut db =
        Connection::open_with_flags(Path::new(database), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let snapshot = db.transaction()?;
    let result = if command == "manifest-get" {
        manifest::lookup(&snapshot, room, value)?
    } else if command == "document-get" {
        documents::read(&snapshot, room, value)?
    } else {
        validate_frontier(&snapshot, room)?;
        if command == "get" {
            get_indexed(&snapshot, room, value)?
        } else {
            search(&snapshot, room, value)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("spool-native: {error}");
            ExitCode::FAILURE
        }
    }
}
