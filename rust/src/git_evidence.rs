use crate::{
    Result,
    project_binding::{git, repository_key, repository_root},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::Path};
use url::Url;

fn digest(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn commit_hash(text: &str) -> bool {
    matches!(text.len(), 40 | 64)
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn commit(root: &Path) -> Option<String> {
    git(root, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .filter(|value| commit_hash(value))
}

fn repository(root: &Path) -> Option<String> {
    let remote = git(root, &["config", "--get", "remote.origin.url"]).ok()?;
    if let Ok(mut url) = Url::parse(&remote)
        && matches!(url.scheme(), "https" | "http" | "ssh" | "git")
        && url.host_str().is_some()
    {
        url.set_username("").ok()?;
        url.set_password(None).ok()?;
        url.set_query(None);
        url.set_fragment(None);
        return Some(url.into());
    }
    let (_, endpoint) = remote.split_once('@')?;
    if endpoint
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b"-._/:".contains(&c))
        && let Some((host, path)) = endpoint.split_once(':')
        && !host.is_empty()
        && !path.is_empty()
    {
        return Some(format!("ssh://{host}/{}", path.trim_start_matches('/')));
    }
    None
}

fn status(root: &Path) -> Result<String> {
    git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ],
    )
}

fn safe_path(root: &Path, path: &str) -> Option<std::path::PathBuf> {
    let mut current = root.to_owned();
    for part in path.split('/') {
        if matches!(part, "" | "." | ".." | ".git") || part.contains('\\') {
            return None;
        }
        current.push(part);
        if fs::symlink_metadata(&current).ok()?.is_symlink() {
            return None;
        }
    }
    Some(current)
}

fn submodules(root: &Path, prefix: &str, depth: usize, out: &mut Vec<Value>) -> Result<()> {
    let staged = git(root, &["ls-files", "--stage", "-z"])?;
    let mut links = BTreeMap::new();
    for entry in staged
        .split('\0')
        .filter(|entry| entry.starts_with("160000 "))
    {
        let (metadata, path) = entry.split_once('\t').ok_or("Invalid Git link")?;
        let hash = metadata
            .split_whitespace()
            .nth(1)
            .filter(|hash| commit_hash(hash))
            .ok_or("Invalid Git link commit")?;
        let conflicted = !metadata.ends_with(" 0") || links.contains_key(path);
        links.insert(path, (hash, conflicted));
    }
    for (path, (expected, conflicted)) in links {
        if depth > 8 || out.len() >= 256 {
            return Err("Submodule limit exceeded".into());
        }
        let path_name = format!("{prefix}{path}");
        let local =
            safe_path(root, path).filter(|dir| repository_root(dir).is_ok_and(|top| top == *dir));
        let commit = local.as_deref().and_then(commit);
        let dirty = local
            .as_deref()
            .and_then(|dir| status(dir).ok())
            .map(|v| !v.is_empty());
        out.push(
            json!({"path":path_name,"expectedCommit":expected,"initialized":local.is_some(),
            "commit":commit,"dirty":dirty,"repository":local.as_deref().and_then(repository),
            "verified":!conflicted && commit.is_some() && dirty.is_some()}),
        );
        if let Some(directory) = local {
            submodules(&directory, &format!("{path_name}/"), depth + 1, out)?;
        }
    }
    Ok(())
}

fn state(root: &Path) -> Value {
    let commit = commit(root);
    let branch = git(root, &["symbolic-ref", "--short", "HEAD"]).ok();
    let status = status(root).ok();
    let mut modules = Vec::new();
    let scanned = submodules(root, "", 1, &mut modules).is_ok();
    let valid_head = commit.is_some()
        || git(root, &["rev-list", "--all", "--max-count=1"]).is_ok_and(|value| value.is_empty());
    let remote_known = commit.as_ref().and_then(|commit| {
        git(
            root,
            &[
                "for-each-ref",
                "--contains",
                commit,
                "--format=%(refname)",
                "refs/remotes",
            ],
        )
        .ok()
        .map(|refs| {
            refs.lines()
                .any(|line| !line.is_empty() && !line.ends_with("/HEAD"))
        })
    });
    let mut state = json!({"commit":commit,"branch":branch,"repository":repository(root),
        "dirty":status.as_ref().map(|status| !status.is_empty()),
        "worktreeHash":status.as_ref().map(|status| digest(json!([status,&modules]).to_string())),
        "remoteKnown":remote_known,"verified":scanned && status.is_some() && valid_head});
    if !modules.is_empty() && scanned {
        state["submodules"] = json!(modules);
    }
    state
}

fn file_hash(root: &Path, path: &str) -> Option<String> {
    let path = safe_path(root, path)?;
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > 1_000_000 {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut data = Vec::new();
    file.take(1_000_001).read_to_end(&mut data).ok()?;
    (data.len() <= 1_000_000 && !data.contains(&0)).then(|| digest(&data))
}

pub fn checkpoint(root: &Path, files: &Value) -> (Value, Value) {
    let paths: Vec<&str> = files
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let hashes = || {
        paths
            .iter()
            .map(|path| file_hash(root, path))
            .collect::<Vec<_>>()
    };
    let mut latest = Value::Null;
    for _ in 0..3 {
        let before = state(root);
        let first_hashes = hashes();
        latest = state(root);
        if before != latest || latest["verified"] != true || hashes() != first_hashes {
            continue;
        }
        let references = paths
            .iter()
            .zip(first_hashes)
            .map(|(path, hash)| {
                let mut detail = latest.clone();
                let modules = detail
                    .as_object_mut()
                    .expect("state is an object")
                    .remove("submodules");
                let relevant: Vec<_> = modules
                    .as_ref()
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|module| {
                        module["path"].as_str().is_some_and(|prefix| {
                            path.strip_prefix(prefix)
                                .is_some_and(|suffix| suffix.starts_with('/'))
                        })
                    })
                    .collect();
                if !relevant.is_empty() {
                    detail["submodules"] = json!(relevant);
                }
                detail["path"] = json!(path);
                if let Some(hash) = hash {
                    detail["contentHash"] = json!(hash);
                }
                detail
            })
            .collect::<Vec<_>>();
        return (latest, json!(references));
    }
    latest["verified"] = json!(false);
    latest["verificationError"] = json!("Git state changed during capture or could not be read");
    (
        latest,
        json!(
            paths
                .iter()
                .map(|path| json!({"path":path,"verified":false}))
                .collect::<Vec<_>>()
        ),
    )
}

pub fn reconcile(root: &Path, value: &mut Value) {
    let current = state(root);
    for key in ["tasks", "notes", "results", "relatedConversations"] {
        if let Some(records) = value.get_mut(key).and_then(Value::as_array_mut) {
            for record in records {
                reconcile_record(root, &current, record);
            }
        }
    }
    reconcile_record(root, &current, value);
}

fn reconcile_record(root: &Path, current: &Value, value: &mut Value) {
    if !matches!(
        value["kind"].as_str(),
        Some("task" | "finding" | "decision" | "blocker" | "handoff")
    ) {
        return;
    }
    let reference = &value["git"];
    let files: Vec<_> = value["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| {
            let path = file["path"].as_str()?;
            let status = match (file["contentHash"].as_str(), file_hash(root, path)) {
                (Some(expected), Some(actual)) if expected == actual => "matching",
                (Some(_), Some(_)) => "different",
                (Some(_), None) => "unavailable",
                (None, _) => "unverified",
            };
            Some(json!({"path":path,"state":status}))
        })
        .collect();
    let expected_repo = reference["repository"].as_str().and_then(repository_key);
    let current_repo = current["repository"].as_str().and_then(repository_key);
    let available = reference["commit"]
        .as_str()
        .filter(|value| commit_hash(value))
        .map(|commit| git(root, &["cat-file", "-e", &format!("{commit}^{{commit}}")]).is_ok());
    let expected_submodules = &reference["submodules"];
    let active_submodules = &current["submodules"];
    let missing_submodule = expected_submodules
        .as_array()
        .into_iter()
        .flatten()
        .any(|entry| {
            active_submodules
                .as_array()
                .into_iter()
                .flatten()
                .all(|current| current["path"] != entry["path"] || current["initialized"] != true)
        });
    let equal_submodule = expected_submodules == active_submodules;
    let (status, message) = if reference["verified"] != true || current["verified"] != true {
        (
            "unverified",
            "Verify the reference against the current checkout.",
        )
    } else if expected_repo.is_some() && current_repo.is_some() && expected_repo != current_repo {
        (
            "repository_mismatch",
            "The record references a different Git repository.",
        )
    } else if missing_submodule || available == Some(false) {
        (
            "commit_unavailable",
            "A referenced commit or checkout is unavailable locally.",
        )
    } else if reference["dirty"] == true {
        (
            "uncommitted_evidence",
            "The saved evidence includes uncommitted changes.",
        )
    } else if available.is_none()
        || (expected_repo.is_some() && current_repo.is_none())
        || (!active_submodules.is_null() && expected_submodules.is_null())
        || files
            .iter()
            .any(|item| matches!(item["state"].as_str(), Some("unavailable" | "unverified")))
    {
        (
            "unverified",
            "Some referenced Git evidence could not be verified.",
        )
    } else if current["commit"] != reference["commit"]
        || current["dirty"] != false
        || !equal_submodule
        || files.iter().any(|item| item["state"] == "different")
    {
        (
            "different_revision",
            "The checkout differs from the saved Git evidence.",
        )
    } else {
        (
            "matching",
            "The referenced commit and files match this checkout. Verify the claim itself.",
        )
    };
    value["reconciliation"] = json!({"status":status,"message":message,"files":files,
        "referenceCommit":reference["commit"],"currentCommit":current["commit"],"commitAvailable":available});
}
