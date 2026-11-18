use crate::{
    Result, private_files,
    relay_retention::{metadata, regular_json, uuid},
    release_download,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::SystemTime,
};

const IMAGE_PREFIX: &str = "localhost/spooldb-relay:";
const RELEASE_MARKER: &str = ".spool-relay-release.json";

fn release_version(name: &str) -> Option<&str> {
    let (version, suffix) = name.split_once('-')?;
    (!version.starts_with('v') && release_download::version(version).is_ok() && uuid(suffix))
        .then_some(version)
}

fn image_version(tag: &str) -> Option<&str> {
    release_version(tag.strip_prefix(IMAGE_PREFIX)?)
}

#[derive(Default)]
struct Protected {
    apps: BTreeSet<PathBuf>,
    tags: BTreeSet<String>,
    ids: BTreeSet<String>,
}

impl Protected {
    fn reference(&mut self, entry: &Value, releases: &Path, engine: &str) -> Result<()> {
        let app = PathBuf::from(entry["app"].as_str().ok_or("Missing release path")?);
        let image = entry["image"].as_str().ok_or("Missing relay image")?;
        if app.parent() != Some(releases)
            || app
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(release_version)
                .is_none()
            || image_version(image).is_none()
            || entry["engine"] != engine
        {
            return Err("Invalid release or image reference. Cleanup refused.".into());
        }
        if !metadata(&app)?.is_some_and(|entry| entry.is_dir()) {
            return Err("Protected release is missing or symlinked. Cleanup refused.".into());
        }
        self.apps.insert(app);
        self.tags.insert(image.to_owned());
        Ok(())
    }

    fn include_tagged_ids(&mut self, images: &[Value]) {
        for image in images {
            if tags(image).any(|tag| self.tags.contains(tag)) {
                self.ids.insert(image_id(image).to_owned());
            }
        }
    }
}

fn command(engine: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(engine).args(args).output()?;
    if !output.status.success() {
        return Err(format!(
            "Container engine {} {} failed: {}",
            args[0],
            args[1],
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    if output.stdout.len() > 16 * 1024 * 1024 {
        return Err("Container engine inventory exceeds the size limit".into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn inspect(
    run: &impl Fn(&[&str]) -> Result<String>,
    kind: &str,
    list: &[&str],
) -> Result<Vec<Value>> {
    let inventory = run(list)?;
    let ids = inventory.split_ascii_whitespace().collect::<BTreeSet<_>>();
    if ids.iter().any(|id| {
        !id.strip_prefix("sha256:")
            .unwrap_or(id)
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("Invalid container engine inventory identifier".into());
    }
    let ids = ids.into_iter().collect::<Vec<_>>();
    let mut objects = Vec::new();
    for batch in ids.chunks(50) {
        let mut args = vec![kind, "inspect"];
        args.extend_from_slice(batch);
        let responses = serde_json::from_str::<Vec<Value>>(&run(&args)?)?;
        if responses.len() != batch.len() {
            return Err("Incomplete container engine inventory. Cleanup refused.".into());
        }
        objects.extend(responses);
    }
    Ok(objects)
}

fn clean_id(value: &str) -> &str {
    value.strip_prefix("sha256:").unwrap_or(value)
}
fn image_id(image: &Value) -> &str {
    clean_id(
        image["Id"]
            .as_str()
            .or_else(|| image["ID"].as_str())
            .unwrap_or(""),
    )
}
fn tags(image: &Value) -> impl Iterator<Item = &str> {
    image["RepoTags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}
fn label<'a>(image: &'a Value, name: &str) -> Option<&'a str> {
    image["Config"]["Labels"][name].as_str()
}
fn release_label(image: &Value) -> Option<&str> {
    label(image, "dev.spooldb.release").filter(|name| release_version(name).is_some())
}

struct Candidate {
    name: String,
    created: DateTime<Utc>,
    image: Option<String>,
}

fn created(value: &Value, now: DateTime<Utc>) -> Result<DateTime<Utc>> {
    let time = DateTime::parse_from_rfc3339(value.as_str().ok_or("Missing creation date")?)?
        .with_timezone(&Utc);
    if time > now {
        return Err("Invalid managed artifact creation date".into());
    }
    Ok(time)
}

fn associated_backups(
    root: &Path,
    releases: &Path,
    engine: &str,
    backup_plan: &Value,
    protected: &mut Protected,
) -> Result<()> {
    let base = root.join("relay-backups");
    let mut references = BTreeMap::new();
    for file in [
        "last-relay-update.json",
        "relay-update-journal.json",
        "last-relay-install.json",
        "relay-control-runtime.json",
    ] {
        let Some(record) = regular_json(&root.join(file))? else {
            continue;
        };
        let previous = if file == "relay-update-journal.json" {
            &record["old"]
        } else {
            &record["previous"]
        };
        protected.reference(previous, releases, engine)?;
        if !record["config"].is_null() {
            protected.reference(&record["config"], releases, engine)?;
        }
        if let Some(backup) = record.get("backup").filter(|entry| !entry.is_null()) {
            let path = PathBuf::from(backup.as_str().ok_or("Invalid backup reference")?);
            if path.parent() != Some(base.as_path()) {
                return Err("Invalid backup reference".into());
            }
            references.insert(path, previous.clone());
        }
    }
    let Some(folder) = metadata(&base)? else {
        return Ok(());
    };
    if !folder.is_dir() {
        return Err("Backup storage must be a real directory".into());
    }
    let removed = backup_plan["removed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    for entry in fs::read_dir(&base)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir()
            || entry
                .file_name()
                .to_str()
                .is_some_and(|name| removed.contains(name))
        {
            continue;
        }
        let path = entry.path();
        let marker = regular_json(&path.join("backup.json"))?;
        let meta = marker.as_ref().filter(|value| {
            value["managedBy"] == "SpoolDB" && value["kind"] == "relay-update-backup"
        });
        if meta.is_some()
            || metadata(&path.join("owners.json"))?.is_some_and(|entry| entry.is_file())
        {
            let prior = meta
                .and_then(|value| value.get("previous"))
                .or_else(|| references.get(&path))
                .ok_or_else(|| {
                    format!(
                        "Retained backup {} has no recorded release association",
                        path.display()
                    )
                })?;
            protected.reference(prior, releases, engine)?;
        }
    }
    Ok(())
}

struct Plan<'a> {
    config: &'a Value,
    root: &'a Path,
    cli: &'a Path,
    current: &'a Path,
    backup_plan: &'a Value,
    policy: &'a Value,
    dry_run: bool,
    now: DateTime<Utc>,
}

fn prune(plan: Plan<'_>, run: impl Fn(&[&str]) -> Result<String>) -> Result<Value> {
    let Plan {
        config,
        root,
        cli,
        current,
        backup_plan,
        policy,
        dry_run,
        now,
    } = plan;
    let engine = config["engine"]
        .as_str()
        .ok_or("Missing container engine")?;
    if config["managedBy"] != "SpoolDB" || !matches!(engine, "/usr/bin/docker" | "/usr/bin/podman")
    {
        return Err("Artifact cleanup requires a managed container installation".into());
    }
    if backup_plan["errors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err("Backup cleanup has unresolved errors. Artifact cleanup refused.".into());
    }
    let setting = |name: &str, default, limit| {
        policy
            .get(name)
            .map_or(Some(default), Value::as_u64)
            .filter(|value| (1..=limit).contains(value))
            .ok_or("Artifact retention requires keep=1–100 and maxAgeDays=1–3650")
    };
    let keep = setting("keep", 3, 100)? as usize;
    let max_age = setting("maxAgeDays", 30, 3650)? as i64;
    let recent = |index, date| index < keep && now - date <= chrono::Duration::days(max_age);

    let base = root.join("releases");
    if !metadata(&base)?.is_some_and(|folder| folder.is_dir()) {
        return Err("Release storage must be a real directory".into());
    }
    let mut protected = Protected::default();
    protected.reference(config, &base, engine)?;
    associated_backups(root, &base, engine, backup_plan, &mut protected)?;
    let required_tags = protected.tags.clone();
    let containers = inspect(&run, "container", &["container", "ls", "--all", "--quiet"])?;
    let images = inspect(&run, "image", &["image", "ls", "--quiet", "--no-trunc"])?;
    if containers
        .iter()
        .any(|c| c["Image"].as_str().is_none_or(str::is_empty))
        || images.iter().any(|image| {
            image_id(image).is_empty()
                || !image["RepoTags"].is_null()
                    && image["RepoTags"]
                        .as_array()
                        .is_none_or(|tags| tags.iter().any(|tag| !tag.is_string()))
        })
    {
        return Err("Incomplete engine inventory. Cleanup refused.".into());
    }
    for tag in &required_tags {
        if !images
            .iter()
            .any(|image| tags(image).any(|item| item == tag))
        {
            return Err("A protected relay image is missing from the engine inventory".into());
        }
    }
    let mut mounts = Vec::new();
    for container in &containers {
        protected
            .ids
            .insert(clean_id(container["Image"].as_str().expect("validated image")).to_owned());
        for tag in [&container["Config"]["Image"], &container["ImageName"]]
            .into_iter()
            .filter_map(Value::as_str)
        {
            protected.tags.insert(tag.to_owned());
        }
        for mount in container["Mounts"].as_array().into_iter().flatten() {
            if let Some(source) = mount["Source"].as_str() {
                mounts.push(PathBuf::from(source));
            }
        }
    }
    let legacy_container = images.iter().any(|image| {
        protected.ids.contains(image_id(image))
            && release_label(image).is_none()
            && tags(image).any(|tag| image_version(tag).is_some())
    });
    protected.include_tagged_ids(&images);
    for image in &images {
        if protected.ids.contains(image_id(image))
            && let Some(release) = release_label(image)
        {
            protected.apps.insert(base.join(release));
        }
    }
    let cli_text = if metadata(cli)?.is_some_and(|entry| entry.is_file()) {
        fs::read_to_string(cli)?
    } else {
        String::new()
    };
    let mut skipped = Vec::new();
    let mut releases = Vec::new();
    let mut entries = fs::read_dir(&base)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(version) =
            release_version(&name).filter(|_| entry.file_type().is_ok_and(|entry| entry.is_dir()))
        else {
            skipped.push(name);
            continue;
        };
        let app = entry.path();
        let (created_at, image) = if let Some(meta) = regular_json(&app.join(RELEASE_MARKER))? {
            let image = meta["image"].as_str().ok_or("Missing release image")?;
            if meta["managedBy"] != "SpoolDB"
                || meta["kind"] != "relay-release"
                || meta["id"] != name
                || meta["version"] != version
                || image_version(image) != Some(version)
            {
                return Err(format!("Invalid managed release metadata: {name}").into());
            }
            if protected.tags.contains(image)
                || images.iter().any(|item| {
                    tags(item).any(|tag| tag == image) && protected.ids.contains(image_id(item))
                })
            {
                protected.apps.insert(app.clone());
            }
            (created(&meta["createdAt"], now)?, Some(image.to_owned()))
        } else {
            let manifest = regular_json(&app.join("manifest.json"))?;
            let package = regular_json(&app.join("package.json"))?;
            if !manifest.is_some_and(|value| value["version"] == version)
                || !package.is_some_and(|value| value["version"] == version)
                || !metadata(&app.join("Containerfile"))?.is_some_and(|entry| entry.is_file())
                || !metadata(&app.join("runtime/bun"))?.is_some_and(|entry| entry.is_file())
            {
                skipped.push(name);
                continue;
            }
            if legacy_container {
                protected.apps.insert(app.clone());
            }
            (DateTime::<Utc>::from(entry.metadata()?.modified()?), None)
        };
        if created_at > now {
            return Err(format!("Invalid managed release date: {name}").into());
        }
        if mounts
            .iter()
            .any(|source| app.starts_with(source) || source.starts_with(&app))
            || current.starts_with(&app)
            || app.to_str().is_some_and(|path| cli_text.contains(path))
        {
            protected.apps.insert(app);
        }
        releases.push(Candidate {
            name,
            created: created_at,
            image,
        });
    }

    let mut candidates = Vec::new();
    for image in &images {
        for tag in tags(image).filter(|tag| image_version(tag).is_some()) {
            if !image["Config"]["Labels"]["dev.spooldb.managed"].is_null()
                && label(image, "dev.spooldb.managed") != Some("true")
            {
                skipped.push(tag.to_owned());
                continue;
            }
            candidates.push((
                tag,
                image_id(image),
                created(&image["Created"], now)?,
                release_label(image),
            ));
        }
    }
    releases.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.name.cmp(&b.name)));
    for (index, release) in releases.iter().enumerate() {
        let app = base.join(&release.name);
        if protected.apps.contains(&app) || recent(index, release.created) {
            protected.apps.insert(app);
            protected.tags.extend(release.image.iter().cloned());
        }
    }
    protected.include_tagged_ids(&images);
    candidates.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(b.0)));
    let mut retained_images = Vec::new();
    let mut removed_images = Vec::new();
    let mut retained_releases = Vec::new();
    let mut removed_releases = Vec::new();
    let mut errors = Vec::new();
    for (index, (tag, id, time, release)) in candidates.into_iter().enumerate() {
        if protected.tags.contains(tag) || protected.ids.contains(id) || recent(index, time) {
            retained_images.push(tag);
            if let Some(release) = release {
                protected.apps.insert(base.join(release));
            }
        } else if !dry_run && let Err(error) = run(&["image", "rm", tag]) {
            for app in &releases {
                if app.image.as_deref() == Some(tag) || Some(app.name.as_str()) == release {
                    protected.apps.insert(base.join(&app.name));
                }
            }
            errors.push(json!({"image":tag,"error":error.to_string()}));
        } else {
            removed_images.push(tag);
        }
    }
    for (index, release) in releases.into_iter().enumerate() {
        let app = base.join(&release.name);
        if protected.apps.contains(&app) || recent(index, release.created) {
            retained_releases.push(release.name);
        } else if !dry_run && let Err(error) = fs::remove_dir_all(app) {
            errors.push(json!({"release":release.name,"error":error.to_string()}));
        } else {
            removed_releases.push(release.name);
        }
    }
    Ok(
        json!({"policy":{"keep":keep,"maxAgeDays":max_age},"dryRun":dry_run,
        "removedImages":removed_images,"removedReleases":removed_releases,
        "retainedImages":retained_images,"retainedReleases":retained_releases,
        "skipped":skipped,"errors":errors}),
    )
}

pub fn maintain(path: &Path, cli: &Path, dry_run: bool, backup_plan: &Value) -> Result<Value> {
    let path = std::path::absolute(path)?;
    let root = path
        .parent()
        .ok_or("Missing relay configuration directory")?;
    let config = regular_json(&path)?.ok_or("Missing relay configuration")?;
    let state_path = root.join("relay-updates.json");
    let mut state = regular_json(&state_path)?.unwrap_or_else(|| json!({}));
    if !state.is_object() {
        return Err("Invalid relay update settings".into());
    }
    let engine = config["engine"].as_str().unwrap_or_default();
    let now = DateTime::<Utc>::from(SystemTime::now());
    let current = std::env::current_exe()?;
    let mut result = prune(
        Plan {
            config: &config,
            root,
            cli,
            current: &current,
            backup_plan,
            policy: &state["artifactRetention"],
            dry_run,
            now,
        },
        |args| command(engine, args),
    )
    .unwrap_or_else(|error| json!({"errors":[{"error":error.to_string()}]}));
    if !dry_run {
        let mut report = result.clone();
        report["checkedAt"] = json!(now.to_rfc3339_opts(SecondsFormat::Millis, true));
        state["artifactCleanup"] = report;
        if let Err(error) = private_files::save_atomic(&state_path, &state) {
            result["errors"]
                .as_array_mut()
                .expect("cleanup has error array")
                .push(json!({"error":format!("Could not record artifact cleanup: {error}")}));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_keeps_rollback_used_and_failed_images_and_their_releases() -> Result<()> {
        let root =
            std::env::temp_dir().join(format!("spool-artifacts-{}", private_files::random_id()?));
        private_files::private_dir(&root)?;
        let result = (|| -> Result<()> {
            let base = root.join("releases");
            private_files::private_dir(&base)?;
            let engine = "/usr/bin/docker";
            let mut images = Vec::new();
            let mut refs = Vec::new();
            for id in 1..=5 {
                let name = format!("1.2.3-00000000-0000-0000-0000-{id:012}");
                let tag = format!("{IMAGE_PREFIX}{name}");
                let app = base.join(&name);
                private_files::private_dir(&app)?;
                private_files::save(
                    &app.join(RELEASE_MARKER),
                    &json!({
                        "managedBy":"SpoolDB","kind":"relay-release","id":name,"version":"1.2.3",
                        "image":tag,"createdAt":"2026-01-01T00:00:00Z"
                    }),
                )?;
                images.push(json!({"Id":format!("sha256:{id:04x}"),"RepoTags":[tag],
                    "Created":"2026-01-01T00:00:00Z","Config":{"Labels":{"dev.spooldb.release":name}}}));
                refs.push(json!({"app":app,"engine":engine,"image":tag,"managedBy":"SpoolDB"}));
            }
            private_files::save(
                &root.join("last-relay-install.json"),
                &json!({"previous":refs[1]}),
            )?;
            let now = DateTime::parse_from_rfc3339("2026-05-01T00:00:00Z")?.with_timezone(&Utc);
            let options = |dry_run| Plan {
                config: &refs[0],
                root: &root,
                cli: Path::new("/missing"),
                current: Path::new("/missing"),
                backup_plan: &Value::Null,
                policy: &Value::Null,
                dry_run,
                now,
            };
            let run = |args: &[&str]| match args {
                ["container", "ls", ..] => Ok("0123".to_owned()),
                ["container", "inspect", ..] => Ok(json!([{"Image":"sha256:0003"}]).to_string()),
                ["image", "ls", ..] => Ok("0001\n0002\n0003\n0004\n0005".to_owned()),
                ["image", "inspect", ..] => Ok(json!(images).to_string()),
                ["image", "rm", tag] if *tag == refs[3]["image"] => Err("Image is in use".into()),
                ["image", "rm", tag] if *tag == refs[4]["image"] => Ok(String::new()),
                _ => panic!("Unexpected engine command {args:?}"),
            };
            let predicted = prune(options(true), run)?;
            assert_eq!(
                predicted["removedImages"],
                json!([refs[3]["image"], refs[4]["image"]])
            );
            let applied = prune(options(false), run)?;
            assert_eq!(applied["removedImages"], json!([refs[4]["image"]]));
            for release in &refs[..4] {
                assert!(Path::new(release["app"].as_str().unwrap()).is_dir());
            }
            assert!(!Path::new(refs[4]["app"].as_str().unwrap()).exists());
            Ok(())
        })();
        fs::remove_dir_all(root)?;
        result
    }
}
