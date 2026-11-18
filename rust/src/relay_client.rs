use serde::Deserialize;
use serde_json::Value;
use std::{io::Read, thread, time::Duration};
use url::Url;

const MAX_BODY: usize = 16_000_000;

#[derive(Clone, Deserialize)]
pub struct ConnectionOptions {
    pub url: String,
    pub token: String,
    pub room: String,
    pub ca: Option<String>,
}

pub struct Client {
    pub(crate) origin: String,
    token: String,
    pub(crate) room: String,
    http: Http,
}

#[derive(Debug)]
pub struct Fault {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
}

impl Fault {
    fn new(code: &str, message: &str, status: Option<u16>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
            status,
        }
    }

    fn transport() -> Self {
        Self::new("TRANSPORT", "Relay connection failed", None)
    }
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Fault {}

struct Http {
    origin: String,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(options: ConnectionOptions) -> Result<Self, Fault> {
        if !(32..=128).contains(&options.token.len())
            || !options
                .token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(Fault::new("TOKEN", "Invalid bearer token", None));
        }
        if !crate::relay::valid_room(&options.room) {
            return Err(Fault::new("ROOM", "Invalid room", None));
        }
        let http = Http::new(&options.url, options.ca.as_deref(), Duration::from_secs(30))?;
        Ok(Self {
            origin: http.origin.clone(),
            token: options.token,
            room: options.room,
            http,
        })
    }

    pub fn request(&self, action: &str, input: Option<&Value>) -> Result<Value, Fault> {
        if !matches!(
            action,
            "state" | "pull" | "push" | "memory" | "source" | "review"
        ) || (input.is_none() != (action == "state"))
        {
            return Err(Fault::new("ACTION", "Invalid relay action or body", None));
        }
        let data = self.http.request(
            &format!("/v1/rooms/{}/{}", self.room, action),
            &format!("Bearer {}", self.token),
            input,
            MAX_BODY,
            2,
        )?;
        if data["room"] != self.room {
            return Err(Fault::new(
                "ROOM_MISMATCH",
                "Relay response room mismatch",
                None,
            ));
        }
        Ok(data)
    }
}

pub fn workspace_request(
    url: &str,
    ca: Option<&str>,
    token: &str,
    action: &str,
    input: &Value,
) -> Result<Value, Fault> {
    let scheme = match action {
        "action" => "Workspace",
        "enroll" | "preview" => "Invite",
        _ => return Err(Fault::new("ACTION", "Invalid workspace action", None)),
    };
    if !crate::workspace::valid_token(token) {
        return Err(Fault::new("TOKEN", "Invalid workspace credential", None));
    }
    let http = Http::new(url, ca, Duration::from_secs(10))?;
    http.request(
        &format!("/v1/workspace/{action}"),
        &format!("{scheme} {token}"),
        Some(input),
        1_000_000,
        0,
    )
}

pub fn project_invite(
    url: &str,
    ca: Option<&str>,
    code: &str,
    action: &str,
    input: &Value,
) -> Result<Value, Fault> {
    if !matches!(action, "preview" | "redeem") || !crate::workspace::valid_token(code) {
        return Err(Fault::new(
            "INVITE",
            "Invalid project invitation request",
            None,
        ));
    }
    let http = Http::new(url, ca, Duration::from_secs(10))?;
    http.request(
        &format!("/v1/invites/{action}"),
        &format!("Invite {code}"),
        Some(input),
        50_000,
        0,
    )
}

pub fn health(origin: &str) -> Result<Value, Fault> {
    let url = Url::parse(origin).map_err(|_| Fault::new("URL", "Invalid health origin", None))?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]")) {
        return Err(Fault::new(
            "URL",
            "Health probes require loopback HTTP",
            None,
        ));
    }
    local_health(origin, None)
}

pub(crate) fn local_health(origin: &str, ca: Option<&str>) -> Result<Value, Fault> {
    let http = Http::new(origin, ca, Duration::from_secs(3))?;
    http.request("/healthz", "", None, 16_384, 0)
}

impl Http {
    fn new(origin: &str, ca: Option<&str>, timeout: Duration) -> Result<Self, Fault> {
        let url = Url::parse(origin).map_err(|_| Fault::new("URL", "Invalid relay URL", None))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.host_str().is_none()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Fault::new("URL", "Relay URL must be an HTTP origin", None));
        }
        if url.scheme() != "https"
            && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        {
            return Err(Fault::new(
                "TLS_REQUIRED",
                "Remote relays require HTTPS",
                None,
            ));
        }
        let mut config = ureq::Agent::config_builder()
            .max_redirects(0)
            .max_redirects_will_error(true)
            .http_status_as_error(false)
            .proxy(None)
            .timeout_global(Some(timeout));
        if let Some(pem) = ca {
            use ureq::tls::{Certificate, RootCerts, TlsConfig, TlsProvider};
            if url.scheme() != "https" || pem.len() > 20_000 {
                return Err(Fault::new("TLS", "Invalid relay certificate", None));
            }
            let cert = Certificate::from_pem(pem.as_bytes())
                .map_err(|_| Fault::new("TLS", "Invalid relay certificate", None))?;
            config = config.tls_config(
                TlsConfig::builder()
                    // Earlier LAN installs use an explicitly pinned self-signed CA as
                    // the presented certificate. Use the platform verifier for those
                    // private relays, with default roots disabled by Specific.
                    .provider(TlsProvider::NativeTls)
                    .root_certs(RootCerts::new_with_certs(&[cert]))
                    .build(),
            );
        }
        let config = config.build();
        Ok(Self {
            origin: url.origin().ascii_serialization(),
            agent: config.into(),
        })
    }

    fn request(
        &self,
        path: &str,
        auth: &str,
        input: Option<&Value>,
        max_bytes: usize,
        retries: usize,
    ) -> Result<Value, Fault> {
        let endpoint = format!("{}{path}", self.origin);
        let body = input
            .map(|value| serde_json::to_vec(value).expect("Value serialization is infallible"));
        if body.as_ref().is_some_and(|body| body.len() > max_bytes) {
            return Err(Fault::new(
                "BODY_TOO_LARGE",
                "Relay request exceeds byte limit",
                None,
            ));
        }
        for attempt in 0..=retries {
            match self.request_once(&endpoint, auth, body.as_deref(), max_bytes) {
                Err(error)
                    if attempt < retries
                        && (error.code == "TRANSPORT"
                            || matches!(error.status, Some(429 | 502 | 503 | 504))) =>
                {
                    thread::sleep(Duration::from_millis(100 << attempt));
                }
                result => return result,
            }
        }
        unreachable!("the retry loop terminates after at most three attempts");
    }

    fn request_once(
        &self,
        endpoint: &str,
        auth: &str,
        body: Option<&[u8]>,
        max_bytes: usize,
    ) -> Result<Value, Fault> {
        let response = if let Some(body) = body {
            self.agent
                .post(endpoint)
                .header("authorization", auth)
                .header("content-type", "application/json")
                .send(body)
        } else {
            self.agent
                .get(endpoint)
                .header("authorization", auth)
                .call()
        }
        .map_err(|error| match error {
            ureq::Error::TooManyRedirects => {
                Fault::new("REDIRECT", "Relay redirects are disabled", None)
            }
            ureq::Error::NativeTls(error) => {
                Fault::new("TLS", &format!("Private relay TLS failed: {error}"), None)
            }
            ureq::Error::Rustls(error) => Fault::new(
                "TLS",
                &format!("Relay TLS negotiation failed: {error}"),
                None,
            ),
            ureq::Error::Io(error) => {
                if let Some(error) = error
                    .get_ref()
                    .and_then(|error| error.downcast_ref::<tokio_rustls::rustls::Error>())
                {
                    Fault::new(
                        "TLS",
                        &format!("Relay TLS negotiation failed: {error}"),
                        None,
                    )
                } else {
                    Fault::transport()
                }
            }
            _ => Fault::transport(),
        })?;
        let status = response.status();
        let oversized = || Fault::new("BODY_TOO_LARGE", "Relay response exceeds byte limit", None);
        if response
            .headers()
            .get("content-length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(oversized());
        }
        let mut bytes = Vec::new();
        response
            .into_body()
            .into_reader()
            .take((max_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| Fault::transport())?;
        if bytes.len() > max_bytes {
            return Err(oversized());
        }
        let data: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Fault::new("INVALID_RESPONSE", "Relay returned invalid JSON", None))?;
        if data["protocol"] != "spool-relay/1" {
            return Err(Fault::new("PROTOCOL", "Unsupported relay protocol", None));
        }
        if !status.is_success() {
            return Err(Fault::new(
                data["error"]["code"].as_str().unwrap_or("HTTP_ERROR"),
                data["error"]["message"]
                    .as_str()
                    .unwrap_or("Relay request failed"),
                Some(status.as_u16()),
            ));
        }
        Ok(data)
    }
}
