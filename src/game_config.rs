//! 校验并承载独立于Model Bundle的Luban数据包。 / Validates and carries Luban data packages independently from the Model bundle.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameConfigManifest {
    format_version: u32,
    schema_fingerprint: String,
    client_schema_fingerprint: String,
    data_fingerprint: String,
    server_file: String,
    server_hash: String,
    client_file: String,
    client_hash: String,
}

/// 已完成文件名、哈希和组合数据指纹校验的候选。 / A candidate whose filenames, hashes, and combined data fingerprint have been verified.
pub(crate) struct GameConfigBundle {
    directory: PathBuf,
    manifest_json: String,
    manifest: GameConfigManifest,
    server_data_json: String,
}

impl GameConfigBundle {
    /// 从固定格式目录读取完整数据包；不会修改当前V8配置。 / Reads a complete package from a fixed-format directory without touching the active V8 config.
    pub(crate) fn load(directory: &Path) -> Result<Self> {
        let directory = directory.canonicalize().with_context(|| {
            format!(
                "failed to resolve game config package {}",
                directory.display()
            )
        })?;
        let manifest_path = directory.join("game-config.manifest.json");
        let manifest_json = fs::read_to_string(&manifest_path)
            .with_context(|| format!("failed to read {}", manifest_path.display()))?;
        let manifest: GameConfigManifest = serde_json::from_str(&manifest_json)
            .with_context(|| format!("failed to parse {}", manifest_path.display()))?;
        if manifest.format_version != 1 {
            bail!(
                "unsupported game config manifest format: {}",
                manifest.format_version
            );
        }
        if manifest.server_file != "server.json" || manifest.client_file != "client.json" {
            bail!("game config data filenames are fixed");
        }
        require_sha256("schemaFingerprint", &manifest.schema_fingerprint)?;
        require_sha256(
            "clientSchemaFingerprint",
            &manifest.client_schema_fingerprint,
        )?;
        require_sha256("dataFingerprint", &manifest.data_fingerprint)?;
        require_sha256("serverHash", &manifest.server_hash)?;
        require_sha256("clientHash", &manifest.client_hash)?;

        let server_bytes = read_and_verify(
            &directory.join(&manifest.server_file),
            &manifest.server_hash,
            "server game config",
        )?;
        let client_bytes = read_and_verify(
            &directory.join(&manifest.client_file),
            &manifest.client_hash,
            "client game config",
        )?;
        let mut combined = Vec::with_capacity(server_bytes.len() + client_bytes.len() + 1);
        combined.extend_from_slice(&server_bytes);
        combined.push(0);
        combined.extend_from_slice(&client_bytes);
        verify_bytes_hash(
            &combined,
            &manifest.data_fingerprint,
            "combined game config",
        )?;
        let server_data_json = String::from_utf8(server_bytes)
            .context("server game config data is not valid UTF-8")?;

        Ok(Self {
            directory,
            manifest_json,
            manifest,
            server_data_json,
        })
    }

    /// 要求候选结构与当前Model完全一致；数据版本可以不同。 / Requires the candidate schema to match the active Model while allowing a different data version.
    pub(crate) fn verify_schema(&self, expected: &str) -> Result<()> {
        if self.manifest.schema_fingerprint != expected {
            bail!(
                "game config schema mismatch: model={}, candidate={}; rebuild and restart the Process",
                expected,
                self.manifest.schema_fingerprint
            );
        }
        Ok(())
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn manifest_json(&self) -> &str {
        &self.manifest_json
    }

    pub(crate) fn server_data_json(&self) -> &str {
        &self.server_data_json
    }

    pub(crate) fn data_fingerprint(&self) -> &str {
        &self.manifest.data_fingerprint
    }
}

fn read_and_verify(path: &Path, expected: &str, kind: &str) -> Result<Vec<u8>> {
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    verify_bytes_hash(&bytes, expected, kind)?;
    Ok(bytes)
}

fn verify_bytes_hash(bytes: &[u8], expected: &str, kind: &str) -> Result<()> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        bail!("{kind} hash mismatch: expected {expected}, actual {actual}");
    }
    Ok(())
}

fn require_sha256(name: &str, value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        bail!("game config {name} must be lowercase sha256");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::require_sha256;

    #[test]
    fn fingerprint_requires_lowercase_sha256() {
        assert!(require_sha256("test", &"a".repeat(64)).is_ok());
        assert!(require_sha256("test", &"A".repeat(64)).is_err());
        assert!(require_sha256("test", "abc").is_err());
    }
}
