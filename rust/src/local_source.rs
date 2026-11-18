use crate::{Result, project_binding::Binding, project_paths::git};
use rustix::fs::{Mode, OFlags, open, openat};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

pub fn read(binding: &Binding, input: &Value) -> Result<Value> {
    let path = input["path"]
        .as_str()
        .filter(|path| !path.is_empty() && path.len() <= 1000)
        .ok_or("Choose a repository-relative source path")?;
    let offset = input
        .get("offset")
        .map_or(Some(0), Value::as_u64)
        .ok_or("Invalid file page")?;
    let limit = input
        .get("limit")
        .map_or(Some(12000), Value::as_u64)
        .filter(|value| (1..=20000).contains(value))
        .ok_or("Invalid file page")?;
    let components = path.split('/').collect::<Vec<_>>();
    if components.iter().any(|component| {
        matches!(*component, "" | "." | ".." | ".git") || component.chars().any(char::is_control)
    }) || path.contains('\\')
    {
        return Err("Choose a repository-relative source path".into());
    }
    git(
        &binding.root,
        &[
            "--literal-pathspecs",
            "ls-files",
            "--error-unmatch",
            "--",
            path,
        ],
    )
    .map_err(|_| "The file is not tracked in this checkout")?;
    let bytes = read_tracked(&binding.root, &components)?;
    let id = format!("{:x}", Sha256::digest(path));
    let (kind, text, next) = match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => {
            let text = text.encode_utf16().collect::<Vec<_>>();
            let start = offset.min(text.len() as u64) as usize;
            let end = start.saturating_add(limit as usize).min(text.len());
            (
                "text",
                Some(String::from_utf16_lossy(&text[start..end])),
                (end < text.len()).then_some(end),
            )
        }
        _ => ("binary", None, None),
    };
    Ok(
        json!({"path":path,"fileId":id,"kind":kind,"text":text,"nextOffset":next,
        "citation":format!("tw://rooms/{}/files/{id}",binding.local_id)}),
    )
}

fn read_tracked(root: &Path, components: &[&str]) -> Result<Vec<u8>> {
    let directory_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut directory = open(root, directory_flags, Mode::empty())?;
    let (file, parents) = components.split_last().ok_or("Missing file name")?;
    for parent in parents {
        directory = openat(&directory, *parent, directory_flags, Mode::empty())?;
    }
    let descriptor = openat(
        &directory,
        *file,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let file = File::from(descriptor);
    if !file.metadata()?.is_file() {
        return Err("Source path is not a regular file".into());
    }
    let mut body = Vec::new();
    file.take(2_000_001).read_to_end(&mut body)?;
    if body.len() > 2_000_000 {
        return Err("Source file exceeds the local preview limit".into());
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_reader_does_not_follow_a_symlink_in_any_path_component() -> Result<()> {
        let root = std::env::temp_dir().join(format!(
            "spool-local-source-{}",
            crate::private_files::random_id()?
        ));
        crate::private_files::private_dir(&root)?;
        let outcome = (|| -> Result<()> {
            std::fs::create_dir(root.join("inside"))?;
            std::fs::write(root.join("inside/data"), b"tracked text")?;
            std::os::unix::fs::symlink("inside", root.join("directory-link"))?;
            std::os::unix::fs::symlink("inside/data", root.join("file-link"))?;
            assert_eq!(read_tracked(&root, &["inside", "data"])?, b"tracked text");
            assert!(read_tracked(&root, &["directory-link", "data"]).is_err());
            assert!(read_tracked(&root, &["file-link"]).is_err());
            Ok(())
        })();
        std::fs::remove_dir_all(root)?;
        outcome
    }
}
