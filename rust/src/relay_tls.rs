use crate::Result;
use axum::serve::Listener;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::{io::Read, net::SocketAddr, path::Path, sync::Arc, time::Duration};
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinSet,
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        self, ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
    server::TlsStream,
};

pub fn certificate(directory: &Path) -> Result<String> {
    let mut certificate = String::new();
    std::fs::File::open(directory.join("relay.crt"))?
        .take(16_385)
        .read_to_string(&mut certificate)?;
    if certificate.len() > 16_384 || CertificateDer::from_pem_slice(certificate.as_bytes()).is_err()
    {
        return Err("Invalid private relay certificate".into());
    }
    Ok(certificate)
}

pub fn configure(directory: &Path) -> Result<(String, TlsAcceptor)> {
    let public = certificate(directory)?;
    let mut key = Vec::new();
    std::fs::File::open(directory.join("relay.key"))?
        .take(65_537)
        .read_to_end(&mut key)?;
    if key.len() > 65_536 {
        return Err("Invalid private relay key".into());
    }
    let key = PrivateKeyDer::from_pem_slice(&key)?;
    let chain = CertificateDer::pem_slice_iter(public.as_bytes())
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut tls =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(chain, key)?;
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok((public, TlsAcceptor::from(Arc::new(tls))))
}

pub fn pins(mut response: Value, certificate: &str, origin: &str) -> Result<Value> {
    if response["connection"].is_object() {
        response["connection"]["ca"] = json!(certificate);
    }
    if let Some(link) = response["link"].as_str() {
        let link = url::Url::parse(link)?;
        if link.scheme() != "spool" {
            return Err("Unexpected relay invitation URL".into());
        }
        let host = link
            .host_str()
            .filter(|host| matches!(*host, "join" | "workspace"))
            .ok_or("Invalid relay invitation")?;
        let encoded = link
            .path()
            .strip_prefix("/v1/")
            .ok_or("Invalid relay invitation")?;
        let mut value: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded)?)?;
        if value["url"] != origin {
            return Err("Invitation origin differs from the relay".into());
        }
        value["ca"] = json!(certificate);
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value)?);
        let prefix = if host == "workspace" {
            "workspace."
        } else {
            ""
        };
        response["link"] = json!(format!("spool://{host}/v1/{encoded}"));
        response["browserLink"] = json!(format!("{origin}/join#{prefix}{encoded}"));
    }
    Ok(response)
}

pub struct TlsListener {
    listener: TcpListener,
    acceptor: TlsAcceptor,
    handshakes: JoinSet<Option<(TlsStream<TcpStream>, SocketAddr)>>,
}

impl TlsListener {
    pub fn new(listener: TcpListener, acceptor: TlsAcceptor) -> Self {
        Self {
            listener,
            acceptor,
            handshakes: JoinSet::new(),
        }
    }
}

impl Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.local_addr()
    }

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            tokio::select! {
                outcome=self.handshakes.join_next(), if !self.handshakes.is_empty()=>{
                    if let Some(Ok(Some(connection)))=outcome { return connection; }
                }
                (stream,address)=Listener::accept(&mut self.listener), if self.handshakes.len()<32=>{
                    let acceptor=self.acceptor.clone();
                    self.handshakes.spawn(async move {
                        let stream=tokio::time::timeout(Duration::from_secs(5),acceptor.accept(stream)).await.ok()?.ok()?;
                        Some((stream,address))
                    });
                }
            }
        }
    }
}
