use crate::Result;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    time::Duration,
};
use url::Url;

const REPOSITORY: &str = "https://github.com/ywnzo/spooldb";
const INSTALLER: &str = "spool-linux-x64.run";

pub fn version(value: &str) -> Result<[u64; 3]> {
    let mut numbers = [0; 3];
    let mut parts = value.strip_prefix('v').unwrap_or(value).split('.');
    let invalid = || "Expected a stable release version";
    for number in &mut numbers {
        let part = parts.next().ok_or_else(invalid)?;
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(invalid().into());
        }
        *number = part.parse::<u64>().map_err(|_| invalid())?;
    }
    if parts.next().is_some() {
        return Err(invalid().into());
    }
    Ok(numbers)
}

fn response(url: &str, timeout: u64) -> Result<ureq::http::Response<ureq::Body>> {
    let client: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .max_redirects_will_error(false)
        .timeout_global(Some(Duration::from_secs(timeout)))
        .build()
        .into();
    let mut url = Url::parse(url)?;
    for _ in 0..4 {
        if url.scheme() != "https"
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || !matches!(
                url.host_str(),
                Some(
                    "github.com"
                        | "api.github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            )
        {
            return Err("Update downloads must come from GitHub over HTTPS".into());
        }
        let response = client
            .get(url.as_str())
            .header("User-Agent", "SpoolDB")
            .header(
                "Accept",
                if url.host_str() == Some("api.github.com") {
                    "application/vnd.github+json"
                } else {
                    "*/*"
                },
            )
            .call()
            .map_err(|error| {
                if let ureq::Error::StatusCode(status) = error {
                    format!("Update request failed: HTTP {status}")
                } else {
                    "Update request to GitHub failed".to_owned()
                }
            })?;
        if response.status().is_success() {
            return Ok(response);
        }
        if !response.status().is_redirection() {
            return Err(format!("Update request failed: HTTP {}", response.status()).into());
        }
        let location = response
            .headers()
            .get("location")
            .ok_or("Missing update redirect")?;
        url = url.join(location.to_str()?)?;
    }
    Err("Too many update redirects".into())
}

fn bounded(mut reader: impl Read, mut output: impl Write, maximum: usize) -> Result<String> {
    let mut hash = Sha256::new();
    let mut remaining = maximum;
    let mut buffer = [0; 16_384];
    loop {
        let size = reader.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        remaining = remaining
            .checked_sub(size)
            .ok_or("Update download exceeds size limit")?;
        output.write_all(&buffer[..size])?;
        hash.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn check(current: &str) -> Result<Value> {
    let mut body = Vec::new();
    bounded(
        response(
            "https://api.github.com/repos/ywnzo/spooldb/releases/latest",
            30,
        )?
        .into_body()
        .into_reader(),
        &mut body,
        2_000_000,
    )?;
    let release: Value = serde_json::from_slice(&body)?;
    let tag = release["tag_name"].as_str().ok_or("Missing release tag")?;
    let latest = tag.strip_prefix('v').unwrap_or(tag);
    let available = version(latest)? > version(current)?;
    if release["draft"] != false || release["prerelease"] != false {
        return Err("Expected a published stable release".into());
    }
    Ok(
        json!({"current":current,"latest":latest,"available":available,
        "release":{"version":latest,"url":format!("{REPOSITORY}/releases/tag/{tag}"),
            "assets":release["assets"]}}),
    )
}

fn asset(release: &Value, name: &str) -> Result<String> {
    let latest = release["version"]
        .as_str()
        .ok_or("Missing release version")?;
    version(latest)?;
    let expected = format!("{REPOSITORY}/releases/download/v{latest}/{name}");
    let count = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["name"] == name && item["browser_download_url"] == expected)
        .count();
    if count != 1 {
        return Err(format!("Official update asset missing or ambiguous: {name}").into());
    }
    Ok(expected)
}

fn checksum(text: &str) -> Result<&str> {
    let mut found = None;
    for line in text.lines() {
        let mut fields = line.split_ascii_whitespace();
        if let Some(hash) = fields.next()
            && fields.next() == Some(INSTALLER)
        {
            if found.is_some()
                || fields.next().is_some()
                || hash.len() != 64
                || !hash
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            {
                return Err("Official installer checksum is invalid".into());
            }
            found = Some(hash);
        }
    }
    found.ok_or_else(|| "Official installer checksum missing".into())
}

pub fn installer(release: &Value, output: impl Write) -> Result<()> {
    let mut sums = Vec::new();
    bounded(
        response(&asset(release, "SHA256SUMS")?, 120)?
            .into_body()
            .into_reader(),
        &mut sums,
        100_000,
    )?;
    let expected = checksum(std::str::from_utf8(&sums)?)?;
    let actual = bounded(
        response(&asset(release, INSTALLER)?, 120)?
            .into_body()
            .into_reader(),
        output,
        200_000_000,
    )?;
    if actual != expected {
        return Err("Update checksum mismatch. No installer was run.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_stable_numeric_and_downloads_have_one_official_asset() {
        assert!(version("v0.20.0").unwrap() > version("0.9.99").unwrap());
        for invalid in ["v0.02.0", "1.0", "1.2.3-alpha", "1.2.+3", "1.2.3.4"] {
            assert!(version(invalid).is_err(), "{invalid}");
        }
        let official = format!("{REPOSITORY}/releases/download/v1.2.3/{INSTALLER}");
        assert_eq!(
            asset(
                &json!({"version":"1.2.3","assets":[
                    {"name":INSTALLER,"browser_download_url":official}
                ]}),
                INSTALLER
            )
            .unwrap(),
            official
        );
        assert!(
            asset(
                &json!({"version":"1.2.3","assets":[
                    {"name":INSTALLER,"browser_download_url":"https://example.test/other"}
                ]}),
                INSTALLER
            )
            .is_err()
        );
    }

    #[test]
    fn checksum_and_size_limits_are_enforced() {
        let digest = bounded(&b"hello"[..], std::io::sink(), 5).unwrap();
        assert!(bounded(&b"hello"[..], std::io::sink(), 4).is_err());
        let line = format!("{digest}  {INSTALLER}");
        assert_eq!(checksum(&line).unwrap(), digest);
        assert!(checksum(&format!("{line}\n{line}")).is_err());
    }
}
