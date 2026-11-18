use crate::{Result, git_evidence, private_files, project_binding};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
};

pub fn run(args: &[OsString]) -> Result<()> {
    let action = args
        .first()
        .and_then(|arg| arg.to_str())
        .ok_or("Choose memory context, search, get, remember, handoff or task")?;
    let command = match action {
        "context" | "search" | "get" | "remember" | "handoff" => action,
        "task" => "task_update",
        _ => return Err("Choose memory context, search, get, remember, handoff or task".into()),
    };
    let mut flags: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut words = Vec::new();
    let mut options = args[1..].iter();
    while let Some(token) = options.next() {
        let token = token.to_str().ok_or("Invalid memory argument")?;
        if let Some(option) = token.strip_prefix("--") {
            let (key, inline) = option
                .split_once('=')
                .map_or((option, None), |(key, value)| (key, Some(value)));
            match key {
                "json" | "text-stdin" if inline.is_none() => {
                    flags.insert(key, vec![]);
                }
                "task" | "offset" | "limit" | "kind" | "title" | "request-id" | "revision"
                | "status" | "text-file" | "state" | "root" | "project" | "file" | "ref"
                | "next-step" | "blocker" | "resolve-id" => {
                    let value = inline
                        .or_else(|| options.next().and_then(|value| value.to_str()))
                        .filter(|value| !value.is_empty() && !value.starts_with("--"))
                        .ok_or_else(|| format!("Missing value for --{key}"))?;
                    flags.entry(key).or_default().push(value);
                }
                _ => return Err(format!("Unknown memory option --{key}").into()),
            }
        } else {
            words.push(token);
        }
    }
    let get = |key: &str| flags.get(key).and_then(|list| list.last()).copied();
    let required = |key: &str| get(key).ok_or_else(|| format!("Supply --{key}"));
    let list = |key: &str| flags.get(key).cloned().unwrap_or_default();
    if let Some(state) = get("state") {
        crate::project_paths::STATE_OVERRIDE
            .set(std::path::absolute(state)?)
            .map_err(|_| "SpoolDB state is already selected")?;
    }
    let cwd = get("root")
        .map(PathBuf::from)
        .map_or_else(std::env::current_dir, Ok)?;
    let binding = if let Some(selector) = get("project") {
        let mut selected = None;
        for root in project_binding::registered_roots()? {
            let Ok(binding) = project_binding::resolve(&root) else {
                continue;
            };
            if binding.local_id == selector
                || binding
                    .grant
                    .as_ref()
                    .is_some_and(|grant| grant.room == selector)
                || binding.root.file_name().and_then(|name| name.to_str()) == Some(selector)
            {
                if selected.is_some() {
                    return Err("Ambiguous project selector. Use --root or a project ID".into());
                }
                selected = Some(binding);
            }
        }
        let binding = selected.ok_or("The selected project is unavailable")?;
        if get("root").is_some() && project_binding::repository_root(&cwd)? != binding.root {
            return Err("Project selector differs from the current repository".into());
        }
        binding
    } else {
        project_binding::resolve(&cwd)?
    };
    let mut input = json!({"command":command});
    if let Some(task) = get("task") {
        input["taskId"] = json!(task);
    }
    match action {
        "context" | "search" => {
            input["query"] = json!(words.join(" "));
            for field in ["offset", "limit"] {
                if let Some(value) = get(field) {
                    input[field] = json!(value.parse::<u64>()?);
                }
            }
            if action == "search"
                && let Some(kind) = get("kind")
            {
                input["kinds"] = json!([kind]);
            }
        }
        "get" => input["id"] = json!(words.first().ok_or("Specify a memory record ID")?),
        _ => {
            if get("text-file").is_some() && flags.contains_key("text-stdin") {
                return Err("Use one text source".into());
            }
            let mut text = String::new();
            if let Some(path) = get("text-file") {
                std::fs::File::open(Path::new(path))?
                    .take(4_000_001)
                    .read_to_string(&mut text)?;
            } else if flags.contains_key("text-stdin") {
                std::io::stdin().take(4_000_001).read_to_string(&mut text)?;
            }
            if text.is_empty() || text.len() > 4_000_000 {
                return Err("Supply memory text using --text-file or --text-stdin".into());
            }
            input["text"] = json!(text);
            input["title"] = json!(required("title")?);
            input["requestId"] = json!(
                get("request-id")
                    .map(str::to_owned)
                    .map_or_else(private_files::random_id, Ok)?
            );
            input["files"] = json!(list("file"));
            input["refs"] = json!(list("ref"));
            project_binding::check_files(&binding.root, &input["files"])?;
            let (git, references) = git_evidence::checkpoint(&binding.root, &input["files"]);
            input["git"] = git;
            input["codeReferences"] = references;
            match action {
                "remember" => input["kind"] = json!(get("kind").unwrap_or("finding")),
                "handoff" => {
                    input["nextSteps"] = json!(list("next-step"));
                    input["blockers"] = json!(list("blocker"));
                }
                _ => {
                    input["taskId"] = json!(words.first().ok_or("Supply a task ID")?);
                    input["expectedRevision"] = json!(required("revision")?.parse::<u64>()?);
                    input["status"] = json!(required("status")?);
                    input["resolveIds"] = json!(list("resolve-id"));
                }
            }
        }
    }
    let mut response = binding.memory(&input)?;
    if matches!(action, "context" | "search" | "get") {
        git_evidence::reconcile(&binding.root, &mut response);
    }
    if matches!(action, "context" | "search")
        && let Ok(Some(parent)) = binding.linked_parent()
    {
        let mut query = json!({"command":command,"query":input["query"]});
        if let Some(kinds) = input.get("kinds") {
            query["kinds"] = kinds.clone();
        }
        let mut parent_memory = parent.memory(&query).unwrap_or(Value::Null);
        git_evidence::reconcile(&parent.root, &mut parent_memory);
        response["linkedParent"] = json!({"project":parent.info(),"memory":parent_memory});
    }
    println!("{response}");
    Ok(())
}
