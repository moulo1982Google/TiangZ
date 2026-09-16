/** 安装已由Rust校验的空宿主配置；模块配置仍走ModuleConfigRegistry。 / Installs Rust-validated empty host config; module tables still use ModuleConfigRegistry. */
export function installEmptyHostConfig(expectedSchema: string, manifestJson: string, dataJson: string): string {
  const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  const data: unknown = JSON.parse(dataJson);
  if (manifest.formatVersion !== 2 || manifest.schemaFingerprint !== expectedSchema ||
      data === null || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 0) {
    throw new Error("module-only host rejects built-in game config; rebuild the matching host profile");
  }
  return JSON.stringify({ dataFingerprint: manifest.dataFingerprint,
    hotDataFingerprint: manifest.hotDataFingerprint, coldDataFingerprint: manifest.coldDataFingerprint });
}
