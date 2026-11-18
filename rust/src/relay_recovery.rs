use crate::{
    Result, private_files,
    relay_retention::{metadata, regular_json, uuid},
    release_download,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    fs,
    io::{ErrorKind, Read},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, SystemTime},
};
use url::Url;

pub(crate) fn absolute_executable(path: &str) -> Result<&str> {
    if !matches!(path, "/usr/bin/docker" | "/usr/bin/podman") {
        return Err("Invalid container engine in relay journal".into());
    }
    Ok(path)
}

pub(crate) fn run(engine: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(engine)
        .args(args)
        .stdin(Stdio::null())
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "{} {} failed: {}",
            engine,
            args[0],
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn relay_image(value: &Value) -> Result<&str> {
    let image = value["image"].as_str().ok_or("Missing relay image")?;
    let tagged = image
        .strip_prefix("localhost/spooldb-relay:")
        .ok_or("Invalid relay image")?;
    let (version, id) = tagged.split_once('-').ok_or("Invalid relay image")?;
    if version.starts_with('v') || !uuid(id) {
        return Err("Invalid relay image".into());
    }
    release_download::version(version)?;
    Ok(image)
}

pub(crate) fn probe(settings: &Value) -> Result<()> {
    let domain = settings["domain"]
        .as_str()
        .ok_or("Missing relay TLS domain")?;
    let probe = settings["probe"]
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 80
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .ok_or("Missing relay setup probe")?;
    let url = Url::parse(&format!("https://{domain}/healthz"))?;
    if url.host_str() != Some(domain)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/healthz"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid relay TLS domain".into());
    }
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    let client: ureq::Agent = ureq::Agent::config_builder()
        .proxy(None)
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .into();
    for attempt in 0..24 {
        if let Ok(response) = client.get(url.as_str()).call()
            && response.status().is_success()
            && response
                .headers()
                .get("x-spooldb-setup")
                .is_some_and(|header| header == probe)
            && let Ok(body) =
                serde_json::from_reader::<_, Value>(response.into_body().into_reader().take(16_385))
            && body["ok"] == true
        {
            return Ok(());
        }
        if attempt < 23 {
            std::thread::sleep(Duration::from_millis(2500));
        }
    }
    Err(format!("Public HTTPS health check failed for {domain}").into())
}

// Old released images have Bun and use the same ownership manifest as the native helper.
const RESTORE_LEGACY: &str = r#"const f=require('node:fs'); const ids=JSON.parse(f.readFileSync('/backup/owners.json')); function collect(p){let s=f.lstatSync(p);return [p.slice(12),...(s.isDirectory()?f.readdirSync(p).flatMap(n=>collect(p+'/'+n)):[])];} const paths=collect('/backup/data').sort();if(!Array.isArray(ids)||JSON.stringify(paths)!==JSON.stringify(ids.map(a=>a[0]).sort())||!ids.every(a=>Array.isArray(a)&&a.length===3&&a.slice(1).every(n=>Number.isSafeInteger(n)&&n>=0)))throw Error('Incomplete backup');for(const name of f.readdirSync('/data'))if(name!=='models')f.rmSync('/data/'+name,{recursive:true});f.cpSync('/backup/data','/data',{recursive:true});for(const [p,u,g] of ids)f.lchownSync('/data'+p,u,g);"#;
const COMMIT_LEGACY: &str = "require('node:fs').rmSync('/data/.spool-update-gate',{force:true})";

pub(crate) fn volume(
    config: &Value,
    backup: &Path,
    operation: &str,
    execute: &impl Fn(&[&str]) -> Result<String>,
) -> Result<()> {
    let image = relay_image(config)?;
    let path = backup.to_str().ok_or("Invalid relay backup path")?;
    if path.contains(':') {
        return Err("Invalid relay backup mount path".into());
    }
    let mount = format!("{path}:/backup:Z");
    let mut args = vec![
        "run",
        "--rm",
        "--user",
        "0",
        "-v",
        "spool-relay-data:/data",
        "-v",
        &mount,
        image,
    ];
    if config["relayBackend"] == "rust" {
        args.extend([
            "/app/spool-native",
            "relay-volume",
            operation,
            "/data",
            "/backup",
        ]);
    } else {
        let script = if operation == "restore" {
            RESTORE_LEGACY
        } else {
            COMMIT_LEGACY
        };
        args.extend(["bun", "-e", script]);
    }
    execute(&args)?;
    Ok(())
}

pub(crate) fn restore_cli(path: &Path, script: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let staged = path.with_file_name(format!(".spool-cli-{}.tmp", private_files::random_id()?));
    let result = private_files::write_private(&staged, script.as_bytes()).and_then(|()| {
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))?;
        fs::rename(&staged, path)?;
        Ok(())
    });
    if result.is_err() {
        let _ = fs::remove_file(staged);
    }
    result
}

fn existing(execute: &impl Fn(&[&str]) -> Result<String>) -> Result<Vec<String>> {
    let names = execute(&["container", "ls", "--all", "--format", "{{.Names}}"])?;
    Ok(names
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect())
}

pub(crate) fn owned(name: &str, execute: &impl Fn(&[&str]) -> Result<String>) -> Result<()> {
    let info: Vec<Value> = serde_json::from_str(&execute(&["container", "inspect", name])?)?;
    if info.len() != 1 || info[0]["Config"]["Labels"]["dev.spooldb.managed"] != "true" {
        return Err(format!("Refusing to modify an unmanaged container named {name}").into());
    }
    Ok(())
}

pub fn recover(config: &Path, expected_cli: &Path) -> Result<Value> {
    let root = config.parent().ok_or("Invalid relay directory")?;
    let journal = root.join("relay-update-journal.json");
    let entry = regular_json(&journal)?.ok_or("No interrupted relay transaction was found")?;
    let engine = absolute_executable(
        entry["old"]["engine"]
            .as_str()
            .ok_or("Missing previous engine")?,
    )?;
    recover_steps(
        config,
        expected_cli,
        &entry,
        |args| run(engine, args),
        probe,
        |next| crate::relay_control::install(config, next),
    )
}

pub(crate) fn recover_steps(
    config: &Path,
    expected_cli: &Path,
    entry: &Value,
    execute: impl Fn(&[&str]) -> Result<String>,
    health: impl Fn(&Value) -> Result<()>,
    refresh_control: impl Fn(&Value) -> Result<()>,
) -> Result<Value> {
    let root = config.parent().ok_or("Invalid relay directory")?;
    let backup = Path::new(entry["backup"].as_str().ok_or("Missing recovery backup")?);
    let old = &entry["old"];
    let next = &entry["config"];
    let previous = entry["previous"]
        .as_str()
        .ok_or("Missing previous container name")?;
    let id = previous
        .strip_prefix("spool-relay-previous-")
        .filter(|id| uuid(id))
        .ok_or("Invalid previous relay name")?;
    if backup != root.join("relay-backups").join(id)
        || entry["cli"].as_str().map(Path::new) != Some(expected_cli)
        || old["managedBy"] != "SpoolDB"
    {
        return Err("Invalid relay recovery paths".into());
    }
    let script = entry["savedCLI"].as_str().ok_or("Missing previous CLI")?;
    relay_image(old)?;
    let phase = entry["phase"].as_str().ok_or("Missing recovery phase")?;
    if phase == "committed" {
        if old["engine"] != next["engine"] || next["managedBy"] != "SpoolDB" {
            return Err("Invalid committed relay configuration".into());
        }
        let app = Path::new(
            next["app"]
                .as_str()
                .ok_or("Missing committed release path")?,
        );
        if app.parent() != Some(root.join("releases").as_path())
            || !metadata(app)?.is_some_and(|entry| entry.is_dir())
        {
            return Err("Invalid committed release".into());
        }
        let package =
            regular_json(&app.join("package.json"))?.ok_or("Missing committed package receipt")?;
        let version = package["version"]
            .as_str()
            .ok_or("Missing release version")?;
        release_download::version(version)?;
        volume(next, backup, "commit", &execute)?;
        let now =
            DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true);
        private_files::save_atomic(
            &root.join("last-relay-update.json"),
            &json!({"version":version,"previous":old,"backup":backup,"completedAt":now}),
        )?;
        if existing(&execute)?.iter().any(|name| name == previous) {
            owned(previous, &execute)?;
            let _ = execute(&["rm", previous]);
        }
        return Ok(json!({"recovered":true,"version":version}));
    }
    if phase == "rolled-back" {
        owned("spool-relay", &execute)?;
        execute(&["start", "spool-relay"])?;
        health(old)?;
        return Ok(json!({"recovered":true}));
    }
    if !matches!(phase, "prepared" | "snapshot") {
        return Err("Unknown relay recovery phase".into());
    }
    let names = existing(&execute)?;
    let renamed = names.iter().any(|name| name == previous);
    let current = names.iter().any(|name| name == "spool-relay");
    if renamed {
        owned(previous, &execute)?;
    }
    if current {
        owned("spool-relay", &execute)?;
        if renamed {
            execute(&["rm", "-f", "spool-relay"])?;
        } else {
            execute(&["stop", "-t", "30", "spool-relay"])?;
        }
    } else if !renamed {
        return Err("The previous relay container was not found".into());
    }
    let snapshot = metadata(&backup.join("data"))?.is_some_and(|entry| entry.is_dir())
        && metadata(&backup.join("owners.json"))?.is_some_and(|entry| entry.is_file());
    if phase == "snapshot" || snapshot {
        if !metadata(backup)?.is_some_and(|entry| entry.is_dir()) {
            return Err("Recovery backup directory is missing or symlinked".into());
        }
        let helper = if next["relayBackend"] == "rust" && next["engine"] == old["engine"] {
            next
        } else {
            old
        };
        volume(helper, backup, "restore", &execute)?;
    }
    if renamed {
        execute(&["rename", previous, "spool-relay"])?;
    }
    private_files::save_atomic(config, old)?;
    restore_cli(expected_cli, script)?;
    refresh_control(old)?;
    let mut restored = entry.clone();
    restored["phase"] = json!("rolled-back");
    private_files::save_atomic(&root.join("relay-update-journal.json"), &restored)?;
    execute(&["start", "spool-relay"])?;
    health(old)?;
    Ok(json!({"recovered":true}))
}

pub fn allow_recovery(lock: &Path) -> Result<()> {
    let owner = match fs::read_to_string(lock.join("pid")) {
        Ok(value) => value,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if let Some(pid) = owner
        .trim()
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 1)
        .and_then(rustix::process::Pid::from_raw)
        && matches!(
            rustix::process::test_kill_process(pid),
            Ok(()) | Err(rustix::io::Errno::PERM)
        )
    {
        return Err("An updater is still running. Recovery refused.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn rolls_back_the_candidate_before_restoring_data_and_cli() -> Result<()> {
        let root =
            std::env::temp_dir().join(format!("spool-recovery-{}", private_files::random_id()?));
        private_files::private_dir(&root)?;
        let result = (|| -> Result<()> {
            let id = "00000000-0000-0000-0000-000000000001";
            let config = root.join("containers.json");
            let cli = root.join("spool");
            let backup = root.join("relay-backups").join(id);
            fs::create_dir_all(&backup)?;
            let name = format!("spool-relay-previous-{id}");
            let prior = json!({"managedBy":"SpoolDB","domain":"spool.example.org","relayBackend":"rust",
                "image":format!("localhost/spooldb-relay:1.2.3-{id}")});
            private_files::save(&config, &json!({"candidate":true}))?;
            let journal = json!({"old":prior,"backup":backup,"previous":name,"cli":cli,
                "savedCLI":"#!/bin/sh\n# older command\n","phase":"snapshot"});
            let operations = RefCell::new(Vec::new());
            let apply = |args: &[&str]| {
                operations.borrow_mut().push(args.join(" "));
                match args {
                    ["container", "ls", ..] => Ok(format!("spool-relay\n{name}")),
                    ["container", "inspect", ..] => Ok(
                        json!([{"Config":{"Labels":{"dev.spooldb.managed":"true"}}}]).to_string(),
                    ),
                    _ => Ok(String::new()),
                }
            };
            let outcome = recover_steps(
                &config,
                &cli,
                &journal,
                apply,
                |target| {
                    assert_eq!(target, &prior);
                    Ok(())
                },
                |target| {
                    assert_eq!(target, &prior);
                    assert_eq!(regular_json(&config)?.as_ref(), Some(&prior));
                    Ok(())
                },
            )?;
            let operations = operations.into_inner();
            assert_eq!(outcome["recovered"], true);
            assert_eq!(regular_json(&config)?, Some(prior));
            assert_eq!(fs::read_to_string(&cli)?, journal["savedCLI"]);
            assert_eq!(operations[3], "rm -f spool-relay");
            assert!(operations[4].ends_with("relay-volume restore /data /backup"));
            assert_eq!(operations[5], format!("rename {name} spool-relay"));
            assert_eq!(operations[6], "start spool-relay");
            let restored = regular_json(&root.join("relay-update-journal.json"))?.unwrap();
            assert_eq!(restored["phase"], "rolled-back");
            let retry = RefCell::new(Vec::new());
            recover_steps(
                &config,
                &cli,
                &restored,
                |args| {
                    retry.borrow_mut().push(args.join(" "));
                    if args[0] == "container" {
                        Ok(
                            json!([{"Config":{"Labels":{"dev.spooldb.managed":"true"}}}])
                                .to_string(),
                        )
                    } else {
                        Ok(String::new())
                    }
                },
                |_| Ok(()),
                |_| unreachable!(),
            )?;
            assert_eq!(
                retry.into_inner(),
                ["container inspect spool-relay", "start spool-relay"]
            );
            Ok(())
        })();
        fs::remove_dir_all(root)?;
        result
    }
}
