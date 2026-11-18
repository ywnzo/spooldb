use crate::{
    Result, bundles::validate_adapter, git_bridge::storage, private_files, shards,
    storage_cli::field,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const SCHEMA:&str="
CREATE TABLE IF NOT EXISTS adapter_streams(id TEXT PRIMARY KEY,branch TEXT NOT NULL,harness TEXT NOT NULL,
  next_sequence INTEGER NOT NULL,state TEXT NOT NULL,prompt_id TEXT);
CREATE TABLE IF NOT EXISTS adapter_receipts(stream_id TEXT NOT NULL,sequence INTEGER NOT NULL,digest TEXT NOT NULL,
  result TEXT NOT NULL,PRIMARY KEY(stream_id,sequence));
";

fn digest(value: &Value) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn string<'a>(value: &'a Value, label: &str, max: usize) -> Result<&'a str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= max)
        .ok_or_else(|| format!("Invalid {label}").into())
}

fn assign_session(state: &mut Value, id: &Value) -> Result<()> {
    let id = string(id, "native session ID", 200)?;
    if state["sessionId"]
        .as_str()
        .is_some_and(|active| active != id)
    {
        return Err("Native session changed within stream".into());
    }
    state["sessionId"] = json!(id);
    Ok(())
}

fn begin_turn(state: &mut Value, events: &mut Vec<Value>) -> Result<()> {
    if state["sessionId"].is_null() {
        return Err("Session must start before a turn".into());
    }
    let counter = state["turnCounter"]
        .as_u64()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("Turn counter exhausted")?;
    state["turnCounter"] = json!(counter);
    state["assistantSeen"] = json!(false);
    state["turnId"] = json!(format!("{}-turn-{counter}", field(state, "streamId")?));
    state["status"] = json!("running");
    events.push(event("turn.started", json!({})));
    Ok(())
}

fn event(kind: &str, payload: Value) -> Value {
    json!({"kind":kind,"payload":payload})
}
fn notice(reason: &str) -> Value {
    event("notice", json!({"reason":reason}))
}

fn normalize_codex(
    raw: &Value,
    kind: &str,
    state: &mut Value,
    events: &mut Vec<Value>,
) -> Result<()> {
    match kind {
        "thread.started" => {
            assign_session(state, &raw["thread_id"])?;
            state["status"] = json!("running");
            events.push(event("session.started", json!({})));
        }
        "turn.started" => begin_turn(state, events)?,
        "turn.completed" | "turn.failed" | "error" => {
            let (status, kind) = if kind == "turn.completed" {
                ("completed", "turn.completed")
            } else {
                ("failed", "turn.failed")
            };
            state["status"] = json!(status);
            let text = raw["error"]["message"]
                .as_str()
                .or_else(|| raw["message"].as_str());
            let payload = if let Some(text) = text.filter(|text| !text.is_empty()) {
                json!({"text":text})
            } else {
                json!({})
            };
            events.push(event(kind, payload));
        }
        "item.started" | "item.updated" | "item.completed" => {
            let item = &raw["item"];
            if !item.is_object() {
                return Err("Missing Codex item".into());
            }
            events.push(match item["type"].as_str(){
                Some("reasoning")=>notice("reasoning-omitted"),
                Some("agent_message") if kind=="item.completed"=>event("message",json!({
                    "role":"assistant","text":item["text"].as_str().unwrap_or_default(),
                    "nativeId":string(&item["id"],"item ID",200)?
                })),
                Some("agent_message")=>notice("partial-message-omitted"),
                Some("command_execution"|"file_change"|"mcp_tool_call"|"web_search") if kind=="item.updated"=>
                    notice("intermediate-tool-update-omitted"),
                Some(name @ ("command_execution"|"file_change"|"mcp_tool_call"|"web_search"))=>{
                    let status=item["status"].as_str().unwrap_or("unknown");
                    let mut payload=json!({"toolCallId":string(&item["id"],"tool call ID",200)?,"name":name,"status":status});
                    for (source,target) in [("command","input"),("aggregated_output","output"),("tool","tool"),("server","server")]{
                        if let Some(value)=item.get(source){payload[target]=value.clone();}
                    }
                    if name=="file_change" {
                        let paths=item["changes"].as_array().into_iter().flatten().map(|change|string(&change["path"],"native file path",4096)).collect::<Result<Vec<_>>>()?;
                        payload["paths"]=json!(paths);
                    }
                    event(if kind=="item.started"{"tool.started"}else{"tool.completed"},payload)
                }
                _=>notice("unsupported-item"),
            });
        }
        _ => events.push(notice("unsupported-event")),
    }
    Ok(())
}

fn normalize_claude(
    raw: &Value,
    kind: &str,
    state: &mut Value,
    events: &mut Vec<Value>,
) -> Result<()> {
    if !raw["session_id"].is_null() && raw["session_id"] != "" {
        assign_session(state, &raw["session_id"])?;
    }
    if kind == "system" && raw["subtype"] == "init" {
        state["status"] = json!("running");
        events.push(event("session.started", json!({})));
        return begin_turn(state, events);
    }
    if raw["parent_tool_use_id"]
        .as_str()
        .is_some_and(|value| !value.is_empty())
    {
        events.push(notice("subagent-event-omitted"));
        return Ok(());
    }
    match kind {
        "assistant" | "user" => {
            let message = &raw["message"];
            let blocks = message["content"]
                .as_array()
                .ok_or("Missing Claude message content")?;
            for (index, block) in blocks.iter().enumerate() {
                events.push(match block["type"].as_str(){
                    Some("text")=>{
                        let id=message["id"].as_str().or_else(||raw["uuid"].as_str()).unwrap_or("message");
                        event("message",json!({"role":kind,"text":block["text"],"nativeId":format!("{id}-{index}")}))
                    }
                    Some("tool_use")=>event("tool.started",json!({"toolCallId":block["id"],"name":block["name"],
                        "input":if block["input"].is_null(){"{}".into()}else{serde_json::to_string(&block["input"])?}})),
                    Some("tool_result")=>{
                        let output=block["content"].as_str().map(str::to_owned).unwrap_or_else(||block["content"]
                            .as_array().into_iter().flatten().filter(|part|part["type"]=="text")
                            .filter_map(|part|part["text"].as_str()).collect::<Vec<_>>().join("\n"));
                        event("tool.completed",json!({"toolCallId":block["tool_use_id"],"name":"tool_result",
                            "status":if block["is_error"]==true{"failed"}else{"completed"},"output":output}))
                    }
                    Some("thinking"|"redacted_thinking")=>notice("reasoning-omitted"),
                    _=>notice("unsupported-content"),
                });
            }
        }
        "result" => {
            let failed = raw["is_error"] == true || raw["subtype"] != "success";
            state["status"] = json!(if failed { "failed" } else { "completed" });
            if state["assistantSeen"] != true && raw["result"].is_string() {
                events.push(event("message",json!({"role":"assistant","text":raw["result"],"nativeId":raw["uuid"].as_str().unwrap_or("result")})));
            }
            events.push(event(
                if failed {
                    "turn.failed"
                } else {
                    "turn.completed"
                },
                json!({"status":raw["subtype"].as_str().unwrap_or("unknown")}),
            ));
        }
        "stream_event" => events.push(notice("partial-event-omitted")),
        _ => events.push(notice("unsupported-event")),
    }
    Ok(())
}

pub(crate) fn stream(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    let (branch, harness, next_sequence, state, prompt_id) = tx
        .query_row(
            "SELECT branch,harness,next_sequence,state,prompt_id FROM adapter_streams WHERE id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or("Unknown adapter stream")?;
    let mut value: Value = serde_json::from_str(&state)?;
    for (key, field) in [
        ("streamId", json!(id)),
        ("branch", json!(branch)),
        ("harness", json!(harness)),
        ("nextSequence", json!(next_sequence)),
        ("promptId", json!(prompt_id)),
    ] {
        value[key] = field;
    }
    Ok(value)
}

fn head(tx: &Transaction<'_>, legacy: bool, branch: &str) -> Result<Value> {
    let query = if legacy {
        "SELECT heads FROM refs WHERE name=?1"
    } else {
        "SELECT heads FROM shard_refs WHERE name=?1"
    };
    let heads = tx
        .query_row(query, [branch], |row| row.get::<_, String>(0))
        .optional()?
        .ok_or("Unknown branch")?;
    Ok(serde_json::from_str(&heads)?)
}

fn submit(tx: &Transaction<'_>, legacy: bool, branch: &str, mut input: Value) -> Result<Value> {
    input["expectedHeads"] = head(tx, legacy, branch)?;
    storage(
        tx,
        legacy,
        json!({"command":"submit","branch":branch,"input":input}),
    )
}

fn open(tx: &Transaction<'_>, legacy: bool, options: &Value) -> Result<Value> {
    let id = options["streamId"]
        .as_str()
        .map(str::to_owned)
        .map_or_else(private_files::random_id, Ok)?;
    if id.len() > 80 {
        return Err("Invalid stream ID".into());
    }
    shards::validate_id(&id, "stream ID")?;
    let branch = field(options, "branch")?;
    let harness = field(options, "harness")?;
    if !matches!(harness, "codex" | "claude") {
        return Err("Unsupported harness".into());
    }
    head(tx, legacy, branch)?;
    if tx
        .query_row("SELECT 1 FROM adapter_streams WHERE id=?1", [&id], |_| {
            Ok(())
        })
        .optional()?
        .is_some()
    {
        return Err("Adapter stream already exists".into());
    }
    let mut prompt_id = None;
    if let Some(prompt) = options.get("prompt") {
        let prompt = prompt
            .as_str()
            .filter(|value| value.encode_utf16().count() <= 1_000_000)
            .ok_or("Invalid prompt")?;
        let message_id = format!("prompt-{}", digest(&json!(id))?);
        submit(
            tx,
            legacy,
            branch,
            json!({"actor":"user","harness":harness,"sessionId":id,"evidence":"adapter-input",
            "requestId":format!("open-{id}"),"operations":[{"type":"message.add","messageId":message_id,"role":"user","text":prompt}]}),
        )?;
        prompt_id = Some(message_id);
    }
    tx.execute(
        "INSERT INTO adapter_streams VALUES(?1,?2,?3,0,?4,?5)",
        params![
            id,
            branch,
            harness,
            json!({"streamId":id,"status":"opened","turnCounter":0}).to_string(),
            prompt_id
        ],
    )?;
    stream(tx, &id)
}

fn stamp(
    state: &Value,
    sequence: u64,
    part: usize,
    id: &str,
    source: &str,
    evidence: &str,
    mut event: Value,
) -> Result<Value> {
    let stream = field(state, "streamId")?;
    for (key, value) in [
        ("protocol", json!("spool-adapter/1")),
        ("harness", state["harness"].clone()),
        ("eventId", json!(id)),
        ("streamId", json!(stream)),
        ("sequence", json!(sequence)),
        ("part", json!(part)),
        (
            "sessionId",
            json!(state["sessionId"].as_str().unwrap_or(stream)),
        ),
        (
            "sessionIdSource",
            json!(if state["sessionId"].is_null() {
                "adapter"
            } else {
                "native"
            }),
        ),
        ("sourceType", json!(source)),
        ("evidence", json!(evidence)),
    ] {
        event[key] = value;
    }
    if let Some(turn) = state["turnId"].as_str() {
        event["turnId"] = json!(turn);
    }
    validate_adapter(&event, id)?;
    Ok(event)
}

fn ingest(tx: &Transaction<'_>, legacy: bool, id: &str, input: &Value) -> Result<Value> {
    let sequence = input["sequence"]
        .as_u64()
        .filter(|seq| *seq < 9_007_199_254_740_991)
        .ok_or("Invalid sequence")?;
    let sequence_sql = i64::try_from(sequence)?;
    let raw = &input["nativeEvent"];
    if !raw.is_object() || serde_json::to_string(raw)?.encode_utf16().count() > 1_000_000 {
        return Err("Expected native event object up to 1 MB".into());
    }
    let hash = digest(raw)?;
    if let Some((prior, result)) = tx
        .query_row(
            "SELECT digest,result FROM adapter_receipts WHERE stream_id=?1 AND sequence=?2",
            params![id, sequence_sql],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if prior != hash {
            return Err("Sequence replay has different native payload".into());
        }
        return Ok(serde_json::from_str(&result)?);
    }
    let mut state = stream(tx, id)?;
    if state["nextSequence"] != sequence {
        return Err("Native event sequence gap".into());
    }
    if state["closed"] == true {
        return Err("Adapter stream is closed".into());
    }
    let source = string(&raw["type"], "native event type", 200)?;
    let mut events = Vec::new();
    match field(&state, "harness")? {
        "codex" => normalize_codex(raw, source, &mut state, &mut events)?,
        "claude" => normalize_claude(raw, source, &mut state, &mut events)?,
        _ => return Err("Unsupported harness".into()),
    }
    if events.is_empty() {
        events.push(notice("empty-event"));
    }
    if state["sessionId"].is_null()
        && events
            .iter()
            .any(|event| !matches!(event["kind"].as_str(), Some("notice" | "turn.failed")))
    {
        return Err("Native session has not started".into());
    }
    if events
        .iter()
        .any(|event| event["kind"] == "message" && event["payload"]["role"] == "assistant")
    {
        state["assistantSeen"] = json!(true);
    }
    let events = events
        .into_iter()
        .enumerate()
        .map(|(part, event)| {
            let event_id = digest(&json!({"streamId":id,"sequence":sequence,"part":part}))?;
            stamp(
                &state,
                sequence,
                part,
                &event_id,
                source,
                "native-event",
                event,
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let mut operations = Vec::new();
    for event in &events {
        operations.push(json!({"type":"adapter.record","event":event}));
        if event["kind"] == "message" {
            operations.push(json!({"type":"message.add","messageId":format!("native-{}",field(event,"eventId")?),
                "role":event["payload"]["role"],"text":event["payload"]["text"]}));
        }
    }
    let mut request = json!({"actor":state["harness"],"harness":state["harness"],"sessionId":state["sessionId"].as_str().unwrap_or(id),
        "evidence":"native-event","sourceEventId":events[0]["eventId"],"operations":operations,
        "requestId":format!("adapter-{}",digest(&json!({"streamId":id,"sequence":sequence}))?)});
    for (from, to) in [("turnId", "turnId"), ("promptId", "messageId")] {
        if let Some(value) = state[from].as_str() {
            request[to] = json!(value);
        }
    }
    let mut response = submit(tx, legacy, field(&state, "branch")?, request)?;
    response["events"] = json!(events);
    tx.execute(
        "UPDATE adapter_streams SET state=?1,next_sequence=?2 WHERE id=?3",
        params![state.to_string(), sequence_sql + 1, id],
    )?;
    tx.execute(
        "INSERT INTO adapter_receipts VALUES(?1,?2,?3,?4)",
        params![id, sequence_sql, hash, response.to_string()],
    )?;
    Ok(response)
}

fn close(tx: &Transaction<'_>, legacy: bool, id: &str, input: &Value) -> Result<Value> {
    let mut state = stream(tx, id)?;
    if state["closed"] == true {
        return Ok(state);
    }
    let exit_code = &input["exitCode"];
    let signal = &input["signal"];
    let reason = input["reason"].as_str().filter(|reason| !reason.is_empty());
    let status =
        if reason.is_some() || !signal.is_null() || exit_code != 0 || state["status"] == "failed" {
            "failed"
        } else if state["status"] == "completed" {
            "completed"
        } else {
            "incomplete"
        };
    let mut payload = json!({"status":status,"exitCode":exit_code,"signal":signal});
    if let Some(reason) = reason {
        payload["reason"] = json!(reason);
        state["reason"] = json!(reason);
    }
    let event = stamp(
        &state,
        state["nextSequence"].as_u64().ok_or("Invalid sequence")?,
        0,
        &digest(&json!({"streamId":id,"closed":true}))?,
        "adapter.process.exit",
        "adapter-process",
        event("run.closed", payload),
    )?;
    submit(
        tx,
        legacy,
        field(&state, "branch")?,
        json!({"actor":"adapter","harness":state["harness"],
        "evidence":"adapter-process","requestId":format!("close-{id}"),"operations":[{"type":"adapter.record","event":event}]}),
    )?;
    state["closed"] = json!(true);
    state["status"] = json!(status);
    state["exitCode"] = exit_code.clone();
    state["signal"] = signal.clone();
    tx.execute(
        "UPDATE adapter_streams SET state=?1 WHERE id=?2",
        params![state.to_string(), id],
    )?;
    Ok(state)
}

pub fn run(tx: &Transaction<'_>, legacy: bool, request: &Value) -> Result<Value> {
    match request["command"].as_str() {
        Some("adapter.open") => open(tx, legacy, &request["options"]),
        Some("adapter.ingest") => ingest(tx, legacy, field(request, "streamId")?, request),
        Some("adapter.close") => close(tx, legacy, field(request, "streamId")?, &request["result"]),
        Some("adapter.streams") => {
            let mut query = tx.prepare_cached("SELECT id FROM adapter_streams ORDER BY rowid")?;
            let mut rows = query.query([])?;
            let mut result = Vec::new();
            while let Some(row) = rows.next()? {
                result.push(stream(tx, &row.get::<_, String>(0)?)?);
            }
            Ok(json!(result))
        }
        _ => Err("Unknown adapter command".into()),
    }
}
