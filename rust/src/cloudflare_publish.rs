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

#[derive(Debug)]
struct MissingWorker;
impl std::fmt::Display for MissingWorker {
    fn fmt(&self, fmt: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        fmt.write_str("The Cloudflare Worker does not exist")
    }
}
impl std::error::Error for MissingWorker {}

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
        if args.starts_with(&["deployments", "list"])
            && String::from_utf8_lossy(&output.stderr).contains("[code: 10007]")
        {
            return Err(MissingWorker.into());
        }
        return Err(format!(
            "Wrangler failed ({}). Deployment files and logs are retained.",
            output.status
        )
        .into());
    }
    Ok(text)
}

fn single_version(text: &str) -> Result<Option<String>> {
    let deployments: Vec<Value> = serde_json::from_str(text)?;
    let Some(deployment) = deployments.last() else {
        return Ok(None);
    };
    let versions = deployment["versions"]
        .as_array()
        .ok_or("Invalid Wrangler deployment list")?;
    let [version] = versions.as_slice() else {
        return Err(
            "Existing Worker uses split traffic. Restore a single version before upgrading.".into(),
        );
    };
    let id = version["version_id"]
        .as_str()
        .filter(|id| crate::relay_retention::uuid(id))
        .ok_or("Invalid Worker version ID")?;
    if version["percentage"].as_f64() != Some(100.0) {
        return Err("Expected one Worker version receiving all traffic".into());
    }
    Ok(Some(id.to_owned()))
}

fn probe_project(origin: &str, previous: Option<&Value>) -> Result<Option<Value>> {
    for root in crate::project_binding::registered_roots()? {
        let Some(grant) = crate::project_binding::resolve(&root)
            .ok()
            .and_then(|binding| binding.grant)
        else {
            continue;
        };
        if grant.url != origin || previous.is_some_and(|probe| probe["room"] != grant.room) {
            continue;
        }
        let room = grant.room.clone();
        let client = crate::relay_client::Client::new(grant)?;
        let result = if let Some(previous) = previous {
            previous.clone()
        } else {
            let recent = client.request(
                "memory",
                Some(&json!({
                    "command":"search","query":"","mode":"keyword","limit":1
                })),
            )?;
            json!({"room":room,"record":recent["results"][0]["id"]})
        };
        let request = if let Some(id) = result["record"].as_str() {
            json!({"command":"get","id":id,"limit":1})
        } else {
            json!({"command":"context","compact":true})
        };
        let read = client.request("memory", Some(&request))?;
        if result["record"].is_string() && read["id"] != result["record"] {
            return Err("The existing project record did not survive the upgrade".into());
        }
        return Ok(Some(result));
    }
    Ok(None)
}

pub(crate) fn verify_workspace(origin: &str) -> Result<Value> {
    let workspace = workspace_client::action(origin, &json!({"command":"list"}))
        .map_err(|_| "Connect an existing workspace profile to this relay before upgrading it.")?;
    let mut projects = workspace["projects"]
        .as_array()
        .ok_or("Workspace response is missing its project catalog")?
        .iter()
        .filter_map(|p| p["room"].as_str())
        .collect::<Vec<_>>();
    projects.sort_unstable();
    let id = workspace["workspace"]["id"]
        .as_str()
        .ok_or("Missing workspace identity")?;
    Ok(json!({"id":id,"projects":projects}))
}

pub(crate) fn verify_upgrade(origin: &str, baseline: &Value) -> Result<()> {
    if baseline.is_null() {
        return Ok(());
    }
    let catalog = verify_workspace(origin)?;
    let previous = baseline["projects"]
        .as_array()
        .ok_or("Invalid verification baseline")?;
    let current = catalog["projects"]
        .as_array()
        .ok_or("Missing workspace project catalog")?;
    if catalog["id"] != baseline["id"] || previous.iter().any(|id| !current.contains(id)) {
        return Err("The upgraded Worker did not retain the existing workspace catalog".into());
    }
    if let Some(probe) = baseline.get("probe").filter(|probe| probe.is_object())
        && probe_project(origin, Some(probe))?.is_none()
    {
        return Err("The existing project connection is unavailable for a post-deploy read".into());
    }
    Ok(())
}

pub(crate) fn promote_candidate(folder: &Path, receipt: &Value) -> Result<()> {
    let candidate = folder.join("wrangler.candidate.json");
    let marker = &receipt["releaseMarker"];
    if marker.is_string()
        && project_paths::optional_json::<Value>(&candidate)?
            .is_some_and(|config| config["vars"]["SPOOL_RELEASE_MARKER"] == *marker)
    {
        fs::rename(&candidate, folder.join("wrangler.json"))?;
    }
    let attempt = folder.join("deployment.candidate.json");
    if marker.is_string()
        && project_paths::optional_json::<Value>(&attempt)?
            .is_some_and(|config| config["releaseMarker"] == *marker)
    {
        fs::remove_file(attempt)?;
    }
    Ok(())
}

fn config(root: &Path, name: &str, receipt: &Value, prior: &Value) -> Result<Value> {
    let backend = receipt["backend"].as_str().unwrap_or("rust");
    let token = receipt["bootstrapToken"]
        .as_str()
        .ok_or("Missing setup credential")?;
    let mut config = if prior.is_object() {
        prior.clone()
    } else {
        json!({
            "compatibility_date":"2026-10-19",
            "compatibility_flags":["nodejs_compat","global_fetch_strictly_public"],
            "workers_dev":true,
            "durable_objects":{"bindings":[{"name":"WORKSPACE","class_name":"SpoolWorkspace"},
                {"name":"PROJECTS","class_name":"SpoolProject"}]},
            "migrations":[{"tag":"v1","new_sqlite_classes":["SpoolWorkspace","SpoolProject"]}],
            "limits":{"cpu_ms":30000},"observability":{"enabled":true}
        })
    };
    config["name"] = json!(name);
    config["main"] = json!(root.join(if backend == "rust" {
        "rust/cloudflare/entry.js"
    } else {
        "src/cloudflare/worker.js"
    }));
    config["alias"]["node:sqlite"] = json!(root.join("src/cloudflare/no-node-sqlite.js"));
    let bootstrap = json!(format!("{:x}", Sha256::digest(token)));
    if prior["vars"]["BOOTSTRAP_TOKEN_HASH"].as_str().is_some()
        && prior["vars"]["BOOTSTRAP_TOKEN_HASH"] != bootstrap
    {
        return Err(
            "Saved bootstrap credential does not match the existing Worker configuration".into(),
        );
    }
    config["vars"]["BOOTSTRAP_TOKEN_HASH"] = bootstrap;
    if let Some(marker) = receipt["releaseMarker"].as_str() {
        config["vars"]["SPOOL_RELEASE_MARKER"] = json!(marker);
    }
    if let Some(account) = receipt["accountId"].as_str() {
        config["account_id"] = json!(account);
    }
    if let Some(namespace) = receipt["oauthNamespaceId"].as_str() {
        if !account_valid(namespace) {
            return Err("Invalid saved OAuth KV namespace".into());
        }
        let mut bindings = config["kv_namespaces"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        bindings.retain(|binding| binding["binding"] != "OAUTH_KV");
        bindings.push(json!({"binding":"OAUTH_KV","id":namespace}));
        config["kv_namespaces"] = json!(bindings);
    }
    if receipt["workersAi"] == true {
        config["ai"] = json!({"binding":"AI"});
    } else {
        config.as_object_mut().unwrap().remove("ai");
    }
    let downloads = root.join("work/download-assets");
    if let Some(path) = config["assets"]["directory"].as_str() {
        if Path::new(path).is_absolute() && !Path::new(path).is_dir() {
            return Err(
                "The saved download asset directory is missing. Restore it before deploying."
                    .into(),
            );
        }
    } else if downloads.join("manifest.json").is_file() {
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
    let candidate_path = folder.join("wrangler.candidate.json");
    let attempt_path = folder.join("deployment.candidate.json");
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
    if let Some(id) = prior["kv_namespaces"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|binding| binding["binding"] == "OAUTH_KV")
        .and_then(|binding| binding["id"].as_str())
    {
        if receipt["oauthNamespaceId"]
            .as_str()
            .is_some_and(|saved| saved != id)
        {
            return Err("Saved OAuth namespace and Wrangler configuration disagree".into());
        }
        receipt["oauthNamespaceId"] = json!(id);
    }
    receipt["releaseMarker"] = json!(private_files::random_id()?);
    let prepared = config(&root, &name, &receipt, &prior)?;
    let changed = prepared
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, value)| prior.get(key.as_str()) != Some(*value))
        .map(|(key, _)| key.as_str())
        .collect::<Vec<_>>();
    eprintln!("Candidate configuration changes: {}", changed.join(", "));
    private_files::save_atomic(&candidate_path, &prepared)?;
    let config_arg = candidate_path
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
                json!({"prepared":true,"deployed":false,"configPath":candidate_path})
            );
        } else {
            eprintln!("Build verified. No Worker was published.");
        }
        return Ok(());
    }
    let deployment_list = ["deployments", "list", "--json", "--config", config_arg];
    let previous = match invoke(&deployment_list, false) {
        Ok(list) => single_version(&list)?,
        Err(error) if error.is::<MissingWorker>() => None,
        Err(error) => return Err(error),
    };
    let baseline = if previous.is_some() {
        let origin = options.common.url.or_else(|| receipt["origin"].as_str())
            .ok_or("Existing Worker requires its saved deployment receipt or --url for authenticated verification")?;
        let origin = cloudflare_deploy::https_origin(origin)?;
        let mut catalog = verify_workspace(&origin)?;
        let probe = probe_project(&origin, None)?;
        if probe.is_none()
            && catalog["projects"]
                .as_array()
                .is_some_and(|rooms| !rooms.is_empty())
        {
            return Err("Connect a repository to an existing project on this relay before upgrading so its memory can be verified.".into());
        }
        catalog["probe"] = json!(probe);
        Some(catalog)
    } else {
        None
    };
    if receipt["origin"].is_string() && previous.is_none() {
        return Err(
            "The saved Worker could not be found. Verify the account and Worker name.".into(),
        );
    }
    receipt["previousVersion"] = json!(previous);
    receipt["verificationBaseline"] = json!(baseline);
    receipt["configPath"] = json!(config_path);
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
        private_files::save_atomic(&candidate_path, &config(&root, &name, &receipt, &prior)?)?;
    }
    private_files::save_atomic(&attempt_path, &receipt)?;
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
    let current = published.lines().find_map(|line| {
        line.trim().strip_prefix("Current Version ID:").map(str::trim)
    }).filter(|id| crate::relay_retention::uuid(id))
        .ok_or("Wrangler did not report the uploaded Worker version. Inspect deployment history before resuming.")?;
    let mut active = false;
    for attempt in 0..4 {
        if single_version(&invoke(&deployment_list, false)?)?.as_deref() == Some(current) {
            active = true;
            break;
        }
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(500 << attempt));
        }
    }
    if !active {
        return Err("The uploaded Worker version is not active. Inspect deployment history before resuming.".into());
    }
    if previous.as_deref() == Some(current) {
        return Err("Wrangler still reports the previous version as active".into());
    }
    receipt["deployedVersion"] = json!(current);
    private_files::save_atomic(&path, &receipt)?;
    let verification = receipt["verificationBaseline"].clone();
    let verify = || verify_upgrade(&origin, &verification);
    if let Err(error) = cloudflare_deploy::finish(
        &path,
        &mut receipt,
        &origin,
        options.common.connect,
        options.common.json,
        cloudflare_deploy::request,
        verify,
    ) {
        if let Some(previous) = previous {
            eprintln!(
                "Verification failed. Inspect the deployed Worker, then restore the previous version with: wrangler rollback {previous} --config {}",
                config_path.display()
            );
        }
        return Err(error);
    }
    promote_candidate(&folder, &receipt)
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
        let previous = config(root, "spool-app", &receipt, &Value::Null)?;
        let mut previous = previous;
        previous["routes"] = json!([{"pattern":"relay.example.org","custom_domain":true}]);
        previous["assets"] =
            json!({"directory":"./assets","binding":"DOWNLOADS","run_worker_first":true});
        previous["kv_namespaces"]
            .as_array_mut()
            .unwrap()
            .push(json!({"binding":"ADDITIONAL","id":"additional-namespace"}));
        previous["vars"]["PUBLIC_ORIGIN"] = json!("https://relay.example.org");
        previous["vars"]["EMBEDDING_MODEL"] = json!("existing-model");
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
            configured["vars"]["PUBLIC_ORIGIN"],
            previous["vars"]["PUBLIC_ORIGIN"]
        );
        assert_eq!(configured["routes"], previous["routes"]);
        assert_eq!(configured["assets"], previous["assets"]);
        assert!(
            configured["kv_namespaces"]
                .as_array()
                .unwrap()
                .contains(&previous["kv_namespaces"][1])
        );
        assert_eq!(
            configured["kv_namespaces"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["binding"] == "OAUTH_KV")
                .unwrap()["id"],
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
