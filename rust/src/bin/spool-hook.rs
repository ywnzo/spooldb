#[path = "../codex_hooks.rs"]
mod codex_hooks;
#[path = "../private_files.rs"]
mod private_files;
#[path = "../project_paths.rs"]
mod project_paths;

use serde_json::{Value, json};
use std::io::Read;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn run() -> Result<Value> {
    let event = std::env::args().nth(1).unwrap_or_default();
    let mut bytes = Vec::new();
    std::io::stdin().take(1_000_001).read_to_end(&mut bytes)?;
    if bytes.len() > 1_000_000 {
        return Ok(json!({}));
    }
    codex_hooks::run(&event, &serde_json::from_slice(&bytes)?)
}

fn main() {
    println!("{}", run().unwrap_or_else(|_| json!({})));
}
