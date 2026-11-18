use crate::memory_write::{self, Fault, bad};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

type Result<T> = std::result::Result<T, Fault>;

const TASK_FIELDS: &[&str] = &[
    "actor",
    "sessionId",
    "title",
    "text",
    "status",
    "files",
    "refs",
    "git",
    "commits",
];
const FINDING_FIELDS: &[&str] = &[
    "actor",
    "sessionId",
    "taskId",
    "files",
    "refs",
    "git",
    "commits",
];
const HANDOFF_FIELDS: &[&str] = &[
    "title",
    "text",
    "nextSteps",
    "blockers",
    "files",
    "refs",
    "git",
    "commits",
];

pub trait Backend {
    fn query(&self, sql: &str, bindings: &[&str]) -> Result<Vec<String>>;
    fn execute(&self, sql: &str, bindings: &[&str]) -> Result<()>;
    fn heads(&self, room: &str) -> Result<Vec<String>>;
    fn observation(&self) -> Result<(String, String)>;
    fn published_file(&self, room: &str, path: &str) -> Result<Option<Value>>;
    fn publish(&self, room: &str, input: &Value) -> Result<Value>;
}

fn internal<E>(_: E) -> Fault {
    Fault(500, "INTERNAL", "Relay unavailable".to_owned())
}

fn missing(code: &'static str, message: &str) -> Fault {
    Fault(404, code, message.to_owned())
}
fn conflict(code: &'static str, message: &str) -> Fault {
    Fault(409, code, message.to_owned())
}

pub fn command(input: &Value) -> bool {
    matches!(
        input["command"].as_str(),
        Some("remember" | "handoff" | "task_update")
    )
}

pub fn write(
    db: &impl Backend,
    room: &str,
    input: &Value,
    principal: &str,
    references_only: bool,
) -> Result<Value> {
    let request_id = memory_write::text(&input["requestId"], "request ID", 200)?;
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(input).map_err(internal)?)
    );
    let receipt = db.query(
        "SELECT json_array(input,result) FROM memory_write_receipts WHERE room=?1 AND principal=?2 AND request_id=?3",
        &[room,principal,request_id],
    )?;
    if let Some(row) = receipt.first() {
        let (old, result): (String, String) = serde_json::from_str(row).map_err(internal)?;
        if old != digest {
            return Err(conflict(
                "REQUEST_CONFLICT",
                "Request ID reused with different memory",
            ));
        }
        return serde_json::from_str(&result).map_err(internal);
    }
    let save = |result: Value| -> Result<Value> {
        db.execute(
            "INSERT INTO memory_write_receipts VALUES(?1,?2,?3,?4,?5)",
            &[
                room,
                principal,
                request_id,
                &digest,
                &serde_json::to_string(&result).map_err(internal)?,
            ],
        )?;
        Ok(result)
    };
    let heads = db.heads(room)?;
    let (uuid, now) = db.observation()?;
    let id = format!("memory-{uuid}");
    let mut event = memory_write::prepare(input, principal, &now)?;
    let kind = event["kind"]
        .as_str()
        .ok_or_else(|| internal("kind"))?
        .to_owned();
    let task = event["taskId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let has_changes = !input["lifecycle"].is_null()
        || ["supersedes", "resolves"]
            .iter()
            .any(|k| input[*k].as_array().is_some_and(|a| !a.is_empty()));
    let current = match &task {
        Some(task) => current_task(db, room, task)?,
        None => None,
    };
    if kind == "task" {
        let revision = current
            .as_ref()
            .and_then(|row| row["revision"].as_u64())
            .unwrap_or(0);
        if input["expectedRevision"].as_u64() != Some(revision) {
            return Err(conflict(
                "TASK_CONFLICT",
                &format!("Task changed; retrieve it again. Current revision: {revision}"),
            ));
        }
        if let Some(resolve) = current
            .as_ref()
            .and_then(|row| row["conflicts"].as_array())
            .filter(|a| !a.is_empty())
        {
            let mut required: Vec<_> = resolve.iter().filter_map(Value::as_str).collect();
            required.sort_unstable();
            let mut supplied = memory_write::list(&input["resolveIds"])?;
            supplied.sort_unstable();
            if supplied != required {
                return Err(conflict(
                    "TASK_CONFLICT",
                    "Resolve every conflicting task record explicitly",
                ));
            }
            event["resolveIds"] = json!(supplied);
        }
        if !matches!(
            input["status"].as_str(),
            Some("open" | "in_progress" | "blocked" | "done")
        ) {
            return Err(bad(
                "INVALID_STATUS",
                "Choose open, in_progress, blocked or done",
            ));
        }
        event["status"] = input["status"].clone();
        event["revision"] = json!(revision + 1);
    } else if task.is_some() && current.is_none() {
        return Err(missing(
            "TASK_NOT_FOUND",
            "Create the task before attaching memory",
        ));
    }
    if references_only {
        memory_write::references(input, &mut event)?;
    } else {
        for path in memory_write::list(&input["files"])? {
            let file = db.published_file(room, &path)?.ok_or_else(|| {
                missing(
                    "SOURCE_NOT_FOUND",
                    &format!("File is not captured in this project: {path}"),
                )
            })?;
            event["files"]
                .as_array_mut()
                .ok_or_else(|| internal("files"))?
                .push(file);
        }
    }
    for id in memory_write::list(&event["refs"])? {
        if !exists(db, room, &id)? {
            return Err(missing(
                "SOURCE_NOT_FOUND",
                "Referenced memory is not in this project",
            ));
        }
    }
    let result = |record: &Value, unchanged: bool| {
        let id = &record["id"];
        let citation = format!(
            "tw://rooms/{room}/messages/{}",
            id.as_str().unwrap_or_default()
        );
        let mut value = json!({"id":id,"kind":kind,"taskId":event["taskId"],"revision":record["revision"],"heads":heads,"citation":citation});
        if unchanged {
            value["unchanged"] = json!(true);
        }
        value
    };
    if kind == "task"
        && !has_changes
        && memory_write::list(&input["resolveIds"])?.is_empty()
        && let Some(current) = &current
        && current["conflicts"].as_array().is_some_and(Vec::is_empty)
        && memory_write::equivalent(current, &event, TASK_FIELDS)
    {
        return save(result(current, true));
    }
    let mut replaces = memory_write::list(&input["supersedes"])?;
    if matches!(kind.as_str(), "finding" | "decision" | "blocker")
        && !has_changes
        && task.is_some()
        && event["sessionId"].is_string()
    {
        for old in active_cards(db, room, &kind)? {
            if old["title"] == event["title"]
                && old["text"] == event["text"]
                && memory_write::equivalent(&old, &event, FINDING_FIELDS)
            {
                return save(result(&old, true));
            }
        }
    }
    if kind == "handoff" && input["lifecycle"].is_null() {
        let prior: Vec<_> = active_cards(db, room, "handoff")?
            .into_iter()
            .filter(|old| {
                old["actor"] == principal
                    && (task.as_ref().is_some_and(|id| old["taskId"] == id.as_str())
                        || !event["handoffGroup"].is_null()
                            && old["handoffGroup"] == event["handoffGroup"]
                        || task.is_none()
                            && event["handoffGroup"].is_null()
                            && event["sessionId"].is_string()
                            && old["taskId"].is_null()
                            && old["handoffGroup"].is_null()
                            && old["sessionId"] == event["sessionId"])
            })
            .collect();
        let automatic = |row: &Value| {
            matches!(
                row["title"].as_str(),
                Some("Automatic Codex checkpoint" | "Interrupted Codex checkpoint")
            )
        };
        let retained = if automatic(&event) {
            prior.iter().find(|old| !automatic(old))
        } else {
            None
        };
        if let Some(old) = retained.or_else(|| {
            (prior.len() == 1
                && !has_changes
                && memory_write::equivalent(&prior[0], &event, HANDOFF_FIELDS))
            .then(|| &prior[0])
        }) {
            return save(result(old, true));
        }
        for old in &prior {
            if let Some(id) = old["id"].as_str()
                && !replaces.iter().any(|old| old == id)
            {
                replaces.push(id.to_owned());
            }
        }
    }
    let changes = transitions(db, room, input, &replaces, &id)?;
    if !changes.is_empty() {
        event["lifecycleChanges"] = json!(changes);
    }
    if !input["lifecycle"].is_null() {
        event["lifecycleControl"] = json!(true);
    }
    if !crate::memory_record::valid_event(&event) {
        return Err(bad(
            "INVALID_MEMORY",
            "Memory fields or lifecycle changes exceed the stored record limits",
        ));
    }
    let stored = db.publish(room,&json!({
        "actor":principal,"messageId":id,"role":"system","text":serde_json::to_string(&event).map_err(internal)?,
        "expectedHeads":heads,"harness":"spool-memory","sessionId": event["sessionId"].as_str().unwrap_or("memory-api"),
        "evidence":"agent-claimed-memory",
    }))?;
    save(
        json!({"id":id,"kind":kind,"taskId":event["taskId"],"revision":event["revision"],
        "heads":stored["heads"],"citation":format!("tw://rooms/{room}/messages/{id}")}),
    )
}

fn exists(db: &impl Backend, room: &str, id: &str) -> Result<bool> {
    Ok(!db
        .query(
            "SELECT id FROM memory_docs WHERE room=?1 AND id=?2",
            &[room, id],
        )?
        .is_empty())
}

fn current_task(db: &impl Backend, room: &str, task: &str) -> Result<Option<Value>> {
    let rows = db.query(
        "SELECT data FROM memory_docs WHERE room=?1 AND task_id=?2 AND kind='task'
         ORDER BY CAST(json_extract(data,'$.revision') AS INTEGER) DESC,seq DESC,rowid DESC",
        &[room, task],
    )?;
    let mut rows = rows
        .iter()
        .map(|row| serde_json::from_str::<Value>(row).map_err(internal));
    let Some(mut latest) = rows.next().transpose()? else {
        return Ok(None);
    };
    let mut conflicts = vec![latest["id"].clone()];
    for row in rows {
        let old = row?;
        if old["revision"] != latest["revision"] {
            break;
        }
        conflicts.push(old["id"].clone());
    }
    if conflicts.len() == 1 {
        conflicts.clear();
    }
    latest["conflicts"] = json!(conflicts);
    Ok(Some(latest))
}

fn active_cards(db: &impl Backend, room: &str, kind: &str) -> Result<Vec<Value>> {
    db.query(
        "SELECT d.data FROM memory_docs d LEFT JOIN memory_state s ON s.room=d.room AND s.id=d.id
         WHERE d.room=?1 AND d.kind=?2 AND COALESCE(json_extract(d.data,'$.lifecycleControl'),0)<>1
         AND COALESCE(s.status,'active') NOT IN ('archived','resolved','superseded') ORDER BY d.seq DESC",
        &[room,kind],
    )?.iter().map(|row|serde_json::from_str(row).map_err(internal)).collect()
}

fn transitions(
    db: &impl Backend,
    room: &str,
    input: &Value,
    replaces: &[String],
    id: &str,
) -> Result<Vec<Value>> {
    let mut changes = Vec::new();
    let mut seen = BTreeSet::new();
    let mut add = |target: &str,
                   status: &str,
                   replacement: Option<&str>,
                   reason: &str,
                   revision: Option<u64>,
                   resolve: &Value|
     -> Result<()> {
        if target.is_empty()
            || target.encode_utf16().count() > 200
            || !seen.insert(target.to_owned())
        {
            return Err(bad(
                "MEMORY_LIFECYCLE",
                "Choose distinct records from this project",
            ));
        }
        let data = db.query(
            "SELECT data FROM memory_docs WHERE room=?1 AND id=?2",
            &[room, target],
        )?;
        if data.first().is_none_or(|data| {
            serde_json::from_str::<Value>(data).is_ok_and(|data| data["lifecycleControl"] == true)
        }) {
            return Err(missing(
                "MEMORY_NOT_FOUND",
                "Target memory is not in this project",
            ));
        }
        let state = state(db, room, target)?;
        let current = state["revision"].as_u64().unwrap_or(0);
        if revision.is_some_and(|expected| expected != current) {
            return Err(conflict(
                "MEMORY_CONFLICT",
                "Record state changed; retrieve it before updating",
            ));
        }
        if let Some(required) = state["conflicts"].as_array() {
            let expected: BTreeSet<_> = required.iter().filter_map(Value::as_str).collect();
            let supplied = memory_write::list(resolve)?;
            if supplied.len() != required.len()
                || supplied.iter().map(String::as_str).collect::<BTreeSet<_>>() != expected
            {
                return Err(conflict(
                    "MEMORY_CONFLICT",
                    "Resolve every conflicting state update explicitly",
                ));
            }
        }
        if let Some(rep) = replacement.filter(|rep| *rep != id) {
            if rep == target || !exists(db, room, rep)? {
                return Err(missing(
                    "MEMORY_NOT_FOUND",
                    "Replacement must be another record in this project",
                ));
            }
            if state_at(db, room, rep)? != "active" {
                return Err(bad(
                    "MEMORY_LIFECYCLE",
                    "The replacement must be active; restore or resolve it first",
                ));
            }
        }
        let reason =
            String::from_utf16_lossy(&reason.encode_utf16().take(1000).collect::<Vec<_>>());
        let mut change =
            json!({"targetId":target,"status":status,"revision":current+1,"reason":reason});
        if let Some(rep) = replacement {
            change["replacementId"] = json!(rep);
        }
        changes.push(change);
        Ok(())
    };
    if let Some(value) = input.get("lifecycle").filter(|v| !v.is_null()) {
        let status = match value["action"].as_str() {
            Some("archive") => "archived",
            Some("restore") => "active",
            Some("resolve") => "resolved",
            Some("supersede") => "superseded",
            _ => {
                return Err(bad(
                    "MEMORY_LIFECYCLE",
                    "Choose an action and the current state revision",
                ));
            }
        };
        let revision = value["expectedRevision"].as_u64().ok_or_else(|| {
            bad(
                "MEMORY_LIFECYCLE",
                "Choose an action and the current state revision",
            )
        })?;
        let replacement = value["replacementId"].as_str();
        if status == "superseded" && replacement.is_none() {
            return Err(bad(
                "MEMORY_LIFECYCLE",
                "Superseding a record needs its replacement",
            ));
        }
        add(
            value["id"].as_str().unwrap_or_default(),
            status,
            replacement,
            input["text"].as_str().unwrap_or_default(),
            Some(revision),
            &value["resolveIds"],
        )?;
    }
    for target in replaces {
        add(
            target,
            "superseded",
            Some(id),
            input["title"].as_str().unwrap_or_default(),
            None,
            &Value::Null,
        )?;
    }
    for target in memory_write::list(&input["resolves"])? {
        add(
            &target,
            "resolved",
            Some(id),
            input["title"].as_str().unwrap_or_default(),
            None,
            &Value::Null,
        )?;
    }
    Ok(changes)
}

fn state(db: &impl Backend, room: &str, id: &str) -> Result<Value> {
    db.query(
        "SELECT data FROM memory_state WHERE room=?1 AND id=?2",
        &[room, id],
    )?
    .first()
    .map(|row| serde_json::from_str(row).map_err(internal))
    .transpose()
    .map(|value| value.unwrap_or_else(|| json!({"status":"active","revision":0})))
}
fn state_at(db: &impl Backend, room: &str, id: &str) -> Result<String> {
    Ok(state(db, room, id)?["status"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}
