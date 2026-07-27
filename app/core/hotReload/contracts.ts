export interface HotfixManifest {
  formatVersion: 1;
  bundleVersion: string;
  modelFingerprint: string;
  modelSourceHash: string;
  protocolFingerprint: string;
  stableCoreApiHash: string;
  nativeSchemaHash: string;
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
