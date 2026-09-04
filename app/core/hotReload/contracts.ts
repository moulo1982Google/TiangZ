export interface HotfixManifest {
  formatVersion: 1;
  bundleVersion: string;
  modelFingerprint: string;
  modelSourceHash: string;
  protocolFingerprint: string;
  stableCoreApiHash: string;
  nativeSchemaHash: string;
  /** 构建期外置游戏模块依赖图；旧制品缺省为空图。 / Build-time external game-module dependency graph; absent on legacy artifacts. */
  moduleGraphHash?: string;
  hotfixHash: string;
  buildMode: "demo" | "bench";
}

export interface HotfixStatus {
  activeVersion?: string;
  activeGeneration: number;
  stagingVersion?: string;
  phase: "idle" | "staging" | "committing" | "rolling-back";
  lastError?: string;
}
