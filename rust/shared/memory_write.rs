use serde_json::{Value, json};

pub struct Fault(pub u16, pub &'static str, pub String);

pub fn bad(code: &'static str, message: &str) -> Fault {
    Fault(400, code, message.to_owned())
}

pub fn text<'a>(value: &'a Value, title: &str, max: usize) -> Result<&'a str, Fault> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max)
        .ok_or_else(|| bad("INVALID_MEMORY", &format!("Invalid {title}")))
}

pub fn task_id(value: &Value) -> Result<&str, Fault> {
    let value = text(value, "task ID", 160)?;
    if !value.as_bytes().split_first().is_some_and(|(first, rest)| {
        first.is_ascii_alphanumeric()
            && rest
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || b"._/-".contains(c))
    }) {
        return Err(bad("INVALID_TASK", "Use a short task identifier"));
    }
    Ok(value)
}

pub fn list(value: &Value) -> Result<Vec<String>, Fault> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let items: Vec<String> =
        serde_json::from_value(value.clone()).map_err(|_| bad("INVALID_MEMORY", "Invalid list"))?;
    if items.len() > 30 || items.iter().any(|s| s.encode_utf16().count() > 1000) {
        return Err(bad("INVALID_MEMORY", "Invalid list"));
    }
    Ok(items)
}

pub fn prepare(input: &Value, principal: &str, now: &str) -> Result<Value, Fault> {
    let kind = match input["command"].as_str() {
        Some("task_update") => "task",
        Some("handoff") => "handoff",
        _ => input["kind"]
            .as_str()
            .filter(|k| matches!(*k, "finding" | "decision" | "blocker" | "handoff" | "task"))
            .ok_or_else(|| {
                bad(
                    "INVALID_KIND",
                    "Choose finding, decision, blocker, handoff or task",
                )
            })?,
    };
    let title = text(&input["title"], "title", 300)?;
    let body = text(&input["text"], "memory text", 12_000)?;
    let session = input
        .get("sessionId")
        .map(|value| text(value, "session identity", 200))
        .transpose()?;
    if kind == "task" || !input["taskId"].is_null() && input["taskId"] != "" {
        task_id(&input["taskId"])?;
    }
    let mut event = json!({"protocol":"spool-memory/1","kind":kind,"title":title,"text":body,
        "taskId":input["taskId"],"actor":principal,"sessionId":session,"createdAt":now,"refs":list(&input["refs"])?,"files":[]});
    if kind == "handoff" {
        if let Some(value) = input.get("handoffGroup") {
            if !value.as_str().is_some_and(|s| hex(s, 64)) {
                return Err(bad("HANDOFF_GROUP", "Invalid handoff grouping key"));
            }
            event["handoffGroup"] = value.clone();
        }
        let steps = list(&input["nextSteps"])
            .map_err(|_| bad("HANDOFF_FORMAT", "Handoff action lists must contain text"))?;
        let blockers = list(&input["blockers"])
            .map_err(|_| bad("HANDOFF_FORMAT", "Handoff action lists must contain text"))?;
        let count = title.chars().count()
            + body.chars().count()
            + 1
            + steps
                .iter()
                .chain(&blockers)
                .map(|s| s.chars().count() + 1)
                .sum::<usize>();
        if title.chars().count() > 120
            || body.chars().count() > 1500
            || count > 2000
            || steps.len() > 3
            || blockers.len() > 3
            || steps
                .iter()
                .chain(&blockers)
                .any(|s| s.chars().count() > 160)
        {
            return Err(bad(
                "HANDOFF_TOO_LONG",
                "Keep handoffs within 2,000 characters, including a title up to 120 characters, a summary up to 1,500, and at most 3 next steps and 3 blockers of 160 characters each.",
            ));
        }
        event["nextSteps"] = json!(steps);
        event["blockers"] = json!(blockers);
    }
    Ok(event)
}

fn hex(s: &str, length: usize) -> bool {
    s.len() == length
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn git_reference(value: &Value) -> Result<Value, Fault> {
    let invalid = || bad("GIT_REFERENCE", "Invalid Git reference metadata");
    let input = value.as_object().ok_or_else(invalid)?;
    for (key, value) in input {
        let valid = match key.as_str() {
            "path" => value.as_str().is_some_and(|p| {
                !p.is_empty()
                    && p.encode_utf16().count() <= 1000
                    && !p.split('/').any(|s| matches!(s, "" | "." | ".."))
                    && !p.contains('\\')
            }),
            "repository" | "branch" | "capturedAt" | "verificationError" => {
                value.is_null()
                    || value.as_str().is_some_and(|s| {
                        s.encode_utf16().count() <= 1000 && !s.chars().any(|c| c <= '\u{1f}')
                    })
            }
            "commit" => value.is_null() || value.as_str().is_some_and(|s| hex(s, 40) || hex(s, 64)),
            "contentHash" => value.as_str().is_some_and(|s| hex(s, 64)),
            "worktreeHash" => value.is_null() || value.as_str().is_some_and(|s| hex(s, 64)),
            "dirty" | "remoteKnown" => value.is_null() || value.is_boolean(),
            "legacySnapshotReference" | "verified" => value.is_boolean(),
            "submodules" => {
                let rows = value
                    .as_array()
                    .filter(|a| a.len() <= 256)
                    .ok_or_else(invalid)?;
                let mut seen = std::collections::BTreeSet::new();
                for sub in rows {
                    let mut sub = sub.as_object().cloned().ok_or_else(invalid)?;
                    if !sub.remove("initialized").is_some_and(|v| v.is_boolean())
                        || !sub
                            .remove("expectedCommit")
                            .is_some_and(|v| v.as_str().is_some_and(|s| hex(s, 40) || hex(s, 64)))
                        || !sub.keys().all(|k| {
                            matches!(
                                k.as_str(),
                                "path" | "commit" | "repository" | "dirty" | "verified"
                            )
                        })
                    {
                        return Err(invalid());
                    }
                    let clean = git_reference(&Value::Object(sub))?;
                    let path = clean["path"].as_str().ok_or_else(invalid)?;
                    if !seen.insert(path.to_owned()) {
                        return Err(invalid());
                    }
                }
                true
            }
            _ => false,
        };
        if !valid {
            return Err(invalid());
        }
    }
    Ok(value.clone())
}

pub fn references(input: &Value, event: &mut Value) -> Result<(), Fault> {
    if let Some(git) = input.get("git") {
        event["git"] = git_reference(git)?;
    }
    if let Some(commits) = input.get("commits") {
        let commits = list(commits)?;
        for commit in &commits {
            git_reference(&json!({"commit":commit}))?;
        }
        event["commits"] = json!(commits);
    }
    let files = if let Some(refs) = input.get("codeReferences") {
        refs.as_array()
            .filter(|a| a.len() <= 30)
            .cloned()
            .ok_or_else(|| bad("GIT_REFERENCE", "Too many file references"))?
    } else {
        list(&input["files"])?
            .into_iter()
            .map(|path| {
                let mut value = event["git"]
                    .as_object()
                    .cloned()
                    .map(Value::Object)
                    .unwrap_or_else(|| json!({}));
                value["path"] = json!(path);
                value
            })
            .collect()
    };
    event["files"] = json!(
        files
            .iter()
            .map(|value| {
                if !value["path"].is_string() {
                    return Err(bad("GIT_REFERENCE", "File references need a path"));
                }
                git_reference(value)
            })
            .collect::<Result<Vec<_>, _>>()?
    );
    Ok(())
}

pub fn equivalent(old: &Value, new: &Value, fields: &[&str]) -> bool {
    fn clean(value: &Value) -> Value {
        match value {
            Value::Object(data) => Value::Object(
                data.iter()
                    .filter(|(key, _)| *key != "capturedAt")
                    .map(|(key, v)| (key.clone(), clean(v)))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(clean).collect()),
            value => value.clone(),
        }
    }
    fields
        .iter()
        .all(|key| clean(&old[*key]) == clean(&new[*key]))
}

pub fn apply_sharing(input: &Value, sharing: &Value) -> Result<Value, Fault> {
    let category = match input["command"].as_str() {
        Some("task_update") => Some("tasks"),
        Some("handoff") => Some("handoffs"),
        Some("remember") => match input["kind"].as_str() {
            Some("task") => Some("tasks"),
            Some("handoff") => Some("handoffs"),
            Some("finding" | "blocker") => Some("findings"),
            Some("decision") => Some("decisions"),
            _ => None,
        },
        _ => None,
    };
    let excerpt = input["text"].as_str().is_some_and(|text| {
        text.starts_with("Current request (source text, not verified findings):\n")
            || text.starts_with("Automatic lifecycle checkpoint; agent-authored next steps and verification were not supplied.")
    });
    let blocked = if excerpt && sharing["conversations"] == false {
        Some("conversations")
    } else {
        category.filter(|category| sharing[*category] == false)
    };
    if let Some(category) = blocked {
        return Err(Fault(
            403,
            "SHARING_DISABLED",
            format!("Sharing is off for {category}. This item was not saved to the relay."),
        ));
    }
    let mut input = input.clone();
    if sharing["tasks"] == false
        && category.is_some_and(|category| category != "tasks")
        && let Some(fields) = input.as_object_mut()
    {
        fields.remove("taskId");
    }
    Ok(input)
}
