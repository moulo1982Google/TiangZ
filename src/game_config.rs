//! 校验并承载独立于Model Bundle的Luban数据包。 / Validates and carries Luban data packages independently from the Model bundle.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameConfigManifest {
    format_version: u32,
    schema_fingerprint: String,
    client_schema_fingerprint: String,
    data_fingerprint: String,
    hot_data_fingerprint: String,
    cold_data_fingerprint: String,
    reload_policies: GameConfigReloadPolicies,
    server_file: String,
    server_hash: String,
    server_hot_file: String,
    server_hot_hash: String,
    server_cold_file: String,
    server_cold_hash: String,
    client_file: String,
    client_hash: String,
    client_hot_file: String,
    client_hot_hash: String,
    client_cold_file: String,
    client_cold_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GameConfigReloadPolicies {
    hot: Vec<String>,
    cold: Vec<String>,
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
        if manifest.format_version != 2 {
            bail!(
                "unsupported game config manifest format: {}",
                manifest.format_version
            );
        }
        if manifest.server_file != "server.json"
            || manifest.server_hot_file != "server.hot.json"
            || manifest.server_cold_file != "server.cold.json"
            || manifest.client_file != "client.json"
            || manifest.client_hot_file != "client.hot.json"
            || manifest.client_cold_file != "client.cold.json"
        {
            bail!("game config data filenames are fixed");
        }
        require_sha256("schemaFingerprint", &manifest.schema_fingerprint)?;
        require_sha256(
            "clientSchemaFingerprint",
            &manifest.client_schema_fingerprint,
        )?;
        require_sha256("dataFingerprint", &manifest.data_fingerprint)?;
        require_sha256("hotDataFingerprint", &manifest.hot_data_fingerprint)?;
        require_sha256("coldDataFingerprint", &manifest.cold_data_fingerprint)?;
        require_sha256("serverHash", &manifest.server_hash)?;
        require_sha256("serverHotHash", &manifest.server_hot_hash)?;
        require_sha256("serverColdHash", &manifest.server_cold_hash)?;
        require_sha256("clientHash", &manifest.client_hash)?;
        require_sha256("clientHotHash", &manifest.client_hot_hash)?;
        require_sha256("clientColdHash", &manifest.client_cold_hash)?;

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
        let server_hot_bytes = read_and_verify(
            &directory.join(&manifest.server_hot_file),
            &manifest.server_hot_hash,
            "server hot game config",
        )?;
        let server_cold_bytes = read_and_verify(
            &directory.join(&manifest.server_cold_file),
            &manifest.server_cold_hash,
            "server cold game config",
        )?;
        let client_hot_bytes = read_and_verify(
            &directory.join(&manifest.client_hot_file),
            &manifest.client_hot_hash,
            "client hot game config",
        )?;
        let client_cold_bytes = read_and_verify(
            &directory.join(&manifest.client_cold_file),
            &manifest.client_cold_hash,
            "client cold game config",
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
        verify_combined_hash(
            &server_hot_bytes,
            &client_hot_bytes,
            &manifest.hot_data_fingerprint,
            "hot game config",
        )?;
        verify_combined_hash(
            &server_cold_bytes,
            &client_cold_bytes,
            &manifest.cold_data_fingerprint,
            "cold game config",
        )?;
        verify_partition(
            &server_bytes,
            &server_hot_bytes,
            &server_cold_bytes,
            &manifest.reload_policies,
            "server",
        )?;
        verify_partition(
            &client_bytes,
            &client_hot_bytes,
            &client_cold_bytes,
            &manifest.reload_policies,
            "client",
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

    /// 返回启动后不可变化的冷配置指纹；reload-config必须与当前值完全一致。 / Returns the restart-only cold-data fingerprint that every reload candidate must preserve.
    pub(crate) fn cold_data_fingerprint(&self) -> &str {
        &self.manifest.cold_data_fingerprint
    }
}

fn verify_combined_hash(server: &[u8], client: &[u8], expected: &str, kind: &str) -> Result<()> {
    let mut combined = Vec::with_capacity(server.len() + client.len() + 1);
    combined.extend_from_slice(server);
    combined.push(0);
    combined.extend_from_slice(client);
    verify_bytes_hash(&combined, expected, kind)
}

/// 验证完整数据恰好由互斥的Hot与Cold分区组成，避免manifest伪造冷指纹。 / Verifies that the complete data is exactly the disjoint union of its Hot and Cold partitions.
fn verify_partition(
    full: &[u8],
    hot: &[u8],
    cold: &[u8],
    policies: &GameConfigReloadPolicies,
    kind: &str,
) -> Result<()> {
    let full = parse_object(full, kind, "complete")?;
    let hot = parse_object(hot, kind, "hot")?;
    let cold = parse_object(cold, kind, "cold")?;
    let hot_names = policies
        .hot
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let cold_names = policies
        .cold
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    if !hot_names.is_disjoint(&cold_names) {
        bail!("game config Hot/Cold policies overlap");
    }
    for key in hot.keys() {
        if !hot_names.contains(key.as_str()) {
            bail!("{kind} hot game config contains undeclared table {key}");
        }
    }
    for key in cold.keys() {
        if !cold_names.contains(key.as_str()) {
            bail!("{kind} cold game config contains undeclared table {key}");
        }
    }
    let mut merged = cold;
    for (key, value) in hot {
        if merged.insert(key.clone(), value).is_some() {
            bail!("{kind} game config table appears in both Hot and Cold partitions: {key}");
        }
    }
    if merged != full {
        bail!("{kind} complete game config does not match its Hot/Cold partitions");
    }
    Ok(())
}

fn parse_object(bytes: &[u8], kind: &str, partition: &str) -> Result<Map<String, Value>> {
    let value: Value = serde_json::from_slice(bytes)
        .with_context(|| format!("failed to parse {kind} {partition} game config"))?;
    value
        .as_object()
        .cloned()
        .with_context(|| format!("{kind} {partition} game config must be an object"))
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
