use crate::{
    Result, adapter_ingress, git_bridge,
    storage_cli::{self, Layout},
};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{Value, json};
use std::{
    os::unix::process::ExitStatusExt,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};

struct Run {
    db: Connection,
    database: PathBuf,
    root: PathBuf,
    legacy: bool,
    stream: String,
    events: usize,
    sequence: usize,
}

fn emit(value: Value) -> Result<()> {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    writeln!(out, "{value}")?;
    out.flush()?;
    Ok(())
}

impl Run {
    fn adapter(&mut self, request: Value) -> Result<Value> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = adapter_ingress::run(&tx, self.legacy, &request)?;
        tx.commit()?;
        Ok(result)
    }

    fn capture(&mut self, context: Value) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = git_bridge::run(
            &tx,
            self.legacy,
            &self.database,
            &json!({"command":"git.capture","root":self.root,"context":context}),
        )?;
        tx.commit()?;
        if result["operations"].as_u64().is_some_and(|count| count > 0) {
            emit(json!({"event":"filesystem.observed","streamId":self.stream,"result":result}))?;
        }
        Ok(())
    }

    fn record(&mut self, line: &[u8]) -> Result<()> {
        let line = std::str::from_utf8(line)?.trim();
        if line.is_empty() {
            return Ok(());
        }
        let raw: Value = serde_json::from_str(line)?;
        let result = self.adapter(json!({"command":"adapter.ingest","streamId":self.stream,
            "sequence":self.sequence,"nativeEvent":raw}))?;
        self.sequence += 1;
        let events = result["events"]
            .as_array()
            .ok_or("Adapter response missing records")?;
        self.events += events.len();
        emit(json!({"event":"adapter.recorded","streamId":self.stream,"events":events}))?;
        if let Some(boundary) = events.iter().rev().find(|event| {
            matches!(
                event["kind"].as_str(),
                Some("tool.completed" | "turn.completed" | "turn.failed")
            )
        }) {
            let current = adapter_ingress::stream(&self.db.unchecked_transaction()?, &self.stream)?;
            let mut context =
                json!({"sessionId":boundary["sessionId"],"observedAfter":boundary["eventId"]});
            for (key, value) in [
                ("turnId", &boundary["turnId"]),
                ("toolCallId", &boundary["payload"]["toolCallId"]),
                ("messageId", &current["promptId"]),
            ] {
                if let Some(value) = value.as_str() {
                    context[key] = json!(value);
                }
            }
            self.capture(context)?;
        }
        Ok(())
    }

    async fn read(&mut self, stdout: impl AsyncRead + Unpin) -> Result<()> {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            if (&mut reader)
                .take(2_000_001)
                .read_until(b'\n', &mut line)
                .await?
                == 0
            {
                break;
            }
            if line.len() > 2_000_000 {
                return Err("Native stream buffer exceeds 2 MB".into());
            }
            self.record(&line)?;
        }
        Ok(())
    }

    fn finish(
        &mut self,
        exit: Option<ExitStatus>,
        mut failure: Option<&str>,
        stderr_bytes: u64,
    ) -> Result<u8> {
        let current = adapter_ingress::stream(&self.db.unchecked_transaction()?, &self.stream)?;
        let mut context = json!({});
        for (source, target) in [("sessionId", "sessionId"), ("promptId", "messageId")] {
            if let Some(value) = current[source].as_str() {
                context[target] = json!(value);
            }
        }
        if self.capture(context).is_err() && failure.is_none() {
            failure = Some("final-filesystem-capture-failed");
        }
        let exit_code = exit.and_then(|status| status.code());
        let signal = exit.and_then(|status| status.signal()).map(signal_name);
        let finished = self.adapter(json!({"command":"adapter.close","streamId":self.stream,
            "result":{"exitCode":exit_code,"signal":signal,"reason":failure}}))?;
        let mut result = json!({"streamId":self.stream,"status":finished["status"],
            "exitCode":exit_code,"signal":signal,"events":self.events,"stderrBytes":stderr_bytes});
        if let Some(reason) = failure {
            result["reason"] = json!(reason);
        }
        emit(json!({"event":"adapter.finished","result":result}))?;
        Ok(if finished["status"] == "completed" {
            0
        } else if failure == Some("cancelled") {
            130
        } else {
            exit_code
                .and_then(|code| u8::try_from(code).ok())
                .filter(|code| *code != 0)
                .unwrap_or(1)
        })
    }
}

fn signal_name(raw: i32) -> String {
    use rustix::process::Signal;
    let signal = Signal::from_named_raw(raw);
    for (value, name) in [
        (Signal::TERM, "SIGTERM"),
        (Signal::KILL, "SIGKILL"),
        (Signal::INT, "SIGINT"),
        (Signal::HUP, "SIGHUP"),
        (Signal::QUIT, "SIGQUIT"),
        (Signal::ABORT, "SIGABRT"),
        (Signal::PIPE, "SIGPIPE"),
        (Signal::SEGV, "SIGSEGV"),
        (Signal::BUS, "SIGBUS"),
        (Signal::ILL, "SIGILL"),
    ] {
        if signal == Some(value) {
            return name.into();
        }
    }
    format!("signal-{raw}")
}

fn launch(harness: &str, root: &Path, write: bool) -> Result<Command> {
    let mut command = Command::new(harness);
    match harness {
        "codex" => {
            command
                .args([
                    "exec",
                    "--json",
                    "--color",
                    "never",
                    "--sandbox",
                    if write {
                        "workspace-write"
                    } else {
                        "read-only"
                    },
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "-C",
                ])
                .arg(root)
                .arg("-");
        }
        "claude" => {
            command.args(["-p", "--output-format", "stream-json", "--verbose"]);
            if !write {
                command.args(["--tools", "Read,Glob,Grep", "--disallowedTools", "mcp__*"]);
            }
        }
        _ => return Err("Unsupported harness".into()),
    }
    command
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    Ok(command)
}

async fn terminate(child: &mut Child) -> Option<ExitStatus> {
    use rustix::process::{Pid, Signal, kill_process_group};
    let pid = child
        .id()
        .and_then(|value| i32::try_from(value).ok())
        .and_then(Pid::from_raw);
    if let Some(pid) = pid
        && kill_process_group(pid, Signal::TERM).is_err()
    {
        let _ = child.start_kill();
    }
    if let Ok(result) = tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        return result.ok();
    }
    if let Some(pid) = pid {
        let _ = kill_process_group(pid, Signal::KILL);
    }
    let _ = child.start_kill();
    child.wait().await.ok()
}

async fn observe(
    mut state: Run,
    mut child: Child,
    prompt: String,
    timeout: Duration,
) -> Result<u8> {
    let stdout = child.stdout.take().ok_or("Native output is unavailable")?;
    let mut input = child.stdin.take().ok_or("Native input is unavailable")?;
    let mut error = child
        .stderr
        .take()
        .ok_or("Native diagnostics are unavailable")?;
    let stderr_bytes = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let counted = stderr_bytes.clone();
    let stderr_task = tokio::spawn(async move {
        let mut buffer = [0; 8192];
        while let Ok(count) = error.read(&mut buffer).await {
            if count == 0 {
                break;
            }
            counted.fetch_add(count as u64, std::sync::atomic::Ordering::Relaxed);
        }
    });
    let exchange = async {
        let deliver = async move {
            input
                .write_all(prompt.as_bytes())
                .await
                .map_err(|_| "native-input-failed")?;
            input.shutdown().await.map_err(|_| "native-input-failed")
        };
        let receive = async {
            state
                .read(stdout)
                .await
                .map_err(|_| "native-stream-or-capture-failed")
        };
        tokio::try_join!(deliver, receive)?;
        child.wait().await.map_err(|_| "native-process-exit-failed")
    };
    let mut terminal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let result = tokio::select! {
        result=exchange=>result,
        _=tokio::time::sleep(timeout)=>Err("timeout"),
        _=tokio::signal::ctrl_c()=>Err("cancelled"),
        _=terminal.recv()=>Err("cancelled"),
    };
    let (exit, failure) = match result {
        Ok(exit) => (Some(exit), None),
        Err(reason) => (terminate(&mut child).await, Some(reason)),
    };
    let mut stderr_task = stderr_task;
    if tokio::time::timeout(Duration::from_millis(200), &mut stderr_task)
        .await
        .is_err()
    {
        stderr_task.abort();
    }
    state.finish(
        exit,
        failure,
        stderr_bytes.load(std::sync::atomic::Ordering::Relaxed),
    )
}

pub async fn run(
    database: &Path,
    layout: Layout,
    harness: &str,
    root: &Path,
    branch: &str,
    write: bool,
    prompt: String,
) -> Result<u8> {
    if prompt.is_empty() || prompt.encode_utf16().count() > 1_000_000 {
        return Err("Prompt must contain 1–1000000 characters".into());
    }
    let root = std::fs::canonicalize(root)?;
    let mut command = launch(harness, &root, write)?;
    let (mut db, legacy) = storage_cli::open_database(database, layout)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let sources = git_bridge::run(&tx, legacy, database, &json!({"command":"git.sources"}))?;
    if let Some(source) = sources
        .as_array()
        .into_iter()
        .flatten()
        .find(|source| source["root"] == json!(root))
    {
        if source["branch"] != branch {
            return Err("Source checkout is attached to another branch".into());
        }
    } else {
        git_bridge::run(
            &tx,
            legacy,
            database,
            &json!({"command":"git.attach","root":root,"branch":branch}),
        )?;
    }
    let stream = adapter_ingress::run(
        &tx,
        legacy,
        &json!({"command":"adapter.open","options":{
            "branch":branch,"harness":harness,"prompt":prompt
        }}),
    )?;
    tx.commit()?;
    let mut state = Run {
        db,
        database: database.to_owned(),
        root,
        legacy,
        stream: storage_cli::field(&stream, "streamId")?.to_owned(),
        events: 0,
        sequence: 0,
    };
    match command.spawn() {
        Ok(child) => observe(state, child, prompt, Duration::from_secs(120)).await,
        Err(_) => state.finish(None, Some("native-process-start-failed"), 0),
    }
}
