use crate::{Result, get_indexed, project_binding, search, validate_frontier};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Write};
use std::path::Path;

const MAX_FRAME: usize = 1024 * 1024;

pub fn serve(database: &Path, room: &str) -> Result<()> {
    let mut db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let tools = json!([
        tool(
            "memory_get",
            "Read a stored record by ID, including archived records.",
            "id"
        ),
        tool(
            "memory_search",
            "Search active structured memory by keyword.",
            "query"
        )
    ]);
    run(tools, |name, args, _| {
        let key = if name == "memory_get" { "id" } else { "query" };
        read(
            &mut db,
            room,
            name,
            args[key].as_str().ok_or("Expected a string argument")?,
        )
    })
}

fn run(tools: Value, mut call: impl FnMut(&str, &Value, &Value) -> Result<Value>) -> Result<()> {
    let schemas: Vec<_> = tools
        .as_array()
        .ok_or("Expected tool list")?
        .iter()
        .map(|tool| {
            Ok((
                tool["name"].as_str().ok_or("Tool name is missing")?,
                jsonschema::validator_for(&tool["inputSchema"])?,
            ))
        })
        .collect::<Result<_>>()?;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut initialized = false;
    loop {
        let mut frame = Vec::new();
        if std::io::Read::take(&mut input, MAX_FRAME as u64 + 1).read_until(b'\n', &mut frame)? == 0
        {
            return Ok(());
        }
        if frame.len() > MAX_FRAME {
            return Err("MCP frame exceeds the size limit".into());
        }
        let message = serde_json::from_slice(&frame);
        let response = match message {
            Ok(message) => handle(&tools, &schemas, &mut call, &mut initialized, message),
            Err(_) => Some(error(&Value::Null, -32700, "Invalid JSON")),
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut output, &response)?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
}

fn error(id: &Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

fn handle(
    tools: &Value,
    schemas: &[(&str, jsonschema::Validator)],
    call: &mut impl FnMut(&str, &Value, &Value) -> Result<Value>,
    initialized: &mut bool,
    msg: Value,
) -> Option<Value> {
    let id = msg.get("id").unwrap_or(&Value::Null);
    let Some(method) = msg
        .get("method")
        .and_then(Value::as_str)
        .filter(|_| msg["jsonrpc"] == "2.0")
    else {
        return Some(error(id, -32600, "Invalid request"));
    };
    msg.get("id")?;
    let result = match method {
        "initialize" => {
            *initialized = true;
            let version = msg["params"]["protocolVersion"].as_str().unwrap_or("");
            let version = match version {
                "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25" => version,
                _ => "2025-11-25",
            };
            json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"spool-native","version":env!("CARGO_PKG_VERSION")},"instructions":"SpoolDB is optional. Retrieve relevant evidence when useful and save only material updates. Verify claims against the current checkout."})
        }
        "ping" => json!({}),
        _ if !*initialized => return Some(error(id, -32002, "Initialize the server first")),
        "resources/list" => json!({"resources":[]}),
        "resources/templates/list" => json!({"resourceTemplates":[]}),
        "tools/list" => json!({"tools":tools}),
        "tools/call" => {
            let params = &msg["params"];
            let name = params["name"].as_str().unwrap_or_default();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let response = match schemas.iter().find(|(tool, _)| *tool == name) {
                Some((_, schema)) if schema.is_valid(&args) => call(name, &args, id),
                _ => return Some(error(id, -32602, "Invalid memory tool or arguments")),
            };
            match response {
                Ok(record) => {
                    json!({"content":[{"type":"text","text":record.to_string()}],"structuredContent":record,"isError":false})
                }
                Err(fault) => {
                    json!({"content":[{"type":"text","text":fault.to_string()}],"isError":true})
                }
            }
        }
        _ => return Some(error(id, -32601, "Unknown method")),
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

fn tool(name: &str, description: &str, key: &str) -> Value {
    json!({"name":name,"description":description,"inputSchema":{
        "type":"object","properties":{(key):{"type":"string"}},"required":[key],"additionalProperties":false
    },"annotations":{"readOnlyHint":true}})
}

fn read(db: &mut Connection, room: &str, name: &str, value: &str) -> Result<Value> {
    let snapshot = db.transaction()?;
    validate_frontier(&snapshot, room)?;
    match name {
        "memory_get" => get_indexed(&snapshot, room, value),
        _ => search(&snapshot, room, value),
    }
}

pub fn serve_projects(plugin: Option<&Path>) -> Result<()> {
    let declared: Vec<Value> =
        serde_json::from_str(include_str!("../cloudflare/src/remote-tools.json"))?;
    let mut tools = Vec::new();
    for mut tool in declared {
        if matches!(
            tool["name"].as_str(),
            Some("project_list" | "delete_conversations")
        ) {
            continue;
        }
        let object = tool.as_object_mut().ok_or("Invalid tool declaration")?;
        object.remove("securitySchemes");
        object.remove("_meta");
        let schema = &mut tool["inputSchema"];
        let properties = schema["properties"]
            .as_object_mut()
            .ok_or("Missing tool properties")?;
        properties.remove("project");
        properties.insert("root".into(), json!({"type":"string","minLength":1,"maxLength":4096,
            "description":"Absolute directory inside the Git repository you are currently working on."}));
        schema["required"]
            .as_array_mut()
            .ok_or("Missing required properties")?
            .push(json!("root"));
        tools.push(tool);
    }
    tools.push(json!({
        "name":"file_read","description":"Read a tracked source file in the current local Git checkout. Source stays on this computer.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["root","path"],"properties":{
            "root":{"type":"string","maxLength":4096},"path":{"type":"string","minLength":1,"maxLength":1000},
            "offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":20000}}},
        "annotations":{"readOnlyHint":true}
    }));
    tools.push(json!({
        "name":"spool_setup",
        "description":"Preview or explicitly connect a repository or workspace. Use preview before asking the user which matching project to join.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["action"],"properties":{
            "action":{"enum":["status","preview","connect","ignore","pause","resume",
                "workspace_status","workspace_preview","workspace_connect","retrospective","link_parent","workspace_sharing","project_sharing","delete_conversations","relay_update","updates","migrate"]},
            "root":{"type":"string","maxLength":4096},
            "workspace":{"type":"string","maxLength":1000},
            "project":{"type":"string","maxLength":200},
            "name":{"type":"string","maxLength":160},
            "device":{"type":"string","maxLength":120},
            "invitation":{"type":"string","maxLength":40000},
            "parentRoom":{"type":"string","maxLength":180},
            "confirm":{"type":"boolean"},"create":{"type":"boolean"},"analyzeExisting":{"type":"boolean"},
            "sharing":{"type":"object"},"expectedRevision":{"type":"integer","minimum":0},
            "deletionToken":{"type":"string","maxLength":1000},"sessionId":{"type":"string","maxLength":200},
            "requestId":{"type":"string","maxLength":200},"updateNow":{"type":"boolean"},
            "updateMode":{"enum":["off","check","automatic"]}
        }}
    }));
    tools.push(json!({
        "name":"history_read","description":"Read a page from the explicitly approved local conversation snapshot. Keep raw conversation text local.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["root"],"properties":{
            "root":{"type":"string","maxLength":4096},"recordId":{"type":"string","maxLength":200},
            "offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":20}}},
        "annotations":{"readOnlyHint":true}
    }));
    tools.push(json!({
        "name":"history_complete","description":"Complete an approved historical analysis after saving its completion handoff.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["root","handoffId"],"properties":{
            "root":{"type":"string","maxLength":4096},"handoffId":{"type":"string","maxLength":200}}}
    }));
    let mut random = [0; 16];
    getrandom::fill(&mut random)?;
    let session = std::env::var("CODEX_THREAD_ID")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("native-mcp-{}", hash(json!(random))));
    run(json!(tools), |name, input, id| match name {
        "spool_setup" => setup(input, plugin),
        "history_read" | "history_complete" => {
            let root = Path::new(
                input["root"]
                    .as_str()
                    .ok_or("Pass the current Git repository root")?,
            );
            if !root.is_absolute() {
                return Err("Pass an absolute Git repository directory".into());
            }
            if name == "history_read" {
                crate::retrospective::history(root, input)
            } else {
                crate::retrospective::complete(
                    root,
                    input["handoffId"].as_str().ok_or("A handoff is required")?,
                )
            }
        }
        _ => project_call(name, input, id, &session),
    })
}

fn setup_management(action: &str, input: &Value) -> Result<Value> {
    use crate::workspace_client;
    let state = project_binding::state_root()?;
    if action == "updates" {
        if (input["updateNow"] == true || input["updateMode"].is_string())
            && input["confirm"] != true
        {
            return Err("Explicit approval is required to configure or install updates".into());
        }
        let mode = input["updateMode"].as_str();
        let command = match mode {
            Some("off") => "disable",
            Some(_) => "enable",
            None if input["updateNow"] == true => "",
            None => "status",
        };
        return crate::client_update::run(&state, command, Some("plugin"), mode, true);
    }
    let binding = input["root"]
        .as_str()
        .map(std::path::Path::new)
        .map(project_binding::resolve)
        .transpose()?;
    let bound = binding.as_ref().and_then(|entry| entry.grant.as_ref());
    let explicit = input["workspace"].as_str();
    let profiles = workspace_client::list_profiles()?;
    let selector = explicit
        .or_else(|| {
            binding
                .as_ref()
                .and_then(|entry| entry.workspace_profile.as_deref())
        })
        .or_else(|| bound.map(|grant| grant.url.as_str()))
        .or_else(|| {
            profiles["workspaces"]
                .as_array()
                .filter(|profiles| profiles.len() == 1)
                .and_then(|profiles| profiles[0]["id"].as_str())
        })
        .ok_or("Choose a saved workspace connection")?;
    let apply = |request: &Value| workspace_client::action(selector, request);
    if action == "relay_update" {
        if input["updateNow"] == true && input["confirm"] != true {
            return Err("Explicit approval is required before updating a relay".into());
        }
        let listed = apply(&json!({"command":"list"}))?;
        let compatible = listed["capabilities"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|value| value == "repository-enrollment-v2");
        let status = apply(&json!({"command":"relay-admin","action":"status"}))?;
        if status["supported"] != true {
            return Ok(
                json!({"supported":false,"compatible":compatible,"deploymentRequired":true,
                "relay":listed["relay"],"updateOffered":true,
                "message":"Redeploy the existing relay with its saved deployment credentials and bindings, then preview the repository again."}),
            );
        }
        if input["updateNow"] == true {
            return apply(&json!({"command":"relay-admin","action":"update",
                "requestId":input["requestId"].as_str().map(str::to_owned).map_or_else(crate::private_files::random_id,Ok)?}));
        }
        let mut response = status;
        response["compatible"] = json!(compatible);
        response["updateOffered"] = json!(true);
        return Ok(response);
    }
    let mut body = json!({"command":match action{
        "workspace_sharing"=>"sharing","project_sharing"=>"project-sharing","delete_conversations"=>"delete-conversations",
        _=>return Err("Unknown management action".into()),
    }});
    if action != "workspace_sharing" {
        let listed = apply(&json!({"command":"list"}))?;
        let supplied = input["project"].as_str();
        let room = bound.map(|grant| grant.room.as_str());
        let matches = listed["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|project| {
                supplied.map_or_else(
                    || room.is_some_and(|room| project["room"] == room),
                    |name| {
                        project["room"] == name
                            || project["name"]
                                .as_str()
                                .is_some_and(|prior| prior.eq_ignore_ascii_case(name))
                    },
                )
            })
            .collect::<Vec<_>>();
        let [target] = matches.as_slice() else {
            return Err("Choose a unique shared project by name or ID".into());
        };
        if let Some(grant) = bound
            && (target["room"] != grant.room || listed["relay"] != grant.url)
        {
            return Err("The selected project differs from the repository binding".into());
        }
        body["room"] = target["room"].clone();
    }
    if action == "delete_conversations" {
        body["confirm"] = json!(input["confirm"] == true);
        if body["confirm"] == true {
            body["deletionToken"] = json!(
                input["deletionToken"]
                    .as_str()
                    .ok_or("Preview deletion before confirming")?
            );
            body["requestId"] = json!(
                input["requestId"]
                    .as_str()
                    .map(str::to_owned)
                    .map_or_else(crate::private_files::random_id, Ok)?
            );
        }
        if let Some(value) = input.get("sessionId") {
            body["sessionId"] = value.clone();
        }
    } else if let Some(sharing) = input.get("sharing") {
        if input["confirm"] != true {
            return Err("Explicit approval is required to change sharing".into());
        }
        body["sharing"] = sharing.clone();
        body["expectedRevision"] = json!(
            input["expectedRevision"]
                .as_u64()
                .ok_or("Read current sharing settings first")?
        );
    }
    apply(&body)
}

fn setup(input: &Value, plugin: Option<&Path>) -> Result<Value> {
    use crate::{discovery, workspace_client};
    let action = input["action"].as_str().ok_or("Choose a setup action")?;
    if matches!(
        action,
        "workspace_sharing"
            | "project_sharing"
            | "delete_conversations"
            | "relay_update"
            | "updates"
    ) {
        return setup_management(action, input);
    }
    let invitation = || input["invitation"].as_str().ok_or("Paste an invitation");
    let device = input["device"].as_str().unwrap_or("Codex");
    if action == "workspace_status" {
        return workspace_client::list_profiles();
    }
    if action == "workspace_preview" {
        return workspace_client::invite(invitation()?, None);
    }
    if action == "workspace_connect" {
        if input["confirm"] != true {
            return Err("Explicit user approval is required to connect a workspace".into());
        }
        return workspace_client::invite(invitation()?, Some(device));
    }
    let fallback;
    let root = if let Some(path) = input["root"].as_str() {
        Path::new(path)
    } else if action == "status" {
        fallback = std::env::current_dir()?;
        &fallback
    } else {
        return Err("Pass the current Git repository root".into());
    };
    if !root.is_absolute() {
        return Err("Pass an absolute Git repository directory".into());
    }
    if action == "migrate" {
        return crate::plugin_migration::migrate(root, plugin, input["confirm"] == true);
    }
    let mut output = match action {
        "status" => discovery::run(&json!({"command":"resolve","cwd":root}))?,
        "preview" => {
            if let Some(invitation) = input["invitation"].as_str() {
                workspace_client::project_invitation(invitation, None, device, false)?
            } else {
                discovery::run(
                    &json!({"command":"preview","cwd":root,"workspace":input["workspace"]}),
                )?
            }
        }
        "retrospective" => {
            if input["confirm"] != true {
                return Err("Explicit user approval is required for historical analysis".into());
            }
            crate::retrospective::choose(
                root,
                input["analyzeExisting"]
                    .as_bool()
                    .ok_or("Choose whether to analyze existing chats")?,
            )?
        }
        "link_parent" => discovery::run(&json!({"command":"link-parent","cwd":root,
            "confirm":input["confirm"],"parentRoom":input["parentRoom"]}))?,
        "ignore" => discovery::run(&json!({"command":"ignore","cwd":root}))?,
        "pause" | "resume" => {
            if action == "resume" && input["confirm"] != true {
                return Err("Explicit user approval is required to resume Codex capture".into());
            }
            let binding = project_binding::resolve(root)?;
            workspace_client::save_atomic(
                &binding.directory.join("integrations.json"),
                &json!({"codex":action=="resume"}),
            )?;
            json!({"repository":binding.info(),"captureEnabled":action=="resume"})
        }
        "connect" => {
            if input["confirm"] != true {
                return Err("Explicit user approval is required to connect this repository".into());
            }
            if let Some(invitation) = input["invitation"].as_str() {
                workspace_client::project_invitation(invitation, Some(root), device, true)?
            } else {
                let preview = discovery::run(
                    &json!({"command":"preview","cwd":root,"workspace":input["workspace"]}),
                )?;
                let create = input["create"] == true;
                let project = input["project"].as_str();
                if create
                    && preview["matches"]
                        .as_array()
                        .is_some_and(|items| !items.is_empty())
                {
                    return Ok(
                        json!({"status":"join_available","matchingProjects":preview["matches"],
                        "requiresJoinApproval":true,"notice":"This repository already has a shared project. Ask whether to join it."}),
                    );
                }
                let mut body = json!({"command":"approve","cwd":root,"workspace":input["workspace"],"confirm":true,
                    "create":create,"name":input["name"]});
                if let Some(project) = project {
                    let matches = preview["projects"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|item| {
                            item["room"] == project
                                || item["name"]
                                    .as_str()
                                    .is_some_and(|name| name.eq_ignore_ascii_case(project))
                        })
                        .collect::<Vec<_>>();
                    if matches.len() != 1 {
                        return Err(
                            "Choose one accessible shared project by ID or unique name".into()
                        );
                    }
                    body["room"] = matches[0]["room"].clone();
                }
                if let Some(parent) = input.get("parentRoom") {
                    body["parentRoom"] = parent.clone();
                }
                discovery::run(&body)?
            }
        }
        _ => return Err("Unknown SpoolDB setup action".into()),
    };
    if action == "connect"
        && let Some(choice) = input["analyzeExisting"].as_bool()
    {
        crate::retrospective::choose(root, choice)?;
    }
    if matches!(action, "connect" | "status")
        && let Ok(status) = crate::retrospective::status(root)
    {
        output["requiresRetrospectiveChoice"] = json!(status["status"] == "offered");
        output["retrospective"] = status;
    }
    if action == "status" {
        let root = project_binding::repository_root(root)?;
        output["legacyConfiguration"] =
            json!(crate::plugin_migration::legacy_configuration(&root)?);
    }
    output["root"] = json!(project_binding::repository_root(root)?);
    Ok(output)
}

fn hash(value: Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn project_call(name: &str, input: &Value, id: &Value, session: &str) -> Result<Value> {
    let cwd = Path::new(
        input["root"]
            .as_str()
            .ok_or("Pass the current repository root")?,
    );
    if !cwd.is_absolute() {
        return Err("Pass an absolute directory in the current repository".into());
    }
    let binding = match project_binding::resolve(cwd) {
        Ok(binding) => binding,
        Err(error) => {
            let status = crate::discovery::run(&json!({"command":"resolve","cwd":cwd}))
                .unwrap_or(Value::Null);
            if status["status"] == "ignored" {
                return Ok(
                    json!({"memoryAvailable":false,"saved":false,"code":"PROJECT_SKIPPED",
                    "notice":"This repository is skipped. Continue without SpoolDB."}),
                );
            }
            if status["status"] == "pending" {
                return Ok(
                    json!({"memoryAvailable":false,"saved":false,"code":"PROJECT_CONNECTION_REQUIRED",
                    "repository":status,"notice":"Use spool_setup preview if prior memory would help, and ask the user before connecting. It is fine to continue without shared memory."}),
                );
            }
            return Err(error);
        }
    };
    if name == "file_read" {
        return crate::local_source::read(&binding, input);
    }
    project_binding::check_files(&binding.root, &input["files"])?;
    let repository = binding.info();
    let wants_parent = input["sourceProject"] == "parent";
    let (command, write) = match name {
        "memory_get" => ("get", false),
        "memory_search" => ("search", false),
        "project_context" => ("context", false),
        "remember" | "memory_update" => ("remember", true),
        "task_update" => ("task_update", true),
        "handoff" => ("handoff", true),
        _ => return Err("Unknown project tool".into()),
    };
    let compact = input["compact"] != false;
    let mut body = input.clone();
    let object = body
        .as_object_mut()
        .ok_or("Expected a tool argument object")?;
    object.remove("root");
    object.remove("compact");
    object.remove("sourceProject");
    let max_chars = object
        .remove("maxChars")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);
    if name == "memory_update" {
        let mut lifecycle = json!({"id":input["id"],"action":input["action"],
            "expectedRevision":input["expectedRevision"]});
        for field in ["replacementId", "resolveIds"] {
            if let Some(value) = input.get(field) {
                lifecycle[field] = value.clone();
            }
        }
        body = json!({"kind":"decision","title":format!("Memory {}",input["action"].as_str().unwrap_or_default()),
            "text":input["reason"],"lifecycle":lifecycle});
    }
    body["command"] = json!(command);
    if write {
        if crate::codex_hooks::ignored(&binding.root, session) {
            return Err("Background suggestion sessions cannot write project memory".into());
        }
        let (git, references) = crate::git_evidence::checkpoint(&binding.root, &body["files"]);
        body["git"] = git;
        body["codeReferences"] = references;
        let request = input["requestId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("mcp-{}", hash(json!([session, id, name, input]))));
        body["requestId"] = json!(request);
        body["sessionId"] = json!(session);
    }
    let contextual = matches!(command, "search" | "context");
    let parent = (contextual || wants_parent).then(|| binding.linked_parent());
    let mut parent_result = None;
    let mut parent_info = None;
    let mut parent_unavailable = false;
    let mut result = if wants_parent {
        let parent = parent
            .transpose()?
            .flatten()
            .ok_or("No linked parent project is available")?;
        parent_info = Some(parent.info());
        let mut response = parent.memory(&body)?;
        crate::git_evidence::reconcile(&parent.root, &mut response);
        response
    } else {
        let mut result = binding.memory(&body)?;
        if !write {
            crate::git_evidence::reconcile(&binding.root, &mut result);
        }
        match parent {
            Some(Ok(Some(parent))) => {
                let mut request = json!({"command":command});
                for field in ["query", "mode", "includeArchived", "kinds"] {
                    if let Some(value) = body.get(field) {
                        request[field] = value.clone();
                    }
                }
                parent_info = Some(parent.info());
                match parent.memory(&request) {
                    Ok(mut value) => {
                        crate::git_evidence::reconcile(&parent.root, &mut value);
                        parent_result = Some(value);
                    }
                    Err(_) => parent_unavailable = true,
                }
            }
            Some(Err(_)) => parent_unavailable = true,
            _ => {}
        }
        result
    };
    let continuity = (command == "context").then(|| {
        let task_id = input["taskId"].as_str().map(str::to_owned)
            .unwrap_or_else(|| format!("codex-{}", &format!("{:x}",Sha256::digest(session))[..24]));
        let task = result["tasks"].as_array().into_iter().flatten().find(|task| task["taskId"] == task_id);
        json!({"taskId":task_id,"expectedRevision":task.and_then(|item| item["revision"].as_u64()).unwrap_or(0),
            "taskExists":task.is_some(),"guidance":"Saving is optional. Use the current revision when a material update would help another agent."})
    });
    if compact && contextual {
        let budget = max_chars
            .or_else(|| {
                result["retrieval"]["contextChars"]
                    .as_u64()
                    .map(|v| v as usize)
            })
            .unwrap_or(6000)
            .clamp(1000, 24000);
        let scope_budget = if parent_result.is_some() {
            ((budget - 400) / 2).max(1000)
        } else {
            budget
        };
        result = compact_result(result, scope_budget, input["offset"].as_u64().unwrap_or(0));
        parent_result = parent_result.map(|value| compact_result(value, scope_budget, 0));
    }
    if let Some(value) = continuity {
        result["continuity"] = value;
    }
    if let Some(mut value) = parent_result {
        value["sourceProject"] = json!("parent");
        value["repository"] = parent_info.unwrap_or(Value::Null);
        result["parentContext"] = value;
    } else if wants_parent {
        result["sourceProject"] = json!("parent");
        result["sourceRepository"] = parent_info.unwrap_or(Value::Null);
    } else if parent_unavailable {
        result["parentContext"] = json!({"available":false,"notice":"The linked parent is unavailable. Current repository memory is still available."});
    }
    result["repository"] = repository;
    Ok(result)
}

fn compact_result(mut value: Value, budget: usize, offset: u64) -> Value {
    let mut seen = std::collections::HashSet::new();
    let mut omitted = 0;
    let mut result = json!({
        "room":value["room"],
        "notice":"Use these cards when sufficient. Read memory_get only for missing detail or provenance."
    });
    for field in ["nextOffset", "retrieval", "workspaceSharing"] {
        if let Some(v) = value.get(field) {
            result[field] = v.clone();
        }
    }
    for field in ["tasks", "notes", "results", "relatedConversations"] {
        let Some(items) = value[field].take().as_array().cloned() else {
            continue;
        };
        result[field] = json!([]);
        for (index, item) in items.into_iter().enumerate() {
            let id = item["id"].as_str().unwrap_or_default();
            if seen.contains(id) {
                omitted += 1;
                continue;
            }
            let mut card = json!({});
            for key in [
                "id",
                "kind",
                "title",
                "taskId",
                "revision",
                "status",
                "citation",
                "lifecycle",
                "freshness",
                "retrievedBy",
                "refs",
                "nextSteps",
                "blockers",
                "reconciliation",
            ] {
                if let Some(v) = item.get(key) {
                    card[key] = v.clone();
                }
            }
            let text = item["text"].as_str().unwrap_or_default();
            let snippet: String = text.chars().take(650).collect();
            card["truncated"] = json!(item["truncated"] == true || snippet.len() < text.len());
            card["text"] = json!(snippet);
            result[field].as_array_mut().expect("set above").push(card);
            if result.to_string().encode_utf16().count() > budget - 100 {
                result[field].as_array_mut().expect("set above").pop();
                omitted += 1;
                let position = offset.saturating_add(index as u64);
                if field == "results"
                    && result["nextOffset"]
                        .as_u64()
                        .is_none_or(|next| next > position)
                {
                    result["nextOffset"] = json!(position);
                }
            } else {
                seen.insert(id.to_owned());
            }
        }
    }
    result["budget"] = json!({"maxChars":budget,"omitted":omitted});
    result
}
