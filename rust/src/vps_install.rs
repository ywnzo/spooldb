use crate::{
    Result, private_files, relay_apply, relay_control, relay_recovery,
    relay_retention::{metadata, regular_json},
    relay_update::Installation,
    release_download,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{ErrorKind, Write},
    net::{IpAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use url::Url;

const LABEL: &str = "dev.spooldb.managed=true";
const MARKER: &str = "# Managed by SpoolDB VPS setup";
const CADDY: &str = "docker.io/library/caddy:2.11.7";
const UNIT: &str = "/etc/systemd/system/spool-shared.service";
const CLI: &str = "/usr/local/bin/spool";

pub fn domain(value: &str) -> Result<String> {
    let value = value.trim();
    let value = value.strip_prefix("https://").unwrap_or(value);
    let value = value.strip_suffix('/').unwrap_or(value);
    let url = Url::parse(&format!("https://{value}"))?;
    let host = url.host_str().ok_or("Enter a public DNS hostname")?;
    if host.len() > 253
        || !host.contains('.')
        || host.parse::<IpAddr>().is_ok()
        || url.port().is_some()
        || value.contains(['/', ':', '?', '#', '@', '\\', '%'])
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        || !host.split('.').all(|part| {
            !part.is_empty() && part.len() <= 63 && !part.starts_with('-') && !part.ends_with('-')
        })
        || [".localhost", ".local", ".invalid", ".test"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
    {
        return Err("Enter a public DNS hostname without a port, path or wildcard".into());
    }
    Ok(host.to_owned())
}

fn systemctl(args: &[&str]) -> Result<()> {
    if !Command::new("/usr/bin/systemctl")
        .args(args)
        .stdin(Stdio::null())
        .status()?
        .success()
    {
        return Err("Could not activate the SpoolDB system service".into());
    }
    Ok(())
}

fn engine() -> Result<&'static str> {
    ["/usr/bin/podman", "/usr/bin/docker"]
        .into_iter()
        .find(|path| relay_recovery::run(path, &["info"]).is_ok())
        .ok_or_else(|| "Install and start Docker or Podman, then run the installer again".into())
}

fn build(engine: &str, args: &[&str]) -> Result<()> {
    if !Command::new(engine)
        .args(args)
        .stdin(Stdio::null())
        .status()?
        .success()
    {
        return Err(format!("Container engine {} failed", args[0]).into());
    }
    Ok(())
}

// Use inventory rather than treating every inspect failure as an absent resource.
fn inventory(
    run: &impl Fn(&[&str]) -> Result<String>,
    kind: &str,
    items: &[&str],
) -> Result<Vec<String>> {
    let mut args = vec![kind, "ls"];
    if kind == "container" {
        args.push("--all");
    }
    args.extend([
        "--format",
        if kind == "container" {
            "{{.Names}}"
        } else {
            "{{.Name}}"
        },
    ]);
    let names = run(&args)?;
    let mut present = Vec::new();
    for &name in items {
        if !names.lines().any(|entry| entry.trim() == name) {
            continue;
        }
        let inspected: Vec<Value> = serde_json::from_str(&run(&[kind, "inspect", name])?)?;
        let info = inspected.first().ok_or("Incomplete resource inventory")?;
        let label = info["Config"]["Labels"]["dev.spooldb.managed"]
            .as_str()
            .or_else(|| info["Labels"]["dev.spooldb.managed"].as_str())
            .or_else(|| info["labels"]["dev.spooldb.managed"].as_str());
        if label != Some("true") {
            return Err(format!("Unmanaged {kind} already exists: {name}").into());
        }
        present.push(name.to_owned());
    }
    Ok(present)
}

struct Operation(PathBuf);
impl Drop for Operation {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.0.join("pid"));
        let _ = fs::remove_dir(&self.0);
    }
}

fn managed(path: &Path) -> Result<Option<String>> {
    let Some(metadata) = metadata(path)? else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() > 32_768 {
        return Err(format!("Unmanaged file at {}", path.display()).into());
    }
    let content = fs::read_to_string(path)?;
    if !content.contains(MARKER) {
        return Err(format!("Unmanaged file at {}", path.display()).into());
    }
    Ok(Some(content))
}

fn unit(engine: &str) -> String {
    let docker = if engine.ends_with("/docker") {
        (" docker.service", "Requires=docker.service\n")
    } else {
        ("", "")
    };
    format!(
        "{MARKER}\n[Unit]\nDescription=SpoolDB relay and HTTPS containers\nWants=network-online.target\nAfter=network-online.target{}\n{}\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart={engine} start spool-relay spool-caddy\nExecStop={engine} stop -t 30 spool-caddy spool-relay\nTimeoutStartSec=120\nTimeoutStopSec=90\n[Install]\nWantedBy=multi-user.target\n",
        docker.0, docker.1
    )
}

fn firewall() -> Result<()> {
    let path = Path::new("/usr/sbin/ufw");
    if !path.is_file() {
        return Ok(());
    }
    let status = Command::new(path).arg("status").output()?;
    if status.status.success()
        && String::from_utf8_lossy(&status.stdout)
            .lines()
            .any(|line| line.trim() == "Status: active")
    {
        for port in ["80/tcp", "443/tcp"] {
            if !Command::new(path).args(["allow", port]).status()?.success() {
                return Err("Could not open the HTTPS firewall ports".into());
            }
        }
    }
    Ok(())
}

pub fn run(bundle: &Path, hostname: &str, automatic: bool) -> Result<()> {
    if !cfg!(all(target_os = "linux", target_arch = "x86_64"))
        || !rustix::process::getuid().is_root()
    {
        return Err("Automatic VPS setup requires root on Linux x86-64".into());
    }
    let domain = domain(hostname)?;
    let bundle = fs::canonicalize(bundle)?;
    let manifest = relay_apply::verify_manifest(
        &bundle,
        &[
            "runtime/spool-native-linux-x64",
            "runtime/spool-relay-linux-x64",
            "package.json",
        ],
    )?;
    let version = manifest["version"].as_str().ok_or("Missing version")?;
    release_download::version(version)?;
    let root = Path::new("/opt/spooldb");
    let lock = PathBuf::from("/opt/spooldb.operation.lock");
    private_files::private_dir(&lock).map_err(|error| {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == ErrorKind::AlreadyExists)
        {
            "Another relay operation is running or needs recovery".into()
        } else {
            error
        }
    })?;
    let _lock = Operation(lock.clone());
    private_files::write_private(&lock.join("pid"), std::process::id().to_string().as_bytes())?;
    let config = root.join("containers.json");
    if metadata(root)?.is_some_and(|entry| !entry.is_dir()) {
        return Err("Unmanaged relay installation directory".into());
    }
    if root.join("relay-update-journal.json").try_exists()? {
        return Err("Run sudo spool update recover before rerunning the installer".into());
    }
    let pending = root.join("vps-install-pending.json");
    let resume = regular_json(&pending)?;
    if resume
        .as_ref()
        .is_some_and(|state| state["managedBy"] != "SpoolDB" || state["domain"] != domain)
    {
        return Err("Resume installation with the original relay domain".into());
    }
    let old = regular_json(&config)?;
    managed(Path::new(CLI))?;
    managed(Path::new(UNIT))?;
    if let Some(old) = old {
        if old["managedBy"] != "SpoolDB" || old["domain"] != domain {
            return Err("The managed relay uses a different domain. Preserve its configuration and update it in place.".into());
        }
        let installation = Installation::open(&config)?;
        if resume.is_some() {
            return complete(&config, &pending, &old, automatic);
        }
        if release_download::version(version)? > release_download::version(&installation.current)? {
            let updated = relay_apply::apply(&config, &bundle)?;
            eprintln!(
                "Relay updated to {}",
                updated["version"].as_str().unwrap_or_default()
            );
        } else {
            systemctl(&["start", "spool-shared.service"])?;
            relay_recovery::probe(&old)?;
            eprintln!("The installed relay is healthy at https://{domain}");
        }
        if automatic {
            Installation::open(&config)?.configure(true, None)?;
        }
        return Ok(());
    }
    if root.try_exists()? && resume.is_none() {
        return Err("Existing application directory is unmanaged".into());
    }
    if !(domain.as_str(), 443)
        .to_socket_addrs()?
        .any(|address| !address.ip().is_loopback())
    {
        return Err("Point the domain's public A or AAAA record at the VPS".into());
    }
    let engine = engine()?;
    let run = |args: &[&str]| relay_recovery::run(engine, args);
    let containers = ["spool-relay", "spool-caddy"];
    if !inventory(&run, "container", &containers)?.is_empty() {
        return Err("Existing relay containers have no configuration receipt".into());
    }
    if resume.is_none() {
        private_files::private_dir(root)?;
        private_files::save(&pending, &json!({"managedBy":"SpoolDB","domain":domain}))?;
    }
    let id = private_files::random_id()?;
    let release = format!("{version}-{id}");
    let app = root.join("releases").join(&release);
    fs::create_dir_all(app.parent().ok_or("Invalid release storage")?)?;
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
        return Err("Could not stage the relay bundle".into());
    }
    let image = format!("localhost/spooldb-relay:{release}");
    let probe = private_files::random_id()?;
    let stamp = chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).to_rfc3339();
    private_files::save(
        &app.join(".spool-relay-release.json"),
        &json!({"managedBy":"SpoolDB","kind":"relay-release",
        "id":release,"version":version,"image":image,"createdAt":stamp}),
    )?;
    let containerfile = app.join("Containerfile");
    private_files::write_private(&containerfile, relay_apply::CONTAINERFILE.as_bytes())?;
    eprintln!("Building the relay image and downloading Caddy…");
    build(
        engine,
        &[
            "build",
            "--label",
            LABEL,
            "--label",
            &format!("dev.spooldb.release={release}"),
            "-f",
            containerfile.to_str().ok_or("Invalid Containerfile path")?,
            "-t",
            &image,
            app.to_str().ok_or("Invalid release path")?,
        ],
    )?;
    build(engine, &["pull", CADDY])?;
    let next = json!({"managedBy":"SpoolDB","app":app,"engine":engine,"image":image,"domain":domain,
        "probe":probe,"hostControl":true,"relayBackend":"rust"});
    private_files::save(&config, &next)?;
    complete(&config, &pending, &next, automatic)
}

fn complete(config: &Path, pending: &Path, next: &Value, automatic: bool) -> Result<()> {
    let root = config.parent().ok_or("Missing installation directory")?;
    let app = Path::new(next["app"].as_str().ok_or("Missing staged release")?);
    let engine =
        relay_recovery::absolute_executable(next["engine"].as_str().ok_or("Missing engine")?)?;
    let domain = next["domain"].as_str().ok_or("Missing relay domain")?;
    let probe = next["probe"].as_str().ok_or("Missing setup probe")?;
    let run = |args: &[&str]| relay_recovery::run(engine, args);
    let volumes = ["spool-relay-data", "spool-caddy-data", "spool-caddy-config"];
    let present = inventory(&run, "volume", &volumes)?;
    for name in volumes {
        if !present.iter().any(|entry| entry == name) {
            run(&["volume", "create", "--label", LABEL, name])?;
        }
    }
    if inventory(&run, "network", &["spool-network"])?.is_empty() {
        run(&["network", "create", "--label", LABEL, "spool-network"])?;
    }
    let control = root.join("control");
    match metadata(&control)? {
        Some(entry) if entry.is_dir() => {}
        Some(_) => return Err("Unmanaged relay control directory".into()),
        None => private_files::private_dir(&control)?,
    }
    std::os::unix::fs::chown(&control, Some(0), Some(1000))?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&control, fs::Permissions::from_mode(0o750))?;
    let containers = inventory(&run, "container", &["spool-relay", "spool-caddy"])?;
    if !containers.iter().any(|name| name == "spool-relay") {
        relay_apply::create_container(next, &control, &run)?;
    }
    if !containers.iter().any(|name| name == "spool-caddy") {
        run(&[
            "create",
            "--name",
            "spool-caddy",
            "--label",
            LABEL,
            "--restart=unless-stopped",
            "--network",
            "spool-network",
            "-p",
            "80:80",
            "-p",
            "443:443",
            "--mount",
            "type=volume,source=spool-caddy-data,target=/data",
            "--mount",
            "type=volume,source=spool-caddy-config,target=/config",
            CADDY,
        ])?;
    }
    let caddyfile = app.join("Caddyfile");
    fs::write(&caddyfile,format!("{domain} {{\n @health path /healthz\n header @health X-SpoolDB-Setup {probe}\n reverse_proxy relay:8878\n}}\n").as_bytes())?;
    run(&[
        "cp",
        caddyfile
            .to_str()
            .ok_or("Invalid Caddy configuration path")?,
        "spool-caddy:/etc/caddy/Caddyfile",
    ])?;
    fs::write(UNIT, unit(engine))?;
    relay_recovery::restore_cli(Path::new(CLI), &relay_apply::wrapper(app, config)?)?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "--now", "spool-shared.service"])?;
    firewall()?;
    eprintln!("Waiting for public HTTPS…");
    relay_recovery::probe(next)?;
    relay_control::install(config, next)?;
    if automatic {
        Installation::open(config)?.configure(true, None)?;
    }
    let mut child = Command::new(engine)
        .args([
            "exec",
            "-i",
            "spool-relay",
            "/app/spool-native",
            "team-host",
            "request",
            "/data",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Could not pass workspace setup request")?;
    stdin.write_all(
        json!({"command":"workspace-init","name":domain})
            .to_string()
            .as_bytes(),
    )?;
    drop(stdin);
    let result = child.wait_with_output()?;
    if !result.status.success() {
        return Err("Could not initialize the relay workspace".into());
    }
    let workspace: Value = serde_json::from_slice(&result.stdout)?;
    fs::remove_file(pending)?;
    eprintln!("Relay ready: https://{domain}");
    if let Some(link) = workspace["link"].as_str() {
        eprintln!("Private owner invitation (single use):\n{link}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn domains_are_normalized_and_engine_inventory_requires_managed_resources() -> Result<()> {
        assert_eq!(domain("https://SPOOL.example.org/")?, "spool.example.org");
        for invalid in [
            "127.0.0.1",
            "https://spool.example.org:443",
            "spool.example.test",
            "*.example.org",
            "spool.example.org/x",
        ] {
            assert!(domain(invalid).is_err(), "{invalid}");
        }
        let run = |args: &[&str]| match args {
            ["volume", "ls", ..] => Ok("spool-relay-data\nother\n".to_owned()),
            ["volume", "inspect", "spool-relay-data"] => {
                Ok(json!([{"Labels":{"dev.spooldb.managed":"true"}}]).to_string())
            }
            _ => panic!("Unexpected command {args:?}"),
        };
        assert_eq!(
            inventory(&run, "volume", &["spool-relay-data", "spool-caddy-data"])?,
            ["spool-relay-data"]
        );
        assert!(
            inventory(
                &|args| if args[1] == "ls" {
                    Ok("spool-relay".to_owned())
                } else {
                    Ok("[{\"Config\":{\"Labels\":{}}}]".to_owned())
                },
                "container",
                &["spool-relay"]
            )
            .is_err()
        );
        assert!(unit("/usr/bin/docker").contains("Requires=docker.service"));
        assert!(!unit("/usr/bin/podman").contains("docker.service"));
        Ok(())
    }
}
