use crate::{Result, init_cli, private_files, project_paths, workspace_client};
use serde_json::{Value, json};
use std::{
    io::{self, IsTerminal, Read},
    path::{Path, PathBuf},
    time::Duration,
};
use url::Url;

pub struct Resume<'a> {
    pub state: &'a Path,
    pub directory: Option<&'a str>,
    pub name: Option<&'a str>,
    pub url: Option<&'a str>,
    pub connect: Option<bool>,
    pub json: bool,
}

pub(crate) fn name_valid(name: &str) -> bool {
    let bytes = name.as_bytes();
    (3..=63).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !name.ends_with('-')
}

pub(crate) fn https_origin(value: &str) -> Result<String> {
    let url = Url::parse(value).map_err(|_| "Supply the deployed HTTPS origin with --url")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Supply the deployed HTTPS origin with --url".into());
    }
    Ok(url.origin().ascii_serialization())
}

pub(crate) fn request(
    origin: &str,
    path: &str,
    bootstrap: Option<(&str, &str)>,
) -> Result<(u16, Option<Value>, String)> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into();
    let url = format!("{origin}{path}");
    let response = match bootstrap {
        Some((token, name)) => {
            if !crate::workspace::valid_token(token) {
                return Err("Invalid setup credential in the deployment receipt".into());
            }
            agent
                .post(&url)
                .header("Authorization", &format!("Bootstrap {token}"))
                .header("Content-Type", "application/json")
                .send(json!({"name":name}).to_string())
        }
        None => agent.get(&url).call(),
    }?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|header| header.to_str().ok())
        .unwrap_or("unknown content type");
    let ray = response
        .headers()
        .get("cf-ray")
        .and_then(|header| header.to_str().ok())
        .filter(|ray| ray.len() < 100)
        .map(|ray| format!(", Ray {ray}"))
        .unwrap_or_default();
    let diagnostic = format!("HTTP {status} ({content_type}{ray})");
    let mut body = Vec::new();
    response
        .into_body()
        .into_reader()
        .take(1_000_001)
        .read_to_end(&mut body)?;
    if body.len() > 1_000_000 {
        return Err("Cloudflare response exceeds the size limit".into());
    }
    Ok((status, serde_json::from_slice(&body).ok(), diagnostic))
}

fn receipt(options: &Resume<'_>) -> Result<(PathBuf, Value, String)> {
    let selected = options.directory.map(PathBuf::from);
    let saved = selected
        .as_ref()
        .map(|directory| project_paths::optional_json::<Value>(&directory.join("deployment.json")))
        .transpose()?
        .flatten();
    let name = options
        .name
        .or_else(|| saved.as_ref().and_then(|receipt| receipt["name"].as_str()))
        .unwrap_or("spooldb");
    if !name_valid(name) {
        return Err("Worker name must be 3–63 lowercase letters, numbers or hyphens".into());
    }
    let folder =
        selected.unwrap_or_else(|| options.state.join("deployments/cloudflare").join(name));
    let path = std::path::absolute(folder)?.join("deployment.json");
    let mut receipt = project_paths::optional_json::<Value>(&path)?
        .ok_or("No published deployment receipt found. Use --name or --deploy-dir.")?;
    if receipt["name"] != name
        || !receipt["bootstrapToken"].is_string()
        || !receipt["workspaceName"].is_string()
    {
        return Err("No published deployment receipt found for this Worker".into());
    }
    let origin = https_origin(
        options
            .url
            .or_else(|| receipt["origin"].as_str())
            .ok_or("No saved deployed origin. Pass --url to resume setup.")?,
    )?;
    if let Some(link) = receipt["ownerLink"].as_str()
        && receipt["origin"] != origin
    {
        receipt["ownerLink"] = json!(workspace_client::retarget_invitation(link, &origin)?);
    }
    receipt["origin"] = json!(origin);
    Ok((path, receipt, origin))
}

pub fn resume(options: Resume<'_>) -> Result<()> {
    let (path, _, _) = receipt(&options)?;
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))?;
    lock.try_lock()
        .map_err(|_| "Another Cloudflare setup is running for this Worker")?;
    let (_, mut receipt, origin) = self::receipt(&options)?;
    private_files::save_atomic(&path, &receipt)?;
    eprintln!("Resuming setup for {origin} (no upload or publish).");
    let baseline = receipt["verificationBaseline"].clone();
    finish(
        &path,
        &mut receipt,
        &origin,
        options.connect,
        options.json,
        request,
        || crate::cloudflare_publish::verify_upgrade(&origin, &baseline),
    )?;
    crate::cloudflare_publish::promote_candidate(
        path.parent().ok_or("Missing deployment directory")?,
        &receipt,
    )
}

pub(crate) fn finish(
    path: &Path,
    receipt: &mut Value,
    origin: &str,
    connect: Option<bool>,
    json_output: bool,
    transport: impl Fn(&str, &str, Option<(&str, &str)>) -> Result<(u16, Option<Value>, String)>,
    verify: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let mut healthy = false;
    for attempt in 0..4 {
        let result = transport(origin, "/healthz", None);
        let retry = match result {
            Ok((200, Some(body), _))
                if body["protocol"] == "spool-relay/1"
                    && body["backend"] == "cloudflare"
                    && body["ok"] == true
                    && receipt["releaseMarker"]
                        .as_str()
                        .is_none_or(|marker| body["releaseMarker"] == marker) =>
            {
                healthy = true;
                break;
            }
            Ok((status, _, diagnostic)) => {
                if attempt == 3
                    || !matches!(status, 200 | 404 | 429 | 500 | 502 | 503 | 504 | 520..=527)
                {
                    return Err(format!("Worker health check returned {diagnostic}. Deployment retained. Retry with --resume after checking routing.").into());
                }
                diagnostic
            }
            Err(error) => {
                if attempt == 3 {
                    return Err(format!("Cannot reach {origin}: {error}. Deployment retained. Check DNS or pass the correct --url to --resume.").into());
                }
                error.to_string()
            }
        };
        eprintln!("Relay check failed ({retry}); retrying connection…");
        std::thread::sleep(Duration::from_millis(500 << attempt));
    }
    if !healthy {
        return Err("Worker health check failed; deployment retained".into());
    }
    verify()?;
    if !(receipt["workspace"].is_object() && receipt["ownerLink"].is_string()) {
        let token = receipt["bootstrapToken"]
            .as_str()
            .ok_or("Missing setup credential")?;
        let workspace = receipt["workspaceName"]
            .as_str()
            .ok_or("Missing workspace name")?;
        let (status, body, diagnostic) = transport(origin, "/v1/setup", Some((token, workspace)))?;
        let body = body.ok_or_else(|| {
            format!("Workspace setup returned {diagnostic} instead of JSON. Retry with --resume.")
        })?;
        if !(200..300).contains(&status) {
            return Err(body["error"]["message"]
                .as_str()
                .unwrap_or("Workspace setup failed")
                .into());
        }
        if !body["workspace"].is_object() {
            return Err("Worker setup returned an invalid workspace".into());
        }
        receipt["workspace"] = body["workspace"].clone();
        if let Some(link) = body["link"].as_str() {
            receipt["ownerLink"] = json!(workspace_client::retarget_invitation(link, origin)?);
        }
        private_files::save_atomic(path, receipt)?;
    }
    eprintln!("Relay ready: {origin}");
    if let Some(link) = receipt["ownerLink"].as_str() {
        eprintln!("Private owner invitation (single use):\n{link}");
        let saved = workspace_client::list_profiles()?;
        let already = saved["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|profile| profile["relay"] == origin);
        if !already
            && match connect {
                Some(choice) => choice,
                None => {
                    io::stdin().is_terminal()
                        && init_cli::confirm("Save a client connection to this relay?")?
                }
            }
        {
            workspace_client::invite(link, Some("Cloudflare client"))?;
            eprintln!("Connection saved. Choose it when connecting a repository.");
        }
    }
    if json_output {
        println!(
            "{}",
            json!({"deployed":true,"origin":origin,"workspace":receipt["workspace"],
            "configPath":receipt["configPath"],"receiptPath":path})
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resume_rejects_path_components_and_non_https_origins() {
        assert!(name_valid("spooldb-team-2"));
        for name in ["-spool", "spool-", "../relay", "SPOOL", "a"] {
            assert!(!name_valid(name));
        }
        for invalid in [
            "http://example.org",
            "https://example.org/setup",
            "https://example.org/?token=123",
            "https://u@example.org",
        ] {
            assert!(https_origin(invalid).is_err());
        }
        assert_eq!(
            https_origin("https://SPOOL.example.org/").unwrap(),
            "https://spool.example.org"
        );
    }

    #[test]
    fn resumes_setup_once_and_preserves_the_original_receipt() -> Result<()> {
        use std::cell::RefCell;
        let dir = std::env::temp_dir().join(format!(
            "spool-cloud-resume-{}",
            private_files::random_id()?
        ));
        private_files::private_dir(&dir)?;
        let outcome = (|| -> Result<()> {
            let path = dir.join("deployment.json");
            let origin = "https://spool.example.org";
            let workspace = json!({"id":"existing-ws","name":"Existing team"});
            let mut receipt = json!({"name":"existing","origin":origin,"bootstrapToken":"local-fixture",
                "accountId":"same-account","workspaceName":"Existing team","oauthNamespaceId":"same-oauth"});
            receipt["releaseMarker"] = json!("new-version");
            let requests = RefCell::new(Vec::new());
            let verified = std::cell::Cell::new(false);
            let transport = |address: &str, route: &str, bootstrap: Option<(&str, &str)>| {
                assert_eq!(address, origin);
                requests.borrow_mut().push(route.to_owned());
                match route {
                    "/healthz" => Ok((
                        200,
                        Some(
                            json!({"ok":true,"protocol":"spool-relay/1","backend":"cloudflare",
                            "releaseMarker":if requests.borrow().len() == 1 {"previous-version"} else {"new-version"}}),
                        ),
                        String::new(),
                    )),
                    "/v1/setup" => {
                        assert!(verified.get());
                        assert_eq!(bootstrap, Some(("local-fixture", "Existing team")));
                        Ok((200, Some(json!({"workspace":workspace})), String::new()))
                    }
                    _ => panic!("Unexpected route"),
                }
            };
            finish(
                &path,
                &mut receipt,
                origin,
                Some(false),
                false,
                transport,
                || {
                    assert_eq!(*requests.borrow(), ["/healthz", "/healthz"]);
                    verified.set(true);
                    Ok(())
                },
            )?;
            let saved = project_paths::optional_json::<Value>(&path)?.unwrap();
            assert_eq!(saved["workspace"], workspace);
            assert_eq!(saved["oauthNamespaceId"], "same-oauth");
            assert_eq!(requests.into_inner(), ["/healthz", "/healthz", "/v1/setup"]);
            Ok(())
        })();
        std::fs::remove_dir_all(dir)?;
        outcome
    }
}
