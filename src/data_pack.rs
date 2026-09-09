//! 在V8进程启动前发现并校验游戏中立的运行时数据信封。 / Discovers and validates game-neutral runtime data envelopes before the V8 process starts.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::ProcessDataPackConfig;

const RUNTIME_PACK_FILE_NAME: &str = "runtime.pack.json";
const MAX_DISCOVERY_DEPTH: usize = 32;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeDataPackFile {
    format_version: u32,
    id: String,
    owner_module_id: String,
    content_hash: String,
    source: String,
    payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedRuntimeDataPack {
    format_version: u32,
    id: String,
    owner_module_id: String,
    content_hash: String,
    source: String,
    file_hash: String,
    payload: Value,
}

/// 只公开启动时实际装载的身份，不泄露数据内容或本机路径。 / Exposes loaded identity without payloads or local paths.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeDataPackIdentity {
    pub(crate) id: String,
    pub(crate) owner_module_id: String,
    pub(crate) file_hash: String,
}

impl LoadedRuntimeDataPack {
    pub(crate) fn identity(&self) -> RuntimeDataPackIdentity {
        RuntimeDataPackIdentity {
            id: self.id.clone(),
            owner_module_id: self.owner_module_id.clone(),
            file_hash: self.file_hash.clone(),
        }
    }
}

pub fn load_runtime_data_packs(
    resolved_config: &Path,
    config: &ProcessDataPackConfig,
) -> Result<Vec<LoadedRuntimeDataPack>> {
    if config.sources.is_empty() {
        return Ok(Vec::new());
    }
    let base = resolved_config.parent().unwrap_or_else(|| Path::new("."));
    let mut files = Vec::new();
    for source in &config.sources {
        let path = PathBuf::from(source);
        let resolved = if path.is_absolute() {
            path
        } else {
            base.join(path)
        };
        discover(&resolved, 0, &mut files).with_context(|| {
            format!(
                "failed to discover runtime data packs from {}",
                resolved.display()
            )
        })?;
    }
    files.sort();
    files.dedup();

    let mut loaded = Vec::with_capacity(files.len());
    let mut ids = HashSet::new();
    let mut total_bytes = 0_u64;
    for file in files {
        let bytes = fs::read(&file)
            .with_context(|| format!("failed to read runtime data pack {}", file.display()))?;
        let byte_count = u64::try_from(bytes.len()).context("runtime data pack length overflow")?;
        if byte_count > config.max_pack_bytes {
            bail!(
                "runtime data pack {} is {} bytes; maxPackBytes is {}",
                file.display(),
                byte_count,
                config.max_pack_bytes
            );
        }
        total_bytes = total_bytes
            .checked_add(byte_count)
            .context("runtime data pack total length overflow")?;
        if total_bytes > config.max_total_bytes {
            bail!(
                "runtime data packs total {} bytes; maxTotalBytes is {}",
                total_bytes,
                config.max_total_bytes
            );
        }
        let pack: RuntimeDataPackFile = serde_json::from_slice(&bytes)
            .with_context(|| format!("failed to parse runtime data pack {}", file.display()))?;
        validate_pack(&pack, &file)?;
        if !ids.insert(pack.id.clone()) {
            bail!("duplicate runtime data pack id: {}", pack.id);
        }
        loaded.push(LoadedRuntimeDataPack {
            format_version: pack.format_version,
            id: pack.id,
            owner_module_id: pack.owner_module_id,
            content_hash: pack.content_hash,
            source: pack.source,
            file_hash: format!("{:x}", Sha256::digest(&bytes)),
            payload: pack.payload,
        });
    }
    loaded.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(loaded)
}

fn discover(path: &Path, depth: usize, files: &mut Vec<PathBuf>) -> Result<()> {
    if depth > MAX_DISCOVERY_DEPTH {
        bail!("runtime data pack discovery exceeds {MAX_DISCOVERY_DEPTH} directory levels");
    }
    let metadata = fs::symlink_metadata(path).with_context(|| {
        format!(
            "runtime data pack source does not exist: {}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        bail!(
            "runtime data pack source must not be a symbolic link: {}",
            path.display()
        );
    }
    if metadata.is_file() {
        require_pack_file_name(path)?;
        files.push(path.to_path_buf());
        return Ok(());
    }
    if !metadata.is_dir() {
        bail!(
            "runtime data pack source must be a file or directory: {}",
            path.display()
        );
    }
    let mut entries = fs::read_dir(path)
        .with_context(|| {
            format!(
                "failed to read runtime data pack directory {}",
                path.display()
            )
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let entry_path = entry.path();
        let entry_metadata = fs::symlink_metadata(&entry_path)?;
        if entry_metadata.file_type().is_symlink() {
            bail!(
                "runtime data pack discovery rejects symbolic link: {}",
                entry_path.display()
            );
        }
        if entry_metadata.is_dir() {
            discover(&entry_path, depth + 1, files)?;
        } else if entry_metadata.is_file()
            && entry_path.file_name().and_then(|name| name.to_str()) == Some(RUNTIME_PACK_FILE_NAME)
        {
            files.push(entry_path);
        }
    }
    Ok(())
}

fn require_pack_file_name(path: &Path) -> Result<()> {
    if path.file_name().and_then(|name| name.to_str()) != Some(RUNTIME_PACK_FILE_NAME) {
        bail!(
            "runtime data pack file must be named {RUNTIME_PACK_FILE_NAME}: {}",
            path.display()
        );
    }
    Ok(())
}

fn validate_pack(pack: &RuntimeDataPackFile, path: &Path) -> Result<()> {
    if pack.format_version != 1 {
        bail!(
            "runtime data pack {} has unsupported formatVersion {}",
            path.display(),
            pack.format_version
        );
    }
    if !valid_dotted_id(&pack.id) {
        bail!(
            "runtime data pack {} has invalid id {}",
            path.display(),
            pack.id
        );
    }
    if !valid_dotted_id(&pack.owner_module_id) {
        bail!(
            "runtime data pack {} has invalid ownerModuleId {}",
            path.display(),
            pack.owner_module_id
        );
    }
    if !valid_sha256(&pack.content_hash) {
        bail!(
            "runtime data pack {} has invalid contentHash",
            path.display()
        );
    }
    if pack.source.trim().is_empty() {
        bail!("runtime data pack {} has an empty source", path.display());
    }
    Ok(())
}

fn valid_dotted_id(value: &str) -> bool {
    if value.len() > 200 || !value.contains('.') {
        return false;
    }
    value.split(['.', '-']).all(|segment| {
        !segment.is_empty()
            && segment.as_bytes()[0].is_ascii_lowercase()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn discovers_nested_packs_in_id_order_and_computes_file_hashes() {
        let directory = tempdir().unwrap();
        let config_path = directory.path().join("process.json");
        fs::write(&config_path, "{}").unwrap();
        write_pack(
            directory.path().join("packs/z/runtime.pack.json"),
            "org.example.z",
        );
        write_pack(
            directory.path().join("packs/a/runtime.pack.json"),
            "org.example.a",
        );
        let config = ProcessDataPackConfig {
            sources: vec!["packs".to_string()],
            ..ProcessDataPackConfig::default()
        };

        let packs = load_runtime_data_packs(&config_path, &config).unwrap();

        assert_eq!(
            packs
                .iter()
                .map(|pack| pack.id.as_str())
                .collect::<Vec<_>>(),
            ["org.example.a", "org.example.z"]
        );
        assert!(packs.iter().all(|pack| valid_sha256(&pack.file_hash)));
    }

    #[test]
    fn rejects_duplicate_ids_and_size_overflow() {
        let directory = tempdir().unwrap();
        let config_path = directory.path().join("process.json");
        fs::write(&config_path, "{}").unwrap();
        write_pack(
            directory.path().join("packs/a/runtime.pack.json"),
            "org.example.same",
        );
        write_pack(
            directory.path().join("packs/b/runtime.pack.json"),
            "org.example.same",
        );
        let duplicate = ProcessDataPackConfig {
            sources: vec!["packs".to_string()],
            ..ProcessDataPackConfig::default()
        };
        assert!(
            load_runtime_data_packs(&config_path, &duplicate)
                .unwrap_err()
                .to_string()
                .contains("duplicate runtime data pack id")
        );

        let too_small = ProcessDataPackConfig {
            sources: vec!["packs/a/runtime.pack.json".to_string()],
            max_pack_bytes: 8,
            max_total_bytes: 16,
        };
        assert!(
            load_runtime_data_packs(&config_path, &too_small)
                .unwrap_err()
                .to_string()
                .contains("maxPackBytes")
        );
    }

    #[test]
    fn rejects_unknown_envelope_fields() {
        let directory = tempdir().unwrap();
        let config_path = directory.path().join("process.json");
        fs::write(&config_path, "{}").unwrap();
        let path = directory.path().join("runtime.pack.json");
        fs::write(
            &path,
            format!(
                r#"{{"formatVersion":1,"id":"org.example.cards","ownerModuleId":"org.example.cards","contentHash":"{}","source":"fixture","payload":{{}},"unexpected":true}}"#,
                "a".repeat(64)
            ),
        )
        .unwrap();
        let config = ProcessDataPackConfig {
            sources: vec![path.display().to_string()],
            ..ProcessDataPackConfig::default()
        };
        assert!(
            load_runtime_data_packs(&config_path, &config)
                .unwrap_err()
                .to_string()
                .contains("failed to parse runtime data pack")
        );
    }

    fn write_pack(path: PathBuf, id: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            format!(
                r#"{{"formatVersion":1,"id":"{id}","ownerModuleId":"org.example.cards","contentHash":"{}","source":"fixture","payload":{{"cards":[1,2]}}}}"#,
                "a".repeat(64)
            ),
        )
        .unwrap();
    }
}
