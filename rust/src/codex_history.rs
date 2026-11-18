use crate::{
    Result,
    capture::{self, Message},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

const MAX_REPLY: usize = 16_000_000;
const TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) struct History {
    child: Child,
    writer: ChildStdin,
    reader: Receiver<Value>,
    worker: Option<thread::JoinHandle<()>>,
    id: u64,
}

impl History {
    pub(crate) fn start(command: &Path) -> Result<Self> {
        let mut child = Command::new(command)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let writer = child.stdin.take().expect("child stdin is piped");
        let mut input = BufReader::new(child.stdout.take().expect("child stdout is piped"));
        let (sender, reader) = mpsc::sync_channel(32);
        let worker = thread::spawn(move || {
            loop {
                let mut frame = Vec::new();
                match input
                    .by_ref()
                    .take((MAX_REPLY + 1) as u64)
                    .read_until(b'\n', &mut frame)
                {
                    Ok(size) if size > 0 && size <= MAX_REPLY => {}
                    _ => return,
                }
                if let Ok(message) = serde_json::from_slice::<Value>(&frame)
                    && message.get("id").is_some()
                    && sender.send(message).is_err()
                {
                    return;
                }
            }
        });
        let mut server = Self {
            child,
            writer,
            reader,
            worker: Some(worker),
            id: 0,
        };
        server.request("initialize",json!({"clientInfo":{"name":"spool","title":"SpoolDB","version":env!("CARGO_PKG_VERSION")},
            "capabilities":{"experimentalApi":true}}))?;
        server.send(&json!({"method":"initialized"}))?;
        Ok(server)
    }

    fn send(&mut self, value: &Value) -> Result<()> {
        serde_json::to_writer(&mut self.writer, value)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        Ok(())
    }

    pub(crate) fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.id += 1;
        let id = self.id;
        self.send(&json!({"id":id,"method":method,"params":params}))?;
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let response = self
                .reader
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| "Codex history connection closed or timed out")?;
            if response["id"] != id {
                continue;
            }
            if response.get("error").is_some() {
                return Err("Codex rejected a history request".into());
            }
            return response
                .get("result")
                .cloned()
                .ok_or("Codex history response is missing its result".into());
        }
    }
}

impl Drop for History {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let (_, replacement) = mpsc::sync_channel(0);
        drop(std::mem::replace(&mut self.reader, replacement));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn delegated(item: &Value) -> Option<String> {
    let raw = item["output"]
        .as_str()
        .or_else(|| item["output"]["text"].as_str())?;
    let (_, body) = raw.split_once("<codex_delegation>")?;
    let body = body.trim_start().strip_prefix("<source_thread_id>")?;
    let (source, rest) = body.split_once("</source_thread_id>")?;
    if source.is_empty() || source.contains('<') {
        return None;
    }
    let (input, rest) = rest
        .trim_start()
        .strip_prefix("<input>")?
        .split_once("</input>")?;
    rest.trim_start()
        .starts_with("</codex_delegation>")
        .then(|| input.to_owned())
}

fn message(item: &Value, session: &str, turn: &str) -> Result<Option<Message>> {
    let (role, text) = match item["type"].as_str() {
        Some("userMessage") => (
            "user",
            item["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|content| content["type"] == "text")
                .filter_map(|value| value["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        Some("agentMessage") => (
            "assistant",
            item["text"].as_str().unwrap_or_default().to_owned(),
        ),
        Some("functionCallOutput") if item["name"] == "create_thread" => {
            ("user", delegated(item).unwrap_or_default())
        }
        _ => return Ok(None),
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    if text.encode_utf16().count() > 500_000 {
        return Err("A Codex message exceeds the capture limit".into());
    }
    let item_id = item["id"]
        .as_str()
        .ok_or("Codex message is missing its identity")?;
    Ok(Some(Message {
        source: "codex-history".into(),
        session_id: session.into(),
        turn_id: Some(turn.into()),
        item_id: item_id.into(),
        role: role.into(),
        text,
        harness: "codex".into(),
    }))
}

fn cursor(result: &Value) -> Option<&str> {
    result["nextCursor"]
        .as_str()
        .filter(|value| !value.is_empty())
}

fn data(result: &Value) -> Result<&Vec<Value>> {
    result["data"]
        .as_array()
        .ok_or("Invalid Codex history page".into())
}

pub fn poll(root: &Path, database: &Path, command: &Path) -> Result<Value> {
    History::start(command)?.poll(root, database)
}

impl History {
    pub(crate) fn poll(&mut self, root: &Path, database: &Path) -> Result<Value> {
        let root = std::fs::canonicalize(root)?;
        let mut thread_cursor = None;
        let mut threads = 0;
        let mut stored = 0;
        for page in 0..50 {
            let listed = self.request(
                "thread/list",
                json!({"cwd":root,"limit":50,
            "cursor":thread_cursor,"sortKey":"updated_at","useStateDbOnly":true,
            "sourceKinds":["cli","vscode","appServer","exec"]}),
            )?;
            for chat in data(&listed)? {
                let valid_cwd = chat["cwd"]
                    .as_str()
                    .and_then(|cwd| std::fs::canonicalize(cwd).ok())
                    .is_some_and(|cwd| cwd == root);
                if !valid_cwd {
                    continue;
                }
                let session = chat["id"]
                    .as_str()
                    .ok_or("Codex chat is missing its identity")?;
                threads += 1;
                let mut turn_cursor = None;
                for turn_page in 0..100 {
                    let turns = self.request(
                        "thread/turns/list",
                        json!({"threadId":session,"limit":10,
                    "itemsView":"full","sortDirection":"asc","cursor":turn_cursor}),
                    )?;
                    let mut batch = Vec::new();
                    for turn in data(&turns)? {
                        if !matches!(
                            turn["status"].as_str(),
                            Some("completed" | "interrupted" | "failed")
                        ) {
                            continue;
                        }
                        let turn_id = turn["id"]
                            .as_str()
                            .ok_or("Codex turn is missing its identity")?;
                        for item in turn["items"].as_array().into_iter().flatten() {
                            if let Some(msg) = message(item, session, turn_id)? {
                                batch.push(msg);
                            }
                            if batch.len() == 100 {
                                stored += capture::store(database, "working", &batch)?["stored"]
                                    .as_u64()
                                    .unwrap_or(0);
                                batch.clear();
                            }
                        }
                    }
                    if !batch.is_empty() {
                        stored += capture::store(database, "working", &batch)?["stored"]
                            .as_u64()
                            .unwrap_or(0);
                    }
                    let Some(next) = cursor(&turns) else {
                        break;
                    };
                    if turn_page == 99 || Some(next) == turn_cursor.as_deref() {
                        return Err("Codex turn pagination limit reached".into());
                    }
                    turn_cursor = Some(next.to_owned());
                }
            }
            let Some(next) = cursor(&listed) else {
                break;
            };
            if page == 49 || Some(next) == thread_cursor.as_deref() {
                return Err("Codex chat pagination limit reached".into());
            }
            thread_cursor = Some(next.to_owned());
        }
        Ok(json!({"threads":threads,"messages":stored}))
    }
}
