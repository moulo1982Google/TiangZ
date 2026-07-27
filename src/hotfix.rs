//! 冻结 Model 制品并校验、加载 Hotfix generation。 / Freezes Model artifacts and validates and loads Hotfix generations.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use deno_core::{JsRuntime, ModuleSpecifier};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::host::{
    JsEntrypoints, call_js_abort_hotfix, call_js_begin_hotfix, call_js_commit_hotfix,
    load_es_module, load_js_entrypoints,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelManifest {
    format_version: u32,
    model_fingerprint: String,
    model_source_hash: String,
    protocol_fingerprint: String,
    stable_core_api_hash: String,
    native_schema_hash: String,
    build_mode: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HotfixManifest {
    format_version: u32,
    bundle_version: String,
    model_fingerprint: String,
    model_source_hash: String,
    protocol_fingerprint: String,
    stable_core_api_hash: String,
    native_schema_hash: String,
    hotfix_hash: String,
    build_mode: String,
}

/// 表示启动时已经过文件哈希和冻结契约校验的双 Bundle。 / Represents Model and Hotfix bundles whose hashes and frozen contracts passed startup validation.
pub struct RuntimeBundles {
    model_specifier: ModuleSpecifier,
    hotfix_path: PathBuf,
    hotfix_manifest_json: String,
    hotfix_manifest: HotfixManifest,
}

impl RuntimeBundles {
    /// 从 dist 读取真实文件并校验 manifest；失败发生在监听端口和业务对象创建之前。 / Reads real dist files and validates manifests before endpoints and business objects are created.
    pub fn load(root: &Path) -> Result<Self> {
        let dist = root.join("dist");
        let model_path = dist.join("model.js");
        let hotfix_path = dist.join("hotfix.js");
        let model_manifest_path = dist.join("model.manifest.json");
        let hotfix_manifest_path = dist.join("hotfix.manifest.json");

        let model_manifest: ModelManifest = read_json(&model_manifest_path)?;
        let hotfix_manifest_json = fs::read_to_string(&hotfix_manifest_path)
            .with_context(|| format!("failed to read {}", hotfix_manifest_path.display()))?;
        let hotfix_manifest: HotfixManifest = serde_json::from_str(&hotfix_manifest_json)
            .with_context(|| format!("failed to parse {}", hotfix_manifest_path.display()))?;

        if model_manifest.format_version != 1 || hotfix_manifest.format_version != 1 {
            bail!("unsupported runtime bundle manifest format");
        }
        verify_hash(&model_path, &model_manifest.model_fingerprint, "Model")?;
        verify_hash(&hotfix_path, &hotfix_manifest.hotfix_hash, "Hotfix")?;
        require_equal(
            "modelFingerprint",
            &model_manifest.model_fingerprint,
            &hotfix_manifest.model_fingerprint,
        )?;
        require_equal(
            "modelSourceHash",
            &model_manifest.model_source_hash,
            &hotfix_manifest.model_source_hash,
        )?;
        require_equal(
            "protocolFingerprint",
            &model_manifest.protocol_fingerprint,
            &hotfix_manifest.protocol_fingerprint,
        )?;
        require_equal(
            "stableCoreApiHash",
            &model_manifest.stable_core_api_hash,
            &hotfix_manifest.stable_core_api_hash,
        )?;
        require_equal(
            "nativeSchemaHash",
            &model_manifest.native_schema_hash,
            &hotfix_manifest.native_schema_hash,
        )?;
        require_equal(
            "buildMode",
            &model_manifest.build_mode,
            &hotfix_manifest.build_mode,
        )?;

        let model_specifier = ModuleSpecifier::from_file_path(&model_path).map_err(|_| {
            anyhow::anyhow!("failed to convert {} to a file URL", model_path.display())
        })?;
        Ok(Self {
            model_specifier,
            hotfix_path,
            hotfix_manifest_json,
            hotfix_manifest,
        })
    }

    pub fn model_specifier(&self) -> &ModuleSpecifier {
        &self.model_specifier
    }

    pub fn bundle_version(&self) -> &str {
        &self.hotfix_manifest.bundle_version
    }

    /// 在一个隔离 V8 中完成无 Process 实例的模块注册自检。 / Performs registration-only module validation in an isolated V8 with no Process instance.
    pub fn preflight(
        &self,
        js_event_loop: &tokio::runtime::Runtime,
        runtime: &mut JsRuntime,
    ) -> Result<()> {
        self.load_and_commit(js_event_loop, runtime, 0).map(|_| ())
    }

    /// 在正式 V8 中加载不可变 Model 和第一代 Hotfix。 / Loads immutable Model and the first Hotfix generation into the serving V8.
    pub fn install_initial(
        &self,
        js_event_loop: &tokio::runtime::Runtime,
        runtime: &mut JsRuntime,
    ) -> Result<JsEntrypoints> {
        let (entrypoints, status) = self.load_and_commit(js_event_loop, runtime, 1)?;
        tracing::info!(
            target: "tiangz::hotfix",
            bundle_version = %self.hotfix_manifest.bundle_version,
            status = %status,
            "initial Hotfix generation committed"
        );
        Ok(entrypoints)
    }

    fn load_and_commit(
        &self,
        js_event_loop: &tokio::runtime::Runtime,
        runtime: &mut JsRuntime,
        generation: u64,
    ) -> Result<(JsEntrypoints, String)> {
        load_es_module(js_event_loop, runtime, &self.model_specifier, true)
            .context("failed to load immutable Model bundle")?;
        let entrypoints = load_js_entrypoints(runtime)?;
        call_js_begin_hotfix(
            js_event_loop,
            runtime,
            &entrypoints,
            &self.hotfix_manifest_json,
        )?;

        let hotfix_specifier = self.hotfix_specifier(generation)?;
        if let Err(error) = load_es_module(js_event_loop, runtime, &hotfix_specifier, false) {
            let _ = call_js_abort_hotfix(js_event_loop, runtime, &entrypoints, &error.to_string());
            return Err(error).context("Hotfix candidate evaluation failed");
        }
        match call_js_commit_hotfix(js_event_loop, runtime, &entrypoints) {
            Ok(status) => Ok((entrypoints, status)),
            Err(error) => {
                let _ =
                    call_js_abort_hotfix(js_event_loop, runtime, &entrypoints, &error.to_string());
                Err(error).context("Hotfix candidate commit failed")
            }
        }
    }

    fn hotfix_specifier(&self, generation: u64) -> Result<ModuleSpecifier> {
        let mut specifier = ModuleSpecifier::from_file_path(&self.hotfix_path).map_err(|_| {
            anyhow::anyhow!(
                "failed to convert {} to a file URL",
                self.hotfix_path.display()
            )
        })?;
        specifier.set_query(Some(&format!("generation={generation}")));
        Ok(specifier)
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let text =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("failed to parse {}", path.display()))
}

fn verify_hash(path: &Path, expected: &str, kind: &str) -> Result<()> {
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        bail!(
            "{kind} bundle hash mismatch: expected {expected}, actual {actual}; rebuild the complete Model/Hotfix pair"
        );
    }
    Ok(())
}

fn require_equal(name: &str, model: &str, hotfix: &str) -> Result<()> {
    if model != hotfix {
        bail!(
            "Hotfix cannot change {name}: active Model={model}, candidate Hotfix={hotfix}; restart the Process with a complete deployment"
        );
    }
    Ok(())
}
