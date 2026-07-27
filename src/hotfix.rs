//! 冻结 Model 制品并校验、加载 Hotfix generation。 / Freezes Model artifacts and validates and loads Hotfix generations.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use deno_core::{JsRuntime, ModuleSpecifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::host::{
    JsEntrypoints, call_js_abort_hotfix, call_js_begin_hotfix, call_js_commit_hotfix,
    load_es_module, load_js_entrypoints,
};

#[derive(Clone, Debug, Deserialize)]
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
    model_manifest: ModelManifest,
    initial_hotfix: HotfixCandidate,
}

/// 表示已经过文件哈希与冻结 Model 契约校验、但尚未进入 V8 的候选。 / Represents a candidate whose file hash and frozen Model contracts passed validation but has not entered V8 yet.
pub struct HotfixCandidate {
    hotfix_path: PathBuf,
    hotfix_source: String,
    manifest_json: String,
    manifest: HotfixManifest,
}

/// 记录真正发生在 V8 切换阶段中的分段耗时；候选构建不属于这里。 / Records segmented V8 switch costs; candidate build time is intentionally excluded.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotfixInstallTimings {
    pub begin_ms: f64,
    pub candidate_eval_ms: f64,
    pub commit_ms: f64,
}

/// 返回 Hotfix 提交后的可观测结果。 / Returns the observable result after a Hotfix commit.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotfixInstallResult {
    pub bundle_version: String,
    pub status_json: String,
    pub timings: HotfixInstallTimings,
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
        let hotfix_bytes = fs::read(&hotfix_path)
            .with_context(|| format!("failed to read {}", hotfix_path.display()))?;

        if model_manifest.format_version != 1 || hotfix_manifest.format_version != 1 {
            bail!("unsupported runtime bundle manifest format");
        }
        verify_hash(&model_path, &model_manifest.model_fingerprint, "Model")?;
        verify_hotfix_contract(&model_manifest, &hotfix_bytes, &hotfix_manifest)?;

        let model_specifier = ModuleSpecifier::from_file_path(&model_path).map_err(|_| {
            anyhow::anyhow!("failed to convert {} to a file URL", model_path.display())
        })?;
        Ok(Self {
            model_specifier,
            model_manifest,
            initial_hotfix: HotfixCandidate {
                hotfix_source: decode_hotfix_source(&hotfix_path, hotfix_bytes)?,
                hotfix_path,
                manifest_json: hotfix_manifest_json,
                manifest: hotfix_manifest,
            },
        })
    }

    pub fn model_specifier(&self) -> &ModuleSpecifier {
        &self.model_specifier
    }

    pub fn bundle_version(&self) -> &str {
        self.initial_hotfix.bundle_version()
    }

    /// 从不可变候选目录读取 `hotfix.js` 与 manifest，并逐项匹配当前 Process 的 Model。 / Reads `hotfix.js` and its manifest from an immutable candidate directory and matches every frozen Model contract.
    pub fn load_candidate(&self, directory: &Path) -> Result<HotfixCandidate> {
        let hotfix_path = directory.join("hotfix.js");
        let manifest_path = directory.join("hotfix.manifest.json");
        let manifest_json = fs::read_to_string(&manifest_path)
            .with_context(|| format!("failed to read {}", manifest_path.display()))?;
        let manifest: HotfixManifest = serde_json::from_str(&manifest_json)
            .with_context(|| format!("failed to parse {}", manifest_path.display()))?;
        if manifest.format_version != 1 {
            bail!(
                "unsupported Hotfix manifest format: {}",
                manifest.format_version
            );
        }
        let hotfix_bytes = fs::read(&hotfix_path)
            .with_context(|| format!("failed to read {}", hotfix_path.display()))?;
        verify_hotfix_contract(&self.model_manifest, &hotfix_bytes, &manifest)?;
        Ok(HotfixCandidate {
            hotfix_source: decode_hotfix_source(&hotfix_path, hotfix_bytes)?,
            hotfix_path,
            manifest_json,
            manifest,
        })
    }

    /// 在一个隔离 V8 中完成无 Process 实例的初始模块注册自检。 / Performs initial registration-only module validation in an isolated V8 with no Process instance.
    pub fn preflight(
        &self,
        js_event_loop: &tokio::runtime::Runtime,
        runtime: &mut JsRuntime,
    ) -> Result<()> {
        self.preflight_candidate(js_event_loop, runtime, &self.initial_hotfix)
    }

    /// 在隔离 V8 中验证指定候选；不会修改正式 Process。 / Validates a specific candidate in an isolated V8 without mutating the serving Process.
    pub fn preflight_candidate(
        &self,
        js_event_loop: &tokio::runtime::Runtime,
        runtime: &mut JsRuntime,
        candidate: &HotfixCandidate,
    ) -> Result<()> {
        load_es_module(js_event_loop, runtime, &self.model_specifier, true)
            .context("failed to load immutable Model bundle")?;
        let entrypoints = load_js_entrypoints(runtime)?;
        candidate
            .install(js_event_loop, runtime, &entrypoints)
            .map(|_| ())
    }

    /// 在正式 V8 中加载不可变 Model 和第一代 Hotfix。 / Loads immutable Model and the first Hotfix generation into the serving V8.
    pub fn install_initial(
        &self,
        js_event_loop: &tokio::runtime::Runtime,
        runtime: &mut JsRuntime,
    ) -> Result<JsEntrypoints> {
        load_es_module(js_event_loop, runtime, &self.model_specifier, true)
            .context("failed to load immutable Model bundle")?;
        let entrypoints = load_js_entrypoints(runtime)?;
        let result = self
            .initial_hotfix
            .install(js_event_loop, runtime, &entrypoints)?;
        tracing::info!(
            target: "tiangz::hotfix",
            bundle_version = %result.bundle_version,
            status = %result.status_json,
            "initial Hotfix generation committed"
        );
        Ok(entrypoints)
    }
}

impl HotfixCandidate {
    pub fn bundle_version(&self) -> &str {
        &self.manifest.bundle_version
    }

    /// 在已经排空的正式 V8 中求值并事务提交候选；任何失败都会 Abort 暂存区。 / Evaluates and transactionally commits the candidate in a drained serving V8; every failure aborts staging.
    pub fn install(
        &self,
        js_event_loop: &tokio::runtime::Runtime,
        runtime: &mut JsRuntime,
        entrypoints: &JsEntrypoints,
    ) -> Result<HotfixInstallResult> {
        let begin_at = Instant::now();
        call_js_begin_hotfix(js_event_loop, runtime, entrypoints, &self.manifest_json)?;
        let begin_ms = elapsed_ms(begin_at);

        let eval_at = Instant::now();
        let specifier = self.specifier()?;
        if let Err(error) =
            runtime.execute_script(specifier.to_string(), self.hotfix_source.clone())
        {
            let _ = call_js_abort_hotfix(js_event_loop, runtime, entrypoints, &error.to_string());
            return Err(error).context("Hotfix candidate script evaluation failed");
        }
        let candidate_eval_ms = elapsed_ms(eval_at);

        let commit_at = Instant::now();
        match call_js_commit_hotfix(js_event_loop, runtime, entrypoints) {
            Ok(status_json) => Ok(HotfixInstallResult {
                bundle_version: self.manifest.bundle_version.clone(),
                status_json,
                timings: HotfixInstallTimings {
                    begin_ms,
                    candidate_eval_ms,
                    commit_ms: elapsed_ms(commit_at),
                },
            }),
            Err(error) => {
                let _ =
                    call_js_abort_hotfix(js_event_loop, runtime, entrypoints, &error.to_string());
                Err(error).context("Hotfix candidate commit failed")
            }
        }
    }

    fn specifier(&self) -> Result<ModuleSpecifier> {
        ModuleSpecifier::from_file_path(&self.hotfix_path).map_err(|_| {
            anyhow::anyhow!(
                "failed to convert {} to a file URL",
                self.hotfix_path.display()
            )
        })
    }
}

fn verify_hotfix_contract(
    model: &ModelManifest,
    hotfix_bytes: &[u8],
    hotfix: &HotfixManifest,
) -> Result<()> {
    verify_bytes_hash(hotfix_bytes, &hotfix.hotfix_hash, "Hotfix")?;
    require_equal(
        "modelFingerprint",
        &model.model_fingerprint,
        &hotfix.model_fingerprint,
    )?;
    require_equal(
        "modelSourceHash",
        &model.model_source_hash,
        &hotfix.model_source_hash,
    )?;
    require_equal(
        "protocolFingerprint",
        &model.protocol_fingerprint,
        &hotfix.protocol_fingerprint,
    )?;
    require_equal(
        "stableCoreApiHash",
        &model.stable_core_api_hash,
        &hotfix.stable_core_api_hash,
    )?;
    require_equal(
        "nativeSchemaHash",
        &model.native_schema_hash,
        &hotfix.native_schema_hash,
    )?;
    require_equal("buildMode", &model.build_mode, &hotfix.build_mode)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let text =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("failed to parse {}", path.display()))
}

fn verify_hash(path: &Path, expected: &str, kind: &str) -> Result<()> {
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    verify_bytes_hash(&bytes, expected, kind)
}

fn verify_bytes_hash(bytes: &[u8], expected: &str, kind: &str) -> Result<()> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        bail!(
            "{kind} bundle hash mismatch: expected {expected}, actual {actual}; rebuild the complete Model/Hotfix pair"
        );
    }
    Ok(())
}

fn decode_hotfix_source(path: &Path, bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes)
        .with_context(|| format!("Hotfix script is not valid UTF-8: {}", path.display()))
}

fn require_equal(name: &str, model: &str, hotfix: &str) -> Result<()> {
    if model != hotfix {
        bail!(
            "Hotfix cannot change {name}: active Model={model}, candidate Hotfix={hotfix}; restart the Process with a complete deployment"
        );
    }
    Ok(())
}

fn elapsed_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1_000.0
}
