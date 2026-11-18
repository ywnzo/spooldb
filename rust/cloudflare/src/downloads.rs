use futures_util::{StreamExt, stream};
use serde::Deserialize;
use serde_json::Value;
use std::collections::VecDeque;
use worker::worker_sys::FixedLengthStream as FixedLengthStreamSys;
use worker::{
    ByteStream, Env, Error, Fetcher, FixedLengthStream, Headers, Method, Request, RequestInit,
    Response, Result,
};

const SCRIPT: &str = include_str!("../assets/install.sh");
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

fn failure(reason: &str) -> Error {
    Error::RustError(reason.to_owned())
}
fn headers(mime: &str) -> Result<Headers> {
    let headers = Headers::new();
    for (name, value) in [
        ("content-type", mime),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        ("cache-control", "no-store"),
        ("content-security-policy", CSP),
    ] {
        headers.set(name, value)?;
    }
    Ok(headers)
}
fn reply(method: &Method, text: &str, mime: &str, status: u16) -> Result<Response> {
    let mut result = if *method == Method::Head {
        Response::empty()?
    } else {
        Response::ok(text)?
    };
    result = result.with_headers(headers(mime)?).with_status(status);
    Ok(result)
}

#[derive(Deserialize)]
struct Part {
    path: String,
    size: u64,
}
#[derive(Deserialize)]
struct Artifact {
    name: String,
    sha256: String,
    size: u64,
    parts: Vec<Part>,
}

struct Range {
    from: u64,
    to: u64,
    partial: bool,
}
fn byte_range(value: Option<&str>, size: u64) -> Option<Range> {
    if size == 0 {
        return None;
    }
    let Some(value) = value else {
        return Some(Range {
            from: 0,
            to: size - 1,
            partial: false,
        });
    };
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let parse = |value: &str| {
        (!value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()))
            .then(|| value.parse::<u64>().ok())
            .flatten()
    };
    let (from, to) = if start.is_empty() {
        let length = parse(end)?;
        (size.saturating_sub(length), size - 1)
    } else {
        (
            parse(start)?,
            if end.is_empty() {
                size - 1
            } else {
                parse(end)?.min(size - 1)
            },
        )
    };
    (from <= to && to < size).then_some(Range {
        from,
        to,
        partial: true,
    })
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn permitted(name: &str) -> bool {
    matches!(
        name,
        "spool-linux-x64.run"
            | "spool-linux-x64-node.run"
            | "spooldb-codex.tar.gz"
            | "spooldb-codex-linux-x64.tar.gz"
    )
}

fn artifact(manifest: &Value, requested: Option<&str>, name: &str) -> Option<Artifact> {
    if !permitted(name) {
        return None;
    }
    let sha = requested
        .or_else(|| manifest["current"][name].as_str())
        .filter(|value| hash(value))?;
    let selected: Artifact =
        serde_json::from_value(manifest["releases"][format!("{sha}/{name}")].clone()).ok()?;
    if selected.sha256 != sha
        || selected.name != name
        || selected.size == 0
        || selected.parts.is_empty()
    {
        return None;
    }
    let mut total = 0_u64;
    for (index, part) in selected.parts.iter().enumerate() {
        if part.path != format!("packages/{sha}/part-{index:03}.bin") || part.size == 0 {
            return None;
        }
        total = total.checked_add(part.size)?;
    }
    (total == selected.size).then_some(selected)
}

pub async fn run(request: &Request, env: &Env) -> Result<Option<Response>> {
    let path = request.path();
    if !matches!(
        path.as_str(),
        "/" | "/join"
            | "/onboarding.css"
            | "/onboarding.js"
            | "/onboarding-bootstrap.js"
            | "/install.sh"
    ) && !path.starts_with("/downloads/")
    {
        return Ok(None);
    }
    let method = request.method();
    if !matches!(method, Method::Get | Method::Head) {
        let mut result = reply(&method, "Use GET or HEAD", "text/plain", 405)?;
        result.headers_mut().set("allow", "GET, HEAD")?;
        return Ok(Some(result));
    }
    let static_page = match path.as_str() {
        "/" | "/join" => Some((
            include_str!("../assets/onboarding.html"),
            "text/html; charset=utf-8",
        )),
        "/onboarding.css" => Some((
            include_str!("../assets/onboarding.css"),
            "text/css; charset=utf-8",
        )),
        "/onboarding.js" => Some((
            concat!(
                "import {bootstrapScript} from '/onboarding-bootstrap.js';\n",
                include_str!("../../../src/cloudflare/public/onboarding.js"),
                "\nonboardingClient(bootstrapScript);\n"
            ),
            "text/javascript; charset=utf-8",
        )),
        "/onboarding-bootstrap.js" => Some((
            include_str!("../../../src/cloudflare/bootstrap.js"),
            "text/javascript; charset=utf-8",
        )),
        _ => None,
    };
    if let Some((content, mime)) = static_page {
        return reply(&method, content, mime, 200).map(Some);
    }
    let unavailable = || {
        reply(
            &method,
            "Installer downloads have not been published on this relay.",
            "text/plain",
            503,
        )
        .map(Some)
    };
    let Ok(assets) = env.service("DOWNLOADS") else {
        return unavailable();
    };
    let mut index = assets
        .fetch_request(Request::new(
            "https://assets.internal/manifest.json",
            Method::Get,
        )?)
        .await?;
    if index.status_code() != 200 {
        return unavailable();
    }
    let index: Value = index.json().await?;
    if path == "/downloads/manifest.json" {
        return reply(&method, &index.to_string(), "application/json", 200).map(Some);
    }
    if path == "/install.sh" {
        let Some(artifact) = artifact(&index, None, "spool-linux-x64.run") else {
            return unavailable();
        };
        let url = request.url()?;
        if url.scheme() != "https"
            && (url.scheme() != "http"
                || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
        {
            return reply(&method, "Invalid download origin", "text/plain", 400).map(Some);
        }
        let origin = url.origin().ascii_serialization();
        let url = format!("{origin}/downloads/{}/{}", artifact.sha256, artifact.name);
        let quoted = format!("'{}'", url.replace('\'', "'\\''"));
        let script = SCRIPT
            .replace("@DOWNLOAD_URL@", &quoted)
            .replace("@SHA256@", &artifact.sha256);
        return reply(&method, &script, "text/x-shellscript; charset=utf-8", 200).map(Some);
    }
    let segment = path.strip_prefix("/downloads/").unwrap_or_default();
    let (pinned, name) = segment
        .split_once('/')
        .map_or((None, segment), |(sha, name)| (Some(sha), name));
    let Some(artifact) = artifact(&index, pinned, name) else {
        return reply(&method, "Download not found", "text/plain", 404).map(Some);
    };
    download(request, method, assets, artifact, pinned.is_some())
        .await
        .map(Some)
}

struct Segment {
    path: String,
    from: u64,
    to: u64,
}
struct Download {
    assets: Fetcher,
    segments: VecDeque<Segment>,
    stream: Option<ByteStream>,
    skip: u64,
    remaining: u64,
}

async fn chunk(mut download: Download) -> Result<Option<(Vec<u8>, Download)>> {
    loop {
        if download.stream.is_none() {
            let Some(segment) = download.segments.pop_front() else {
                return Ok(None);
            };
            let headers = Headers::new();
            headers.set("range", &format!("bytes={}-{}", segment.from, segment.to))?;
            let request = Request::new_with_init(
                &format!("https://assets.internal/{}", segment.path),
                RequestInit::new()
                    .with_method(Method::Get)
                    .with_headers(headers),
            )?;
            let mut response = download.assets.fetch_request(request).await?;
            let status = response.status_code();
            if !matches!(status, 200 | 206) {
                return Err(failure("Installer part unavailable"));
            }
            download.skip = if status == 206 { 0 } else { segment.from };
            download.remaining = segment.to - segment.from + 1;
            download.stream = Some(response.stream()?);
        }
        let stream = download
            .stream
            .as_mut()
            .ok_or_else(|| failure("Missing installer stream"))?;
        let Some(data) = stream.next().await else {
            return Err(failure("Truncated installer part"));
        };
        let bytes = data?;
        let skipped = download.skip.min(bytes.len() as u64) as usize;
        download.skip -= skipped as u64;
        let available = (bytes.len() - skipped) as u64;
        let count = available.min(download.remaining) as usize;
        if count == 0 {
            continue;
        }
        download.remaining -= count as u64;
        if download.remaining == 0 {
            download.stream = None;
        }
        return Ok(Some((bytes[skipped..skipped + count].to_vec(), download)));
    }
}

async fn download(
    req: &Request,
    method: Method,
    assets: Fetcher,
    artifact: Artifact,
    pinned: bool,
) -> Result<Response> {
    let etag = format!("\"{}\"", artifact.sha256);
    let metadata = headers("application/octet-stream")?;
    metadata.set("etag", &etag)?;
    metadata.set(
        "cache-control",
        if pinned {
            "public, max-age=31536000, immutable"
        } else {
            "public, max-age=60"
        },
    )?;
    let range = req.headers().get("range")?;
    if req.headers().get("if-none-match")?.as_deref() == Some(&etag) && range.is_none() {
        return Ok(Response::empty()?.with_headers(metadata).with_status(304));
    }
    let range = if req
        .headers()
        .get("if-range")?
        .is_some_and(|value| value != etag)
    {
        None
    } else {
        range
    };
    let Some(range) = byte_range(range.as_deref(), artifact.size) else {
        metadata.set("content-range", &format!("bytes */{}", artifact.size))?;
        return Ok(Response::empty()?.with_headers(metadata).with_status(416));
    };
    let length = range.to - range.from + 1;
    metadata.set("content-length", &length.to_string())?;
    metadata.set("accept-ranges", "bytes")?;
    metadata.set(
        "content-disposition",
        &format!("attachment; filename=\"{}\"", artifact.name),
    )?;
    if range.partial {
        metadata.set(
            "content-range",
            &format!("bytes {}-{}/{}", range.from, range.to, artifact.size),
        )?;
    }
    let status = if range.partial { 206 } else { 200 };
    if method == Method::Head {
        return Ok(Response::empty()?
            .with_headers(metadata)
            .with_status(status));
    }
    let mut offset = 0;
    let mut segments = VecDeque::new();
    for part in artifact.parts {
        let a = range.from.max(offset);
        let b = range.to.min(offset + part.size - 1);
        if a <= b {
            segments.push_back(Segment {
                path: part.path,
                from: a - offset,
                to: b - offset,
            });
        }
        offset += part.size;
    }
    let stream = stream::try_unfold(
        Download {
            assets,
            segments,
            stream: None,
            skip: 0,
            remaining: 0,
        },
        chunk,
    );
    let fixed: FixedLengthStreamSys = FixedLengthStream::wrap(stream, length).into();
    Ok(Response::builder()
        .with_headers(metadata)
        .with_status(status)
        .stream(fixed.readable()))
}
