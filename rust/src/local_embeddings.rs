use crate::{Result, project_init::random_id, vectors};
use ort::session::Session;
use ort::value::Tensor;
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};
use tokenizers::{PaddingDirection, Tokenizer, TruncationDirection};

pub struct Model {
    pub id: String,
    tokenizer: Tokenizer,
    pad_id: u32,
    pad: &'static str,
    session: Session,
}

struct Spec {
    repo: &'static str,
    revision: &'static str,
    pad: &'static str,
}

impl Spec {
    fn new(key: &str) -> Result<Self> {
        match key {
            "multilingual" => Ok(Self {
                repo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
                revision: "2c4055b12046f11709e9df2c122e59ffbdc2f900",
                pad: "<pad>",
            }),
            "english-small" => Ok(Self {
                repo: "Xenova/all-MiniLM-L6-v2",
                revision: "751bff37182d3f1213fa05d7196b954e230abad9",
                pad: "[PAD]",
            }),
            _ => Err("Unknown local model".into()),
        }
    }
}

fn cache_root() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("SPOOL_MODEL_CACHE") {
        return Ok(path.into());
    }
    if let Some(path) = std::env::var_os("XDG_CACHE_HOME") {
        return Ok(PathBuf::from(path).join("spool/models"));
    }
    Ok(std::env::home_dir()
        .ok_or("No home directory for local models")?
        .join(".cache/spool/models"))
}

pub(crate) fn runtime() -> Result<PathBuf> {
    let path = if let Some(path) = std::env::var_os("ORT_DYLIB_PATH") {
        PathBuf::from(path)
    } else {
        let exe = std::env::current_exe()?;
        let parent = exe.parent().ok_or("Could not locate the ONNX runtime")?;
        let library = if cfg!(target_os = "macos") {
            "libonnxruntime.dylib"
        } else if cfg!(target_os = "windows") {
            "onnxruntime.dll"
        } else {
            "libonnxruntime.so"
        };
        parent.join(library)
    };
    if !path.is_file() {
        return Err(
            "ONNX Runtime is unavailable beside the executable or at ORT_DYLIB_PATH".into(),
        );
    }
    Ok(fs::canonicalize(path)?)
}

fn artifact(spec: &Spec, cache: &Path, file: &str, max: u64) -> Result<PathBuf> {
    let path = cache.join(spec.repo).join(spec.revision).join(file);
    if path
        .metadata()
        .is_ok_and(|meta| meta.is_file() && meta.len() > 0 && meta.len() <= max)
    {
        return Ok(path);
    }
    let parent = path.parent().ok_or("Invalid model cache location")?;
    fs::create_dir_all(parent)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path.with_extension("download.lock"))?;
    lock.lock()?;
    if path
        .metadata()
        .is_ok_and(|meta| meta.is_file() && meta.len() > 0 && meta.len() <= max)
    {
        return Ok(path);
    }
    let client: ureq::Agent = ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(4)
        .timeout_global(Some(Duration::from_secs(240)))
        .build()
        .into();
    let url = format!(
        "https://huggingface.co/{}/resolve/{}/{file}",
        spec.repo, spec.revision
    );
    let response = client
        .get(&url)
        .call()
        .map_err(|_| "Could not download the pinned local model")?;
    let length = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if length.is_some_and(|size| size > max || size == 0) {
        return Err("Local model file exceeds its size limit".into());
    }
    let temporary = path.with_file_name(format!(".model-{}.part", random_id()?));
    let result = (|| -> Result<()> {
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        let written = io::copy(
            &mut response.into_body().into_reader().take(max + 1),
            &mut output,
        )?;
        if written == 0 || written > max || length.is_some_and(|size| size != written) {
            return Err("Local model download was incomplete or too large".into());
        }
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result?;
    Ok(path)
}

impl Model {
    pub(crate) fn identity(key: &str) -> Result<String> {
        let spec = Spec::new(key)?;
        Ok(format!("{}@{}:q8:mean:256:plain", spec.repo, spec.revision))
    }

    pub fn load(key: &str, threads: usize, cache: Option<&Path>) -> Result<Self> {
        if !matches!(threads, 1 | 2 | 4) {
            return Err("Invalid inference thread count".into());
        }
        let spec = Spec::new(key)?;
        let runtime = runtime()?;
        let cache = cache
            .map(Path::to_path_buf)
            .map(Ok)
            .unwrap_or_else(cache_root)?;
        let tokenizer_path = artifact(&spec, &cache, "tokenizer.json", 32 * 1024 * 1024)?;
        let model_path = artifact(
            &spec,
            &cache,
            "onnx/model_quantized.onnx",
            192 * 1024 * 1024,
        )?;
        ort::init_from(runtime.to_string_lossy()).commit()?;
        let mut tokenizer =
            Tokenizer::from_file(tokenizer_path).map_err(|error| error.to_string())?;
        tokenizer
            .with_truncation(None)
            .map_err(|err| err.to_string())?;
        tokenizer.with_padding(None);
        let pad_id = tokenizer
            .token_to_id(spec.pad)
            .ok_or("Tokenizer padding token missing")?;
        let session = Session::builder()?
            .with_intra_threads(threads)?
            .with_inter_threads(1)?
            .commit_from_file(model_path)?;
        Ok(Self {
            id: format!("{}@{}:q8:mean:256:plain", spec.repo, spec.revision),
            tokenizer,
            pad_id,
            pad: spec.pad,
            session,
        })
    }

    pub fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty()
            || texts.len() > 8
            || texts.iter().any(|s| s.encode_utf16().count() > 16000)
        {
            return Err("Invalid embedding batch".into());
        }
        let mut encoded = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|err| err.to_string())?;
        // The existing pipeline truncates after inserting special tokens.
        // It uses the tokenizer's 512-token setting despite the legacy model ID.
        for item in &mut encoded {
            item.truncate(512, 0, TruncationDirection::Right);
        }
        let width = encoded
            .iter()
            .map(tokenizers::Encoding::len)
            .max()
            .filter(|n| *n > 0)
            .ok_or("Tokenizer returned no inputs")?;
        for item in &mut encoded {
            item.pad(width, self.pad_id, 0, self.pad, PaddingDirection::Right);
        }
        let shape = [texts.len(), width];
        let flatten = |pick: for<'a> fn(&'a tokenizers::Encoding) -> &'a [u32]| {
            encoded
                .iter()
                .flat_map(|record| pick(record).iter().map(|&value| i64::from(value)))
                .collect::<Vec<_>>()
        };
        let mask = flatten(tokenizers::Encoding::get_attention_mask);
        let mut inputs = vec![
            (
                "input_ids",
                Tensor::from_array((shape.to_vec(), flatten(tokenizers::Encoding::get_ids)))?,
            ),
            (
                "attention_mask",
                Tensor::from_array((shape.to_vec(), mask.clone()))?,
            ),
        ];
        if self
            .session
            .inputs
            .iter()
            .any(|field| field.name == "token_type_ids")
        {
            inputs.push((
                "token_type_ids",
                Tensor::from_array((shape.to_vec(), flatten(tokenizers::Encoding::get_type_ids)))?,
            ));
        }
        let result = self.session.run(
            inputs
                .into_iter()
                .map(|(name, tensor)| (name, ort::session::SessionInputValue::from(tensor)))
                .collect::<Vec<_>>(),
        )?;
        let (dims, data) = result
            .get("last_hidden_state")
            .ok_or("Local model did not return token embeddings")?
            .try_extract_raw_tensor::<f32>()?;
        if dims != [texts.len() as i64, width as i64, 384]
            || data.len() != texts.len() * width * 384
        {
            return Err("Unexpected local model output dimensions".into());
        }
        data.chunks_exact(width * 384)
            .zip(mask.chunks_exact(width))
            .map(|(tokens, mask)| {
                let mut pooled = vec![0_f64; 384];
                for (token, mask) in tokens.as_chunks::<384>().0.iter().zip(mask) {
                    if *mask != 0 {
                        for (sum, value) in pooled.iter_mut().zip(token) {
                            *sum += f64::from(*value);
                        }
                    }
                }
                vectors::normalized(&pooled)
                    .ok_or_else(|| "Local model produced an invalid embedding".into())
            })
            .collect()
    }
}
