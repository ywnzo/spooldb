use crate::{
    Result, init_cli, private_files, project_paths, relay_client, team_host, workspace_client,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, IsTerminal},
    net::{IpAddr, UdpSocket},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use url::Url;

const MARKER: &str = "# Managed by SpoolDB server setup";

fn user_path(environment: &str, suffix: &str) -> Result<PathBuf> {
    let home = std::env::home_dir().ok_or("Could not locate the home directory")?;
    Ok(std::path::absolute(
        std::env::var_os(environment)
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(suffix)),
    )?)
}

pub fn configured_state() -> Result<Option<PathBuf>> {
    let config = user_path("XDG_CONFIG_HOME", ".config")?.join("spool/server-relay.json");
    Ok(project_paths::optional_json::<Value>(&config)?
        .and_then(|value| value["state"].as_str().map(PathBuf::from)))
}

fn run_command(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(format!("{program} exited with {status}").into());
    }
    Ok(())
}

fn certificate(directory: &Path, host: &str) -> Result<()> {
    let key = directory.join("relay.key");
    let cert = directory.join("relay.crt");
    match (fs::symlink_metadata(&key).ok(),fs::symlink_metadata(&cert).ok()){
        (Some(key),Some(cert)) if key.is_file()&&cert.is_file()=>{
            crate::relay_tls::configure(directory)?;
            return Ok(());
        }
        (None,None)=>{},
        _=>return Err("Existing TLS files are incomplete or symlinked. Restore the original key and certificate.".into()),
    }
    let ip = host.trim_matches(['[', ']']).parse::<IpAddr>();
    if ip.is_err()
        && !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err("Invalid private relay TLS name".into());
    }
    let san = ip.map_or_else(|_| format!("DNS:{host}"), |ip| format!("IP:{ip}"));
    let san = format!("subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost,{san}");
    let staging = directory.join(format!(".certificate-{}", private_files::random_id()?));
    private_files::private_dir(&staging)?;
    let result = (|| -> Result<()> {
        let candidate_key = staging.join("relay.key");
        let candidate_cert = staging.join("relay.crt");
        let status = Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:3072",
                "-sha256",
                "-nodes",
                "-days",
                "365",
                "-subj",
                "/CN=SpoolDB shared relay",
                "-addext",
                &san,
                "-keyout",
            ])
            .arg(&candidate_key)
            .arg("-out")
            .arg(&candidate_cert)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() {
            return Err("Could not generate the private relay certificate with OpenSSL".into());
        }
        crate::relay_tls::configure(&staging)?;
        fs::hard_link(&candidate_key, &key)?;
        if let Err(error) = fs::hard_link(&candidate_cert, &cert) {
            let _ = fs::remove_file(key);
            return Err(error.into());
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(staging);
    result
}

struct Settings<'a> {
    source: &'a Path,
    state: &'a Path,
    data: &'a Path,
    config: &'a Path,
    bin: &'a Path,
    name: &'a str,
    origin: &'a str,
    port: u16,
    tls: bool,
}

fn configure(settings: Settings<'_>, activate: bool) -> Result<Value> {
    let Settings {
        source,
        state,
        data,
        config,
        bin,
        name,
        origin,
        port,
        tls,
    } = settings;
    let parsed = Url::parse(origin)?;
    let host = if tls { "0.0.0.0" } else { "127.0.0.1" };
    if port == 0
        || parsed.host_str().is_none()
        || (!matches!(parsed.scheme(), "https" | "http"))
        || tls && parsed.scheme() != "https"
        || parsed.scheme() == "http"
            && !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Enter an HTTPS relay origin or loopback HTTP for a reverse proxy".into());
    }
    let origin = parsed.origin().ascii_serialization();
    let unit = config.join("systemd/user/spool-shared.service");
    if let Some(existing) = crate::relay_retention::metadata(&unit)?
        && (!existing.is_file()
            || existing.len() > 32_768
            || !fs::read_to_string(&unit)?.contains(MARKER))
    {
        return Err("An independently managed relay service already exists".into());
    }
    workspace_client::ensure_state(state)?;
    if tls {
        certificate(state, parsed.host_str().ok_or("Missing TLS host")?)?;
    }
    // The host initializer preserves an existing workspace and its credentials.
    let setup = team_host::setup(state, &origin, name, tls)?;
    workspace_client::ensure_state(&data.join("spool-server/runtime"))?;
    let executable = data.join("spool-server/runtime/spool-native");
    let temporary =
        executable.with_file_name(format!(".spool-native-{}", private_files::random_id()?));
    let copied = fs::copy(source, &temporary).and_then(|_| fs::rename(&temporary, &executable));
    if copied.is_err() {
        let _ = fs::remove_file(temporary);
    }
    copied?;
    private_files::save_atomic(
        &state.join("server.json"),
        &json!({"port":port,"host":host,"publicOrigin":origin,"tls":tls,"backend":"rust"}),
    )?;
    let quote = |value: &str| json!(value.replace('%', "%%").replace('$', "$$")).to_string();
    let arguments = [
        quote(executable.to_str().ok_or("Invalid executable location")?),
        "team-host".into(),
        "start".into(),
        quote(state.to_str().ok_or("Invalid state location")?),
        format!("--host={host}"),
        format!("--port={port}"),
    ]
    .join(" ");
    workspace_client::ensure_state(unit.parent().ok_or("Invalid service directory")?)?;
    fs::write(
        &unit,
        format!(
            "{MARKER}\n[Unit]\nDescription=SpoolDB shared workspace memory\nAfter=network.target\n[Service]\nExecStart={arguments}\nRestart=on-failure\nRestartSec=3\nUMask=0077\nTimeoutStopSec=45\n[Install]\nWantedBy=default.target\n"
        ),
    )?;
    let receipt = config.join("spool/server-relay.json");
    workspace_client::ensure_state(receipt.parent().ok_or("Invalid configuration directory")?)?;
    private_files::save_atomic(&receipt, &json!({"state":state,"executable":executable}))?;
    let cli = bin.join("spool");
    if !cli.try_exists()? {
        use std::os::unix::fs::PermissionsExt;
        fn shell(path: &Path) -> String {
            format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
        }
        workspace_client::ensure_state(bin)?;
        private_files::write_private(
            &cli,
            format!(
                "#!/bin/sh\n# Managed by SpoolDB CLI installer\nexec {} \"$@\"\n",
                shell(&executable)
            )
            .as_bytes(),
        )?;
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755))?;
    }
    if activate {
        run_command("systemctl", &["--user", "daemon-reload"])?;
        run_command(
            "systemctl",
            &["--user", "enable", "--now", "spool-shared.service"],
        )?;
        let local = format!("{}://127.0.0.1:{port}", if tls { "https" } else { "http" });
        let trust = tls
            .then(|| crate::relay_tls::certificate(state))
            .transpose()?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if relay_client::local_health(&local, trust.as_deref())
                .is_ok_and(|value| value["ok"] == true && value["protocol"] == "spool-relay/1")
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err(
                    "Relay did not become ready. Check journalctl --user -u spool-shared.service"
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    Ok(
        json!({"cli":cli,"state":state,"unit":unit,"origin":origin,"workspace":setup["workspace"],
        "ownerLink":setup["link"],"alreadyConfigured":setup["alreadyConfigured"]==true}),
    )
}

pub fn setup(bundle: &Path) -> Result<()> {
    if !io::stdin().is_terminal() {
        return Err("Run server setup in an interactive terminal".into());
    }
    let input = init_cli::prompt(
        "Public domain for VPS HTTPS, or enter advanced for LAN setup",
        "",
    )?;
    if input.eq_ignore_ascii_case("advanced") {
        return advanced();
    }
    let domain = crate::vps_install::domain(&input)?;
    eprintln!(
        "Relay URL: https://{domain}\nDocker or Podman runs the relay and Caddy. Named volumes hold project memory and certificates."
    );
    if !init_cli::confirm("Install the containerized relay and Caddy? This requires root or sudo.")?
    {
        return Ok(());
    }
    let automatic =
        init_cli::confirm("Enable daily relay updates with health checks and rollback?")?;
    let executable = std::env::current_exe()?;
    let mut command = if rustix::process::getuid().is_root() {
        Command::new(executable)
    } else {
        let mut command = Command::new("sudo");
        command.arg("--").arg(executable);
        command
    };
    if !command
        .arg("vps-install")
        .arg(bundle)
        .arg(domain)
        .arg(if automatic { "automatic" } else { "manual" })
        .status()?
        .success()
    {
        return Err(
            "VPS setup did not finish. Correct the relay error and rerun the installer.".into(),
        );
    }
    Ok(())
}

pub fn advanced() -> Result<()> {
    if !io::stdin().is_terminal() {
        return Err("Run advanced server setup in an interactive terminal".into());
    }
    let data = user_path("XDG_DATA_HOME", ".local/share")?;
    let config = user_path("XDG_CONFIG_HOME", ".config")?;
    let state = user_path("XDG_STATE_HOME", ".local/state")?.join("spool-server");
    let bin = user_path("SPOOL_BIN_HOME", ".local/bin")?;
    let name = init_cli::prompt("Workspace name", "Company workspace")?;
    let state = std::path::absolute(init_cli::prompt(
        "Persistent server storage",
        &state.to_string_lossy(),
    )?)?;
    let mode = init_cli::prompt(
        "HTTPS mode (1 = private LAN certificate, 2 = existing reverse proxy)",
        "1",
    )?;
    if !matches!(mode.as_str(), "1" | "2") {
        return Err("Choose 1 or 2 for HTTPS mode".into());
    }
    let tls = mode == "1";
    let port = init_cli::prompt("Relay port", "8878")?.parse::<u16>()?;
    let address = UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("192.0.2.1:9")?;
            Ok(socket.local_addr()?.ip().to_string())
        })
        .unwrap_or_else(|_| "localhost".into());
    let default = if tls {
        format!("https://{address}:{port}")
    } else {
        "https://memory.example.com".into()
    };
    let origin = init_cli::prompt("Reachable server URL (include https://)", &default)?;
    eprintln!(
        "Workspace: {name}\nURL: {origin}\nStorage: {}",
        state.display()
    );
    if !init_cli::confirm("Install and start the shared relay?")? {
        return Ok(());
    }
    let result = configure(
        Settings {
            source: &std::env::current_exe()?,
            state: &state,
            data: &data,
            config: &config,
            bin: &bin,
            name: &name,
            origin: &origin,
            port,
            tls,
        },
        true,
    )?;
    eprintln!(
        "Relay ready: {}",
        result["origin"].as_str().unwrap_or_default()
    );
    if let Some(link) = result["ownerLink"].as_str() {
        eprintln!("Private owner invitation (single use):\n{link}");
    } else {
        eprintln!(
            "Workspace already configured. Use spool server workspace owner-invite for owner recovery."
        );
    }
    if init_cli::confirm("Keep the relay running after logout and start it at boot?")?
        && let Err(error) = run_command("loginctl", &["enable-linger"])
    {
        eprintln!("Administrator action may be needed to enable startup at boot: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advanced_setup_preserves_server_identity_and_private_certificate() -> Result<()> {
        let directory = std::env::temp_dir().join(format!(
            "spool-server-install-{}",
            private_files::random_id()?
        ));
        private_files::private_dir(&directory)?;
        let outcome = (|| -> Result<()> {
            let source = directory.join("executable");
            fs::write(&source, b"fixture")?;
            let state = directory.join("relay-state");
            let data = directory.join("xdg-data");
            let config = directory.join("xdg-config");
            let bin = directory.join("bin");
            let settings = || Settings {
                source: &source,
                state: &state,
                data: &data,
                config: &config,
                bin: &bin,
                name: "Existing relay",
                origin: "https://127.0.0.1:8878",
                port: 8878,
                tls: true,
            };
            let first = configure(settings(), false)?;
            assert!(
                first["ownerLink"]
                    .as_str()
                    .is_some_and(|link| link.starts_with("spool://workspace/"))
            );
            let original = crate::relay_tls::certificate(&state)?;
            let second = configure(settings(), false)?;
            assert_eq!(first["workspace"]["id"], second["workspace"]["id"]);
            assert_eq!(second["alreadyConfigured"], true);
            assert_eq!(original, crate::relay_tls::certificate(&state)?);
            assert!(
                fs::read_to_string(config.join("systemd/user/spool-shared.service"))?
                    .contains("team-host start")
            );
            let listed = team_host::request(&state, &json!({"command":"list"}))?;
            assert_eq!(listed["url"], "https://127.0.0.1:8878");
            Ok(())
        })();
        fs::remove_dir_all(directory)?;
        outcome
    }
}
