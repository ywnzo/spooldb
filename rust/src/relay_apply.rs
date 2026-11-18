use crate::{
    Result, private_files, relay_recovery as recovery,
    relay_retention::{metadata, regular_json},
    release_download,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path},
    process::Command,
    time::SystemTime,
};

pub(crate) const CONTAINERFILE: &str = "FROM docker.io/library/debian:bookworm-slim\nWORKDIR /app\nRUN apt-get update && apt-get install -y --no-install-recommends libssl3 libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir /data && chown 1000:1000 /data\nCOPY runtime/spool-relay-linux-x64 ./spool-native\nCOPY node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so.1.21.0 ./libonnxruntime.so\nCOPY node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_shared.so ./\nUSER 1000:1000\nVOLUME /data\nEXPOSE 8878\n";

pub(crate) fn verify_manifest(bundle: &Path, required: &[&str]) -> Result<Value> {
    let manifest =
        regular_json(&bundle.join("manifest.json"))?.ok_or("Missing release manifest")?;
    let files = manifest["files"]
        .as_object()
        .ok_or("Invalid release manifest")?;
    for &name in required {
        if !files.contains_key(name) {
            return Err(format!("Missing release artifact {name}").into());
        }
    }
    for (name, digest) in files {
        let path = Path::new(name);
        if name.is_empty()
            || !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err("Invalid release artifact path".into());
        }
        let source = bundle.join(path);
        if !metadata(&source)?.is_some_and(|file| file.is_file())
            || fs::canonicalize(&source)? != source
        {
            return Err(format!("Invalid release artifact {name}").into());
        }
        let mut file = fs::File::open(&source)?;
        let mut buffer = [0; 64 * 1024];
        let mut hash = Sha256::new();
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if *digest != format!("{:x}", hash.finalize()) {
            return Err(format!("Package integrity check failed for {name}").into());
        }
    }
    let package = regular_json(&bundle.join("package.json"))?.ok_or("Missing package receipt")?;
    if manifest["version"] != package["version"] {
        return Err("Package version differs from manifest".into());
    }
    Ok(manifest)
}

fn time() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339()
}

pub(crate) fn wrapper(app: &Path, config: &Path) -> Result<String> {
    fn quote(path: &Path) -> Result<String> {
        let path = path.to_str().ok_or("Invalid CLI launch path")?;
        Ok(format!("'{}'", path.replace(char::from(39), "'\"'\"'")))
    }
    let native = quote(&app.join("runtime/spool-native-linux-x64"))?;
    let config = quote(config)?;
    Ok(format!(
        r#"#!/bin/sh
# Managed by SpoolDB VPS setup
export SPOOL_CONTAINER_CONFIG={config}
export SPOOL_SYSTEM_SERVICE=1
exec {native} "$@"
"#
    ))
}

pub fn apply(config: &Path, bundle: &Path) -> Result<Value> {
    if !rustix::process::getuid().is_root() {
        return Err("Relay updates require root".into());
    }
    let config = std::path::absolute(config)?;
    let bundle = fs::canonicalize(bundle)?;
    let root = config
        .parent()
        .ok_or("Missing relay configuration directory")?;
    let mut lock = root.as_os_str().to_os_string();
    lock.push(".operation.lock");
    if !metadata(Path::new(&lock))?.is_some_and(|entry| entry.is_dir()) {
        return Err("Run the installer through sudo spool update --yes".into());
    }
    let journal_path = root.join("relay-update-journal.json");
    if journal_path.try_exists()? {
        return Err("Interrupted update: run sudo spool update recover".into());
    }
    let old = regular_json(&config)?.ok_or("Missing managed relay configuration")?;
    let engine =
        recovery::absolute_executable(old["engine"].as_str().ok_or("Missing relay engine")?)?;
    if old["managedBy"] != "SpoolDB" {
        return Err("Expected a managed relay installation".into());
    }
    let old_app = Path::new(old["app"].as_str().ok_or("Missing installed application")?);
    if old_app.parent() != Some(root.join("releases").as_path())
        || !metadata(old_app)?.is_some_and(|entry| entry.is_dir())
    {
        return Err("Invalid installed release".into());
    }
    let package =
        regular_json(&old_app.join("package.json"))?.ok_or("Missing installed package receipt")?;
    let current = package["version"]
        .as_str()
        .ok_or("Missing installed version")?;
    let manifest = verify_manifest(
        &bundle,
        &[
            "runtime/spool-native-linux-x64",
            "runtime/spool-relay-linux-x64",
            "package.json",
        ],
    )?;
    let version = manifest["version"]
        .as_str()
        .ok_or("Missing release version")?;
    if version.starts_with('v')
        || release_download::version(version)? <= release_download::version(current)?
    {
        return Err("Expected a newer stable release".into());
    }
    let id = private_files::random_id()?;
    let release = format!("{version}-{id}");
    let app = root.join("releases").join(&release);
    let backup = root.join("relay-backups").join(&id);
    let previous = format!("spool-relay-previous-{id}");
    let image = format!("localhost/spooldb-relay:{release}");
    let mut next = old.clone();
    next["app"] = json!(app);
    next["image"] = json!(image);
    next["relayBackend"] = json!("rust");
    let control = root.join("control");
    if next["hostControl"] == true && !metadata(&control)?.is_some_and(|entry| entry.is_dir()) {
        return Err("The managed relay control directory is missing".into());
    }
    private_files::private_dir(&app)?;
    let mut source = bundle.into_os_string();
    source.push("/.");
    if !Command::new("/bin/cp")
        .args(["-a", "--"])
        .arg(source)
        .arg(&app)
        .status()?
        .success()
    {
        return Err("Could not stage the release bundle".into());
    }
    private_files::save(
        &app.join(".spool-relay-release.json"),
        &json!({
            "managedBy":"SpoolDB","kind":"relay-release","id":release,"version":version,
            "image":image,"createdAt":time()
        }),
    )?;
    private_files::write_private(&app.join("Containerfile"), CONTAINERFILE.as_bytes())?;
    if !Command::new(engine)
        .args(["build", "--label", "dev.spooldb.managed=true", "--label"])
        .arg(format!("dev.spooldb.release={release}"))
        .arg("-f")
        .arg(app.join("Containerfile"))
        .args(["-t", &image])
        .arg(&app)
        .status()?
        .success()
    {
        return Err("Could not build the candidate image".into());
    }
    let cli = Path::new("/usr/local/bin/spool");
    let run = |args: &[&str]| recovery::run(engine, args);
    recovery::owned("spool-relay", &run)?;
    recovery::probe(&old)?;
    let saved = fs::read_to_string(cli)?;
    if !saved.contains("# Managed by SpoolDB VPS setup") {
        return Err("An unmanaged spool command is installed".into());
    }
    fs::create_dir_all(root.join("relay-backups"))?;
    private_files::private_dir(&backup)?;
    private_files::save(
        &backup.join("backup.json"),
        &json!({
            "managedBy":"SpoolDB","kind":"relay-update-backup","id":id,"createdAt":time(),"previous":old
        }),
    )?;
    let journal = json!({"old":old,"config":next,"backup":backup,"previous":previous,
        "cli":cli,"savedCLI":saved,"phase":"prepared"});
    transaction(&config, journal, &run, &recovery::probe, &|next| {
        crate::relay_control::install(&config, next)
    })
}

fn transaction(
    config: &Path,
    mut journal: Value,
    run: &impl Fn(&[&str]) -> Result<String>,
    probe: &impl Fn(&Value) -> Result<()>,
    control: &impl Fn(&Value) -> Result<()>,
) -> Result<Value> {
    let root = config
        .parent()
        .ok_or("Missing relay application directory")?;
    let control_mount = root.join("control");
    let journal_path = root.join("relay-update-journal.json");
    let cli = std::path::PathBuf::from(journal["cli"].as_str().ok_or("Missing managed command")?);
    let backup = std::path::PathBuf::from(journal["backup"].as_str().ok_or("Missing backup")?);
    let previous = journal["previous"]
        .as_str()
        .ok_or("Missing previous relay container")?
        .to_owned();
    let next = journal["config"].clone();
    let app = Path::new(next["app"].as_str().ok_or("Missing staged relay release")?);
    let package = regular_json(&app.join("package.json"))?.ok_or("Missing package receipt")?;
    let version = package["version"]
        .as_str()
        .ok_or("Missing release version")?;
    private_files::save_atomic(&journal_path, &journal)?;
    let recover = |state: &Value| recovery::recover_steps(config, &cli, state, run, probe, control);
    let result = (|| -> Result<Value> {
        run(&["stop", "-t", "30", "spool-relay"])?;
        recovery::volume(&next, &backup, "snapshot", run)?;
        journal["phase"] = json!("snapshot");
        private_files::save_atomic(&journal_path, &journal)?;
        run(&["rename", "spool-relay", &previous])?;
        create_container(&next, &control_mount, run)?;
        run(&["start", "spool-relay"])?;
        probe(&next)?;
        let health: Value = serde_json::from_str(&run(&[
            "exec",
            "spool-relay",
            "/app/spool-native",
            "relay-health",
            "http://127.0.0.1:8878",
        ])?)?;
        if health["version"] != version || health["updating"] != true {
            return Err("Candidate version or maintenance gate mismatch".into());
        }
        let status: Value = serde_json::from_str(&run(&[
            "exec",
            "spool-relay",
            "/app/spool-native",
            "server",
            "status",
            "--server-state",
            "/data",
            "--json",
        ])?)?;
        if !status["projects"].is_array() {
            return Err("Candidate could not read project memory".into());
        }
        private_files::save_atomic(config, &next)?;
        recovery::restore_cli(&cli, &wrapper(app, config)?)?;
        control(&next)?;
        probe(&next)?;
        journal["phase"] = json!("committed");
        private_files::save_atomic(&journal_path, &journal)?;
        recover(&journal)
    })();
    match result {
        Ok(reply) => {
            fs::remove_file(&journal_path)?;
            Ok(json!({"updated":true,"version":reply["version"],"backup":backup}))
        }
        Err(error) => {
            let state = regular_json(&journal_path)?.ok_or("Missing update journal")?;
            if state["phase"] == "committed" {
                return Err(
                    format!("Update committed. Run sudo spool update recover: {error}").into(),
                );
            }
            match recover(&state) {
                Ok(_) => {
                    fs::remove_file(&journal_path)?;
                    Err(format!("{error}. Previous relay and memory restored.").into())
                }
                Err(rollback) => {
                    Err(format!("{error}. Rollback needs recovery: {rollback}").into())
                }
            }
        }
    }
}

pub(crate) fn create_container(
    config: &Value,
    control: &Path,
    run: &impl Fn(&[&str]) -> Result<String>,
) -> Result<()> {
    let image = config["image"].as_str().ok_or("Missing relay image")?;
    let origin = format!(
        "--origin=https://{}",
        config["domain"].as_str().ok_or("Missing relay domain")?
    );
    let mount = format!("{}:/run/spool-control:ro,z", control.display());
    let mut args = vec![
        "create",
        "--name",
        "spool-relay",
        "--label",
        "dev.spooldb.managed=true",
        "--restart=unless-stopped",
        "--network",
        "spool-network",
        "--network-alias",
        "relay",
    ];
    if config["hostControl"] == true {
        args.extend(["-v", &mount]);
    }
    args.extend([
        "--mount",
        "type=volume,source=spool-relay-data,target=/data",
        image,
        "/app/spool-native",
        "team-host",
        "start",
        "/data",
        "--host=0.0.0.0",
        "--port=8878",
        &origin,
    ]);
    run(&args)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_release_hashes_and_rejects_symlinked_artifacts() -> Result<()> {
        let root = std::env::temp_dir().join(format!(
            "spool-release-test-{}",
            private_files::random_id()?
        ));
        private_files::private_dir(&root)?;
        let root = fs::canonicalize(root)?;
        let result = (|| -> Result<()> {
            private_files::private_dir(&root.join("runtime"))?;
            let mut files = serde_json::Map::new();
            let names = [
                "package.json",
                "runtime/spool-native-linux-x64",
                "runtime/spool-relay-linux-x64",
            ];
            for name in names {
                let bytes = if name == "package.json" {
                    b"{\"version\":\"1.2.3\"}".as_slice()
                } else {
                    b"test binary"
                };
                fs::write(root.join(name), bytes)?;
                files.insert(
                    name.to_owned(),
                    json!(format!("{:x}", Sha256::digest(bytes))),
                );
            }
            private_files::save(
                &root.join("manifest.json"),
                &json!({"version":"1.2.3","files":files}),
            )?;
            assert_eq!(verify_manifest(&root, &names)?["version"], "1.2.3");
            let artifact = root.join(names[2]);
            fs::write(&artifact, "changed")?;
            assert!(verify_manifest(&root, &names).is_err());
            fs::remove_file(&artifact)?;
            std::os::unix::fs::symlink("spool-native-linux-x64", artifact)?;
            assert!(verify_manifest(&root, &names).is_err());
            Ok(())
        })();
        fs::remove_dir_all(root)?;
        result
    }

    #[test]
    fn candidate_writes_roll_back_and_verified_updates_release_the_gate() -> Result<()> {
        for reject in ["health", "controller", "final health", ""] {
            exercise_update(reject)?;
        }
        Ok(())
    }

    fn exercise_update(reject: &str) -> Result<()> {
        use std::cell::RefCell;
        let root =
            std::env::temp_dir().join(format!("spool-update-test-{}", private_files::random_id()?));
        private_files::private_dir(&root)?;
        let result = (|| -> Result<()> {
            let id = "00000000-0000-0000-0000-000000000001";
            let config = root.join("containers.json");
            let cli = root.join("spool");
            let data = root.join("data");
            let backup = root.join("relay-backups").join(id);
            let app = root.join("releases").join(format!("1.2.4-{id}"));
            for folder in [&data, &backup, &app] {
                fs::create_dir_all(folder)?;
            }
            private_files::save(&app.join("package.json"), &json!({"version":"1.2.4"}))?;
            fs::write(data.join("shared.sqlite"), "existing memory")?;
            let engine = "/usr/bin/docker";
            let old = json!({"managedBy":"SpoolDB","domain":"relay.example.org","engine":engine,"relayBackend":"rust",
                "image":format!("localhost/spooldb-relay:1.2.3-{id}"),"app":root.join("old")});
            let next = json!({"managedBy":"SpoolDB","domain":"relay.example.org","engine":engine,"relayBackend":"rust",
                "image":format!("localhost/spooldb-relay:1.2.4-{id}"),"app":app});
            private_files::save(&config, &old)?;
            fs::write(&cli, "previous command")?;
            let previous = format!("spool-relay-previous-{id}");
            let journal = json!({"old":old,"config":next,"backup":backup,"cli":cli,
                "previous":previous,"savedCLI":"previous command","phase":"prepared"});
            let calls = RefCell::new(Vec::new());
            let run = |args: &[&str]| -> Result<String> {
                calls.borrow_mut().push(args[0].to_owned());
                match args {
                    ["run", ..] => {
                        let operation = args[args.len() - 3];
                        crate::relay_volume::run(operation, &data, &backup)?;
                    }
                    ["exec", _, _, "relay-health", ..] => {
                        assert!(data.join(".spool-update-gate").is_file());
                        return Ok(json!({"version":"1.2.4","updating":true}).to_string());
                    }
                    ["exec", _, _, "server", ..] => return Ok(json!({"projects":[]}).to_string()),
                    ["container", "ls", ..] => return Ok(format!("spool-relay\n{previous}")),
                    ["container", "inspect", ..] => {
                        return Ok(
                            json!([{"Config":{"Labels":{"dev.spooldb.managed":"true"}}}])
                                .to_string(),
                        );
                    }
                    _ => {}
                }
                Ok(String::new())
            };
            let checks = std::cell::Cell::new(0);
            let probe = |current: &Value| -> Result<()> {
                if current != &next {
                    return Ok(());
                }
                checks.set(checks.get() + 1);
                assert!(data.join(".spool-update-gate").is_file());
                if (reject == "health" && checks.get() == 1)
                    || (reject == "final health" && checks.get() == 2)
                {
                    fs::write(data.join("shared.sqlite"), "candidate data")?;
                    return Err("Injected candidate health failure".into());
                }
                Ok(())
            };
            let outcome = transaction(&config, journal, &run, &probe, &|current| {
                if current == &next {
                    assert!(data.join(".spool-update-gate").is_file());
                    if reject == "controller" {
                        return Err("Injected controller failure".into());
                    }
                }
                Ok(())
            });
            assert!(!root.join("relay-update-journal.json").exists());
            assert!(!data.join(".spool-update-gate").exists());
            assert_eq!(
                fs::read_to_string(data.join("shared.sqlite"))?,
                "existing memory"
            );
            if !reject.is_empty() {
                assert!(
                    outcome
                        .unwrap_err()
                        .to_string()
                        .contains("Previous relay and memory restored")
                );
                assert_eq!(regular_json(&config)?, Some(old));
                assert_eq!(fs::read_to_string(&cli)?, "previous command");
            } else {
                assert_eq!(outcome?["version"], "1.2.4");
                assert_eq!(regular_json(&config)?, Some(next));
                assert!(fs::read_to_string(&cli)?.contains("spool-native-linux-x64"));
                assert_eq!(
                    regular_json(&root.join("last-relay-update.json"))?.unwrap()["version"],
                    "1.2.4"
                );
            }
            assert!(calls.into_inner().contains(&"rename".to_owned()));
            Ok(())
        })();
        fs::remove_dir_all(root)?;
        result
    }
}
