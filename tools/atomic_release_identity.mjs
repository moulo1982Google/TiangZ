import { createHash } from "node:crypto";

// 顺序是跨 Rust/JS 的发布契约；Model 基线不同也不能复用同一不可变目录。
// Ordering is a Rust/JS contract; distinct Model baselines cannot share an immutable directory.
export const releaseIdentityFields = Object.freeze([
  "hotfixHash", "gameConfigHash", "modelFingerprint", "modelSourceHash", "protocolFingerprint",
  "stableCoreApiHash", "nativeSchemaHash", "gameConfigSchemaFingerprint", "moduleGraphHash", "buildMode",
]);

/** 绑定包版本、代码、完整配置及冻结契约。 / Binds package version, code, complete config and frozen contracts. */
export function atomicReleaseId(manifest) {
  const version = manifest.bundleVersion?.split("+")[0];
  if (!version || releaseIdentityFields.some(field => typeof manifest[field] !== "string" || !manifest[field])) {
    throw new Error("atomic release identity requires a version and all frozen contract fields");
  }
  return createHash("sha256").update([version, ...releaseIdentityFields.map(field => manifest[field])].join(":")).digest("hex");
}
