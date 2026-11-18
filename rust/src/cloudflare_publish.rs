use crate::{
    Result,
    cloudflare_deploy::{self, Resume},
    init_cli, private_files, project_paths, workspace_client,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, IsTerminal},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub struct Publish<'a> {
    pub common: Resume<'a>,
    pub account: Option<&'a str>,
    pub workspace: Option<&'a str>,
    pub backend: Option<&'a str>,
    pub ai: Option<bool>,
    pub dry: bool,
    pub yes: bool,
}

fn account_valid(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|c| matches!(c,b'0'..=b'9'|b'a'..=b'f'))
}

fn root() -> Result<PathBuf> {
    let binary = std::env::current_exe()?;
    let cwd = std::env::current_dir()?;
    binary
        .ancestors()
        .chain(cwd.ancestors())
        .find(|path| path.join("src/cloudflare/worker.js").is_file())
        .map(Path::to_owned)
        .ok_or(
            "Run from a SpoolDB checkout or an installed release containing the Cloudflare assets"
                .into(),
        )
}

fn wrangler(
    root: &Path,
    folder: &Path,
    args: &[&str],
    visible: bool,
    interactive: bool,
) -> Result<String> {
    let bundled = root.join("runtime/bun");
    let runtime = if bundled.is_file() {
        bundled
    } else {
        PathBuf::from("bun")
    };
    let installed = root.join("node_modules/wrangler/bin/wrangler.js");
    let mut command = Command::new(runtime);
    if installed.is_file() {
        command.arg(installed);
    } else {
        command.args(["x", "--bun", "wrangler@4.152.0"]);
    }
    command
        .args(args)
        .current_dir(root)
        .env("WRANGLER_SEND_METRICS", "false")
        .env("WRANGLER_LOG_PATH", folder.join("wrangler.log"));
    if interactive {
        if !command.status()?.success() {
            return Err("Wrangler sign-in failed".into());
        }
        return Ok(String::new());
    }
    let output = command.stdin(Stdio::null()).output()?;
    if output.stdout.len() + output.stderr.len() > 2_000_000 {
        return Err("Wrangler output exceeds limit".into());
    }
    let text = String::from_utf8(output.stdout)?;
    if visible {
        eprint!("{text}");
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
    }
    if !output.status.success() {
        return Err(format!(
            "Wrangler failed ({}). Deployment files and logs are retained.",
            output.status
        )
        .into());
    }
    Ok(text)
}

fn config(root: &Path, name: &str, receipt: &Value, prior: &Value) -> Result<Value> {
    let backend = receipt["backend"].as_str().unwrap_or("rust");
    let token = receipt["bootstrapToken"]
        .as_str()
        .ok_or("Missing setup credential")?;
    let mut config = json!({
        "name":name,
        "main":root.join(if backend=="rust"{"rust/cloudflare/entry.js"}else{"src/cloudflare/worker.js"}),
        "compatibility_date":"2026-10-19","compatibility_flags":["nodejs_compat","global_fetch_strictly_public"],
        "workers_dev":true,"alias":{"node:sqlite":root.join("src/cloudflare/no-node-sqlite.js")},
        "durable_objects":{"bindings":[{"name":"WORKSPACE","class_name":"SpoolWorkspace"},
            {"name":"PROJECTS","class_name":"SpoolProject"}]},
        "migrations":[{"tag":"v1","new_sqlite_classes":["SpoolWorkspace","SpoolProject"]}],
        "vars":{"BOOTSTRAP_TOKEN_HASH":format!("{:x}",Sha256::digest(token))},
        "limits":{"cpu_ms":30000},"observability":{"enabled":true}
    });
    if let Some(account) = receipt["accountId"].as_str() {
        config["account_id"] = json!(account);
    }
    if let Some(namespace) = receipt["oauthNamespaceId"].as_str() {
        if !account_valid(namespace) {
            return Err("Invalid saved OAuth KV namespace".into());
        }
        config["kv_namespaces"] = json!([{"binding":"OAUTH_KV","id":namespace}]);
    }
    if receipt["workersAi"] == true {
        config["ai"] = json!({"binding":"AI"});
        if let Some(model) = prior["vars"]["EMBEDDING_MODEL"].as_str() {
            config["vars"]["EMBEDDING_MODEL"] = json!(model);
        }
    }
    let downloads = root.join("work/download-assets");
    if downloads.join("manifest.json").is_file() {
        config["assets"] =
            json!({"directory":downloads,"binding":"DOWNLOADS","run_worker_first":true});
    }
    Ok(config)
}

fn digest(path: &Path) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(fs::read(path)?)))
}
fn sources(root: &Path) -> Result<String> {
    fn file(root: &Path, path: &str, hash: &mut Sha256) -> Result<()> {
        hash.update(json!([path, digest(&root.join(path))?]).to_string());
        Ok(())
    }
    fn walk(root: &Path, path: &str, hash: &mut Sha256) -> Result<()> {
        let mut entries = fs::read_dir(root.join(path))?.collect::<io::Result<Vec<_>>>()?;
        entries.sort_by_key(fs::DirEntry::file_name);
        for entry in entries {
            let name = format!(
                "{path}/{}",
                entry
                    .file_name()
                    .to_str()
                    .ok_or("Invalid Worker source path")?
            );
            if entry.file_type()?.is_dir() {
                walk(root, &name, hash)?;
            } else if entry.file_type()?.is_file() {
                file(root, &name, hash)?;
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    for path in [
        "rust/cloudflare/Cargo.toml",
        "rust/cloudflare/Cargo.lock",
        "rust/cloudflare/entry.js",
        "package.json",
    ] {
        file(root, path, &mut hash)?;
    }
    for path in [
        "rust/cloudflare/src",
        "rust/cloudflare/assets",
        "rust/shared",
        "src/cloudflare",
        "src/review/public",
    ] {
        walk(root, path, &mut hash)?;
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn worker(root: &Path) -> Result<()> {
    let build = root.join("rust/cloudflare/build");
    let manifest_path = build.join("spool-release.json");
    let package = project_paths::optional_json::<Value>(&root.join("package.json"))?
        .ok_or("Missing SpoolDB package")?;
    let source = if root.join("rust/cloudflare/Cargo.toml").is_file() {
        Some(sources(root)?)
    } else {
        None
    };
    let artifacts = ["index.js", "index_bg.wasm"];
    let existing = project_paths::optional_json::<Value>(&manifest_path)?.unwrap_or(Value::Null);
    if existing["version"] == package["version"]
        && source
            .as_ref()
            .is_none_or(|source| existing["sources"] == *source)
        && artifacts
            .iter()
            .all(|name| digest(&build.join(name)).is_ok_and(|sha| existing["files"][name] == sha))
    {
        return Ok(());
    }
    let original = source
        .ok_or("Release Worker artifacts are missing or invalid. Reinstall the release package.")?;
    let status=Command::new("worker-build").args(["rust/cloudflare","--release","--locked"])
        .current_dir(root).stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).status()
        .map_err(|_|"Install worker-build and the wasm32-unknown-unknown target, or use a release package")?;
    if !status.success() {
        return Err("Rust Worker build failed".into());
    }
    if sources(root)? != original {
        return Err("Worker sources changed during the build. Run deployment again.".into());
    }
    let mut files = serde_json::Map::new();
    for name in artifacts {
        files.insert(name.to_owned(), json!(digest(&build.join(name))?));
    }
    private_files::save_atomic(
        &manifest_path,
        &json!({"version":package["version"],"sources":original,"files":files}),
    )
}

pub fn run(options: Publish<'_>) -> Result<()> {
    let root = root()?;
    let console = io::stdin().is_terminal();
    if !options.dry
        && !console
        && (!options.yes || options.common.name.is_none() || options.account.is_none())
    {
        return Err("Use an interactive terminal, or --yes with --name and --account-id".into());
    }
    let ask = |label: &str, default: &str| {
        if console {
            init_cli::prompt(label, default)
        } else {
            Ok(default.to_owned())
        }
    };
    let name = options
        .common
        .name
        .map(str::to_owned)
        .map_or_else(|| ask("Worker name", "spooldb"), Ok)?;
    if !cloudflare_deploy::name_valid(&name) {
        return Err("Worker name must be 3–63 lowercase letters, numbers or hyphens".into());
    }
    let backend = options.backend.unwrap_or("rust");
    if !matches!(backend, "rust" | "bun") {
        return Err("Choose the rust or bun Cloudflare backend".into());
    }
    let folder = options
        .common
        .directory
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            options
                .common
                .state
                .join("deployments/cloudflare")
                .join(&name)
        });
    let folder = std::path::absolute(folder)?;
    workspace_client::ensure_state(&folder)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(folder.join("deployment.lock"))?;
    lock.try_lock()
        .map_err(|_| "Another Cloudflare deployment is running for this Worker")?;
    let path = folder.join("deployment.json");
    let config_path = folder.join("wrangler.json");
    let mut receipt = project_paths::optional_json::<Value>(&path)?.unwrap_or_else(|| json!({}));
    if !receipt.is_object() || receipt["name"].as_str().is_some_and(|prior| prior != name) {
        return Err("Deployment directory belongs to another Worker".into());
    }
    if backend == "rust" {
        worker(&root)?;
    }
    let prior = project_paths::optional_json::<Value>(&config_path)?.unwrap_or(Value::Null);
    let invoke = |args: &[&str], visible| wrangler(&root, &folder, args, visible, false);
    let mut account = options
        .account
        .or_else(|| receipt["accountId"].as_str())
        .map(str::to_owned);
    if !options.dry {
        let identify = || {
            serde_json::from_str::<Value>(&invoke(&["whoami", "--json"], false)?)
                .map_err(Into::into)
        };
        let identity = match identify() {
            Ok(identity) => identity,
            Err(_)
                if console
                    && matches!(
                        ask("Sign in to Cloudflare in your browser? (Y/n)", "Y")?
                            .to_lowercase()
                            .as_str(),
                        "y" | "yes"
                    ) =>
            {
                wrangler(&root, &folder, &["login"], true, true)?;
                identify()?
            }
            Err(error) => return Err(error),
        };
        let accounts = identity["accounts"]
            .as_array()
            .or_else(|| identity["account"]["accounts"].as_array());
        if account.is_none() {
            account = match accounts.map(Vec::as_slice) {
                Some([available]) => available["id"].as_str().map(str::to_owned),
                Some(available) if !available.is_empty() => {
                    for (index, item) in available.iter().enumerate() {
                        eprintln!(
                            "{}. {}",
                            index + 1,
                            item["name"].as_str().unwrap_or("Cloudflare account")
                        );
                    }
                    let index = ask("Account number", "1")?
                        .parse::<usize>()?
                        .checked_sub(1)
                        .ok_or("Choose a Cloudflare account")?;
                    available
                        .get(index)
                        .and_then(|item| item["id"].as_str())
                        .map(str::to_owned)
                }
                _ => Some(ask("Cloudflare account ID", "")?),
            };
        }
        if accounts.is_some_and(|available| {
            !available.is_empty()
                && !available
                    .iter()
                    .any(|a| a["id"].as_str() == account.as_deref())
        }) {
            return Err("Selected account is not available to this Cloudflare login".into());
        }
    }
    if account.as_deref().is_some_and(|id| !account_valid(id)) || !options.dry && account.is_none()
    {
        return Err("Supply a valid Cloudflare account ID".into());
    }
    if receipt["accountId"]
        .as_str()
        .is_some_and(|prior| account.as_deref() != Some(prior))
    {
        return Err("This deployment belongs to another Cloudflare account".into());
    }
    let workspace = options
        .workspace
        .or_else(|| receipt["workspaceName"].as_str())
        .map(str::to_owned)
        .map_or_else(|| ask("Workspace name", "Company workspace"), Ok)?;
    if workspace.trim().is_empty() || workspace.chars().count() > 160 {
        return Err("Enter a workspace name with 1–160 characters".into());
    }
    if receipt["bootstrapToken"].is_null() {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes)?;
        receipt["bootstrapToken"] = json!(URL_SAFE_NO_PAD.encode(bytes));
    }
    if !receipt["bootstrapToken"]
        .as_str()
        .is_some_and(crate::workspace::valid_token)
    {
        return Err("Invalid setup credential in the deployment receipt".into());
    }
    receipt["name"] = json!(name);
    receipt["backend"] = json!(backend);
    receipt["accountId"] = json!(account);
    receipt["workspaceName"] = json!(workspace);
    receipt["workersAi"] = json!(
        options
            .ai
            .unwrap_or(receipt["workersAi"] == true || prior["ai"]["binding"] == "AI")
    );
    receipt["configPath"] = json!(config_path);
    private_files::save_atomic(&path, &receipt)?;
    private_files::save_atomic(&config_path, &config(&root, &name, &receipt, &prior)?)?;
    let config_arg = config_path
        .to_str()
        .ok_or("Invalid Wrangler configuration path")?;
    let out = folder.join("bundle");
    let out = out.to_str().ok_or("Invalid deployment output path")?;
    eprintln!(
        "Worker: {name}\nWorkspace: {workspace}\nDeployment files: {}",
        folder.display()
    );
    invoke(
        &[
            "deploy",
            "--config",
            config_arg,
            "--dry-run",
            "--outdir",
            out,
        ],
        true,
    )?;
    if options.dry
        || !options.yes
            && !init_cli::confirm("Publish this Worker and its Durable Object namespaces?")?
    {
        if options.common.json {
            println!(
                "{}",
                json!({"prepared":true,"deployed":false,"configPath":config_path})
            );
        } else {
            eprintln!("Build verified. No Worker was published.");
        }
        return Ok(());
    }
    if receipt["oauthNamespaceId"].is_null() {
        let title = format!("{name}-oauth");
        let lookup = || -> Result<Option<String>> {
            let list: Vec<Value> = serde_json::from_str(&invoke(
                &["kv", "namespace", "list", "--config", config_arg],
                false,
            )?)?;
            Ok(list
                .into_iter()
                .find(|item| item["title"] == title)
                .and_then(|item| item["id"].as_str().map(str::to_owned)))
        };
        let namespace = if let Some(namespace) = lookup()? {
            namespace
        } else {
            invoke(
                &[
                    "kv",
                    "namespace",
                    "create",
                    &title,
                    "--config",
                    config_arg,
                    "--update-config=false",
                ],
                true,
            )?;
            lookup()?.ok_or("OAuth KV namespace was not found. Retry deployment to recover it.")?
        };
        if !account_valid(&namespace) {
            return Err("Invalid OAuth namespace ID".into());
        }
        receipt["oauthNamespaceId"] = json!(namespace);
        private_files::save_atomic(&path, &receipt)?;
        private_files::save_atomic(&config_path, &config(&root, &name, &receipt, &prior)?)?;
    }
    let published = invoke(&["deploy", "--config", config_arg], true)?;
    let discovered = published.split_ascii_whitespace().find(|value| {
        url::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|host| host.ends_with(".workers.dev"))
        })
    });
    let origin = options
        .common
        .url
        .or_else(|| receipt["origin"].as_str())
        .or(discovered)
        .map(str::to_owned)
        .map_or_else(|| ask("Deployed HTTPS relay URL", ""), Ok)?;
    let origin = cloudflare_deploy::https_origin(&origin)?;
    if let Some(link) = receipt["ownerLink"].as_str()
        && receipt["origin"] != origin
    {
        receipt["ownerLink"] = json!(workspace_client::retarget_invitation(link, &origin)?);
    }
    receipt["origin"] = json!(origin);
    receipt["deployedAt"] =
        json!(chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).to_rfc3339());
    private_files::save_atomic(&path, &receipt)?;
    cloudflare_deploy::finish(
        &path,
        &mut receipt,
        &origin,
        options.common.connect,
        options.common.json,
        cloudflare_deploy::request,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_config_keeps_durable_object_bindings_and_existing_settings() -> Result<()> {
        let root = Path::new("/spool/deploy-fixture");
        let receipt = json!({"backend":"rust","accountId":"0123456789abcdef0123456789abcdef",
            "bootstrapToken":"local-fixture","oauthNamespaceId":"fedcba9876543210fedcba9876543210",
            "workersAi":true});
        let previous = json!({"vars":{"EMBEDDING_MODEL":"existing-model"}});
        let configured = config(root, "spool-app", &receipt, &previous)?;
        assert_eq!(
            configured["main"],
            json!(root.join("rust/cloudflare/entry.js"))
        );
        assert_eq!(
            configured["migrations"][0]["new_sqlite_classes"],
            json!(["SpoolWorkspace", "SpoolProject"])
        );
        assert_eq!(configured["vars"]["EMBEDDING_MODEL"], "existing-model");
        assert_eq!(
            configured["kv_namespaces"][0]["id"],
            receipt["oauthNamespaceId"]
        );
        assert_eq!(
            configured["vars"]["BOOTSTRAP_TOKEN_HASH"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        assert!(!configured.to_string().contains("local-fixture"));
        Ok(())
    }
}
