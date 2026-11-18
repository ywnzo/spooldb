use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn native_and_bun_share_shard_storage() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let work = std::env::temp_dir().join(format!("spool-rust-{}-{stamp}", std::process::id()));
    fs::create_dir(&work).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(work.clone());
    let db = work.join("relay.sqlite");
    let generated = Command::new("bun")
        .arg(root.join("tests/compat-fixture.js"))
        .arg(&db)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let fixture: Value = serde_json::from_slice(&generated.stdout).unwrap();
    let room = fixture["room"].as_str().unwrap();
    let record = &fixture["record"];
    let id = record["id"].as_str().unwrap();
    let before = fs::read(&db).unwrap();
    let manifest = |room: &str, key: &str| {
        Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("manifest-get")
            .arg(&db)
            .args([room, key])
            .output()
            .unwrap()
    };
    let key = format!("m:{id}");
    let descriptor = manifest(room, &key);
    assert!(
        descriptor.status.success(),
        "{}",
        String::from_utf8_lossy(&descriptor.stderr)
    );
    let actual_descriptor: Value = serde_json::from_slice(&descriptor.stdout).unwrap();
    assert!(fixture["descriptor"].is_object());
    assert_eq!(actual_descriptor["descriptor"], fixture["descriptor"]);
    assert_eq!(actual_descriptor["key"], key);
    let document = || {
        Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("document-get")
            .arg(&db)
            .args([room, &key])
            .output()
            .unwrap()
    };
    let replay = document();
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let actual_shard: Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(actual_shard, fixture["shard"]);
    let missing = manifest(room, "m:absent");
    assert!(missing.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&missing.stdout).unwrap(),
        Value::Null
    );
    assert!(!manifest("foreign-room", &key).status.success());
    let read = |room: &str, id: &str| {
        Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("get")
            .arg(&db)
            .args([room, id])
            .output()
            .unwrap()
    };
    let output = read(room, id);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    for key in [
        "id",
        "kind",
        "title",
        "text",
        "citation",
        "lifecycle",
        "source",
        "sequence",
        "taskId",
    ] {
        assert_eq!(actual[key], record[key], "{key}");
    }
    assert_eq!(actual["lifecycle"]["status"], "archived");
    assert!(!read("foreign-room", id).status.success());
    assert!(!read(room, "missing-record").status.success());
    let search = Command::new(env!("CARGO_BIN_EXE_spool-native"))
        .arg("search")
        .arg(&db)
        .args([room, "migration"])
        .output()
        .unwrap();
    assert!(
        search.status.success(),
        "{}",
        String::from_utf8_lossy(&search.stderr)
    );
    let results: Value = serde_json::from_slice(&search.stdout).unwrap();
    let results = results["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["title"], "Current migration evidence");
    let mut server = Command::new(env!("CARGO_BIN_EXE_spool-native"))
        .arg("mcp")
        .arg(&db)
        .arg(room)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut input = server.stdin.take().unwrap();
        writeln!(input, "malformed").unwrap();
        for message in [
            serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            serde_json::json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}),
            serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),
            serde_json::json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_get","arguments":{"id":id}}}),
            serde_json::json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"migration"}}}),
            serde_json::json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"memory_get","arguments":{"id":id,"room":"other"}}}),
        ] {
            writeln!(input, "{message}").unwrap();
        }
    }
    let session = server.wait_with_output().unwrap();
    assert!(session.status.success());
    let messages: Vec<Value> = String::from_utf8(session.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(messages.len(), 7);
    assert_eq!(messages[0]["error"]["code"], -32700);
    assert_eq!(messages[1]["error"]["code"], -32002);
    assert_eq!(messages[2]["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(messages[3]["result"]["tools"].as_array().unwrap().len(), 2);
    assert_eq!(messages[4]["result"]["structuredContent"], actual);
    assert_eq!(
        messages[5]["result"]["structuredContent"]["results"][0]["title"],
        "Current migration evidence"
    );
    assert_eq!(messages[6]["error"]["code"], -32602);
    {
        use std::{io::Write, process::Stdio};
        let exported = Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("bundle-export")
            .arg(&db)
            .args([room, &format!("relay-{room}"), "[]"])
            .output()
            .unwrap();
        assert!(
            exported.status.success(),
            "{}",
            String::from_utf8_lossy(&exported.stderr)
        );
        let mut peer = Command::new("bun")
            .arg(root.join("tests/compat-fixture.js"))
            .arg(&db)
            .args(["verify-existing-bundle", id])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        peer.stdin
            .take()
            .unwrap()
            .write_all(&exported.stdout)
            .unwrap();
        let imported = peer.wait_with_output().unwrap();
        assert!(
            imported.status.success(),
            "{}",
            String::from_utf8_lossy(&imported.stderr)
        );
        let restored: Value = serde_json::from_slice(&imported.stdout).unwrap();
        assert_eq!(restored, *record);
    }
    {
        use std::{io::Write, process::Stdio};
        let peer_db = work.join("peer.sqlite");
        let init = Command::new("bun")
            .arg(root.join("tests/compat-fixture.js"))
            .arg(&peer_db)
            .arg("init-empty")
            .output()
            .unwrap();
        assert!(
            init.status.success(),
            "{}",
            String::from_utf8_lossy(&init.stderr)
        );
        let exported = Command::new("bun")
            .arg(root.join("tests/compat-fixture.js"))
            .arg(&db)
            .args(["export-existing", room])
            .output()
            .unwrap();
        assert!(
            exported.status.success(),
            "{}",
            String::from_utf8_lossy(&exported.stderr)
        );
        let bundle: Value = serde_json::from_slice(&exported.stdout).unwrap();
        let import = |bundle: &Value| {
            let mut child = Command::new(env!("CARGO_BIN_EXE_spool-native"))
                .arg("bundle-import")
                .arg(&peer_db)
                .arg(format!("relay-{room}"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(bundle.to_string().as_bytes())
                .unwrap();
            child.wait_with_output().unwrap()
        };
        let mut corrupt = bundle.clone();
        corrupt["batches"][1]["root"] = serde_json::json!("wrong");
        let original = fs::read(&peer_db).unwrap();
        assert!(!import(&corrupt).status.success());
        assert_eq!(fs::read(&peer_db).unwrap(), original);
        let restored = import(&bundle);
        assert!(
            restored.status.success(),
            "{}",
            String::from_utf8_lossy(&restored.stderr)
        );
        assert!(import(&bundle).status.success());
        let leaf = Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("document-get")
            .arg(&peer_db)
            .args([room, &key])
            .output()
            .unwrap();
        assert!(
            leaf.status.success(),
            "{}",
            String::from_utf8_lossy(&leaf.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&leaf.stdout).unwrap(),
            fixture["shard"]
        );
        let index = Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("memory-index")
            .arg(&peer_db)
            .arg(room)
            .output()
            .unwrap();
        assert!(
            index.status.success(),
            "{}",
            String::from_utf8_lossy(&index.stderr)
        );
        let found = Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("get")
            .arg(&peer_db)
            .args([room, id])
            .output()
            .unwrap();
        assert!(
            found.status.success(),
            "{}",
            String::from_utf8_lossy(&found.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&found.stdout).unwrap(),
            actual
        );
        let filtered = Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("search")
            .arg(&peer_db)
            .args([room, "evidence"])
            .output()
            .unwrap();
        assert!(
            filtered.status.success(),
            "{}",
            String::from_utf8_lossy(&filtered.stderr)
        );
        let indexed = serde_json::from_slice::<Value>(&filtered.stdout).unwrap();
        assert_eq!(indexed["results"].as_array().unwrap().len(), 1);
        assert_ne!(indexed["results"][0]["id"], id);
        let before_refresh = fs::read(&peer_db).unwrap();
        let repeated = Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("memory-index")
            .arg(&peer_db)
            .arg(room)
            .output()
            .unwrap();
        assert!(repeated.status.success());
        assert_eq!(fs::read(&peer_db).unwrap(), before_refresh);
    }
    assert_eq!(fs::read(&db).unwrap(), before);
    let sql = rusqlite::Connection::open(&db).unwrap();
    sql.execute(
        "UPDATE memory_index SET heads='outdated' WHERE room=?",
        [room],
    )
    .unwrap();
    let stale = read(room, id);
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("stale"));
    assert!(document().status.success());
    let invalidated = sql
        .execute(
            "UPDATE shard_checkpoints SET checksum='invalid' WHERE room=?1 AND doc=?2",
            [room, &key],
        )
        .unwrap();
    assert!(invalidated > 0);
    let replay_without_checkpoint = document();
    assert!(replay_without_checkpoint.status.success());
    assert_eq!(replay_without_checkpoint.stdout, replay.stdout);
    sql.execute(
        "DELETE FROM shard_changes WHERE room=?1 AND doc=?2 AND seq=(
           SELECT min(seq) FROM shard_changes WHERE room=?1 AND doc=?2
         )",
        [room, &key],
    )
    .unwrap();
    let missing_history = document();
    assert!(!missing_history.status.success());
    assert!(String::from_utf8_lossy(&missing_history.stderr).contains("shard history"));
    sql.execute(
        "UPDATE shard_nodes SET body='{}' WHERE hash=(SELECT root FROM shard_refs WHERE room=?1)",
        [room],
    )
    .unwrap();
    let corrupt = manifest(room, &key);
    assert!(!corrupt.status.success());
    assert!(String::from_utf8_lossy(&corrupt.stderr).contains("Corrupt manifest node"));
    let create = |room: &str, branch: &str| {
        Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("room-create")
            .arg(&db)
            .args([room, branch])
            .output()
            .unwrap()
    };
    let native = create("interop-room", "rust-created");
    assert!(
        native.status.success(),
        "{}",
        String::from_utf8_lossy(&native.stderr)
    );
    assert!(!create("other-room", "rust-created").status.success());
    assert!(!create("../invalid", "new-branch").status.success());
    let leaked: i64 = sql
        .query_row(
            "SELECT count(*) FROM shard_batches WHERE room='other-room'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(leaked, 0);
    let verified = Command::new("bun")
        .arg(root.join("tests/compat-fixture.js"))
        .arg(&db)
        .arg("verify-native")
        .output()
        .unwrap();
    assert!(
        verified.status.success(),
        "{}",
        String::from_utf8_lossy(&verified.stderr)
    );
    let checked: Value = serde_json::from_slice(&verified.stdout).unwrap();
    let created: Value = serde_json::from_slice(&native.stdout).unwrap();
    assert_eq!(created["heads"], checked["native"]["heads"]);
    assert_eq!(checked["bundle"]["protocol"], "spool/2");
    assert_eq!(checked["bundle"]["room"], "interop-room");
    let append = |heads: &Value| {
        use std::process::Stdio;
        let mut child = Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("message-add")
            .arg(&db)
            .args(["interop-room", "rust-created"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        serde_json::to_writer(
            child.stdin.take().unwrap(),
            &serde_json::json!({
                "actor": "test-client", "messageId": "native-message",
                "expectedHeads": heads, "role": "assistant", "text": "Příliš žluťoučký kůň 🧶",
            }),
        )
        .unwrap();
        child.wait_with_output().unwrap()
    };
    let sent = append(&created["heads"]);
    assert!(
        sent.status.success(),
        "{}",
        String::from_utf8_lossy(&sent.stderr)
    );
    assert!(!append(&created["heads"]).status.success());
    let sent: Value = serde_json::from_slice(&sent.stdout).unwrap();
    assert!(!append(&sent["heads"]).status.success());
    for since in [serde_json::json!([]), created["heads"].clone()] {
        use std::{io::Write, process::Stdio};
        let exported = Command::new(env!("CARGO_BIN_EXE_spool-native"))
            .arg("bundle-export")
            .arg(&db)
            .args(["interop-room", "rust-created", &since.to_string()])
            .output()
            .unwrap();
        assert!(
            exported.status.success(),
            "{}",
            String::from_utf8_lossy(&exported.stderr)
        );
        let bundle: Value = serde_json::from_slice(&exported.stdout).unwrap();
        assert_eq!(
            bundle["batches"].as_array().unwrap().len(),
            if since == serde_json::json!([]) { 2 } else { 1 }
        );
        let mut child = Command::new("bun")
            .arg(root.join("tests/compat-fixture.js"))
            .arg(&db)
            .arg("verify-message")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&exported.stdout)
            .unwrap();
        let imported = child.wait_with_output().unwrap();
        assert!(
            imported.status.success(),
            "{}",
            String::from_utf8_lossy(&imported.stderr)
        );
        let message: Value = serde_json::from_slice(&imported.stdout).unwrap();
        assert_eq!(message["text"], "Příliš žluťoučký kůň 🧶");
        assert_eq!(message["eventId"], sent["eventId"]);
    }
}

#[test]
fn missing_database_is_not_created() {
    let path = std::env::temp_dir().join(format!(
        "spool-missing-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let output = Command::new(env!("CARGO_BIN_EXE_spool-native"))
        .arg("get")
        .arg(&path)
        .args(["room", "record"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!path.exists());
}

#[test]
fn existing_clients_sync_with_native_relay() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let work = std::env::temp_dir().join(format!("spool-relay-{}-{stamp}", std::process::id()));
    fs::create_dir(&work).unwrap();
    let output = Command::new("bun")
        .arg(root.join("tests/relay-fixture.js"))
        .arg(env!("CARGO_BIN_EXE_spool-native"))
        .arg(work.join("relay.sqlite"))
        .arg(work.join("credentials.json"))
        .output()
        .unwrap();
    fs::remove_dir_all(work).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn existing_self_hosted_workspaces_keep_membership_and_invites() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let work = std::env::temp_dir().join(format!("spool-workspace-{}-{stamp}", std::process::id()));
    fs::create_dir(&work).unwrap();
    let output = Command::new("bun")
        .arg(root.join("tests/workspace-fixture.js"))
        .arg(env!("CARGO_BIN_EXE_spool-native"))
        .arg(&work)
        .output()
        .unwrap();
    fs::remove_dir_all(work).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn storage_cli_reads_and_updates_both_existing_database_formats() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let work = std::env::temp_dir().join(format!("spool-storage-{}-{stamp}", std::process::id()));
    fs::create_dir(&work).unwrap();
    let output = Command::new("bun")
        .arg(root.join("tests/storage-fixture.js"))
        .arg(env!("CARGO_BIN_EXE_spool-native"))
        .arg(&work)
        .output()
        .unwrap();
    fs::remove_dir_all(work).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
