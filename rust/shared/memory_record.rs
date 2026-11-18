use serde_json::{Value, json};

fn text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.encode_utf16().count() <= max)
}

fn revision(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
}

pub fn valid_event(value: &Value) -> bool {
    let kind = value["kind"].as_str();
    if value["protocol"] != "spool-memory/1"
        || !matches!(
            kind,
            Some("task" | "finding" | "decision" | "blocker" | "handoff")
        )
        || !text(&value["title"], 500)
        || !text(&value["text"], 16_000)
    {
        return false;
    }
    for key in ["actor", "sessionId", "createdAt", "taskId"] {
        let max = if key == "taskId" { 160 } else { 300 };
        if !value[key].is_null() && !text(&value[key], max) {
            return false;
        }
    }
    for key in ["refs", "nextSteps", "blockers", "resolveIds", "commits"] {
        if let Some(items) = value.get(key)
            && !items
                .as_array()
                .is_some_and(|items| items.len() <= 30 && items.iter().all(|item| text(item, 1000)))
        {
            return false;
        }
    }
    if value.get("handoffGroup").is_some_and(|group| {
        kind != Some("handoff")
            || !group.as_str().is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
    }) {
        return false;
    }
    if value.get("files").is_some_and(|files| {
        !files
            .as_array()
            .is_some_and(|files| files.len() <= 30 && files.iter().all(Value::is_object))
    }) || value.get("git").is_some_and(|git| !git.is_object())
    {
        return false;
    }
    let status = matches!(
        value["status"].as_str(),
        Some("open" | "in_progress" | "blocked" | "done")
    );
    if value.get("status").is_some() && !status
        || value.get("revision").is_some_and(|item| !revision(item))
        || kind == Some("task")
            && (value["taskId"].as_str().is_none_or(str::is_empty)
                || !revision(&value["revision"])
                || !status)
    {
        return false;
    }
    for key in ["lifecycleControl", "importedFromLocal"] {
        if value.get(key).is_some_and(|item| !item.is_boolean()) {
            return false;
        }
    }
    !value.get("lifecycleChanges").is_some_and(|items| {
        !items
            .as_array()
            .is_some_and(|items| items.len() <= 60 && items.iter().all(valid_transition))
    })
}

fn valid_transition(change: &Value) -> bool {
    let identity =
        |value: &Value| text(value, 200) && value.as_str().is_some_and(|id| !id.is_empty());
    identity(&change["targetId"])
        && matches!(
            change["status"].as_str(),
            Some("active" | "archived" | "resolved" | "superseded")
        )
        && revision(&change["revision"])
        && change.get("replacementId").is_none_or(identity)
        && text(&change["reason"], 1000)
}

pub fn lifecycle_transition(
    current: Option<&Value>,
    source_id: &str,
    event: &Value,
    change: &Value,
) -> Option<Value> {
    if !valid_transition(change) || change["targetId"] == source_id {
        return None;
    }
    let revision = change["revision"].as_u64()?;
    if let Some(current) = current {
        let prior = current["revision"].as_u64()?;
        if prior > revision {
            return None;
        }
        if prior == revision {
            let mut conflicts = current["conflicts"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![current["sourceId"].clone()]);
            let source = json!(source_id);
            if !conflicts.contains(&source) {
                conflicts.push(source);
            }
            return Some(json!({"status":"conflict","revision":revision,"conflicts":conflicts}));
        }
    }
    let mut state = change.clone();
    state["sourceId"] = json!(source_id);
    for (target, field) in [("actor", "actor"), ("changedAt", "createdAt")] {
        if let Some(value) = event.get(field) {
            state[target] = value.clone();
        }
    }
    Some(state)
}
