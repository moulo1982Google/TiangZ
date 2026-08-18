import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const cases = [
  ["PlayerUnitSystem.d.ts", ["Move(request: MovePlayer): boolean;", "Snapshot(): PlayerSnapshot;"]],
  ["LoginComponentSystem.d.ts", ["Login(request: C2S_Login): Promise<S2C_Login>;"]],
  ["ItemComponentSystem.d.ts", [
    "GetItem(itemId: bigint): ItemView | undefined;",
    "UseItem(itemId: bigint): ItemSnapshot;",
  ]],
  ["NumericComponentSystem.d.ts", [
    "Get(type: NumericTypeValue): bigint;",
    "Set(type: NumericTypeValue, value: bigint): void;",
    "Snapshot(): UnitNumericDelta[];",
  ]],
];

for (const [file, expected] of cases) {
  const content = await readFile(
    path.join(root, "app", "generated", "bootstrap", "systems", file),
    "utf8",
  );
  for (const signature of expected) {
    if (!content.includes(signature)) {
      throw new Error(`${file} is missing generated signature: ${signature}`);
    }
  }
}

const modelFiles = [
  "app/model/mmorpg/map/PlayerUnit.ts",
  "app/model/mmorpg/login/LoginComponent.ts",
  "app/model/mmorpg/item/ItemComponent.ts",
  "app/model/mmorpg/numeric/NumericComponent.ts",
];
for (const file of modelFiles) {
  const content = await readFile(path.join(root, file), "utf8");
  if (content.includes("System is not installed")) {
    throw new Error(`${file} still contains a handwritten System stub`);
  }
}

const fixtureModelDir = path.join(root, "app", "model", "mmorpg", "__lifecycle_codegen_fixture__");
const fixtureHotfixDir = path.join(root, "app", "hotfix", "mmorpg", "__lifecycle_codegen_fixture__");
const fixtureModel = path.join(fixtureModelDir, "LifecycleContractFixture.ts");
const fixtureSystem = path.join(fixtureHotfixDir, "LifecycleContractFixtureSystem.ts");
const declarationSentinel = path.join(
  root,
  "app",
  "generated",
  "bootstrap",
  "systems",
  "EditorTrackingSentinel.d.ts",
);
try {
  await mkdir(fixtureModelDir, { recursive: true });
  await mkdir(fixtureHotfixDir, { recursive: true });
  await writeFile(fixtureModel, `
import { Component, component, lifecycle, transferable } from "../../../core/public";
@component()
@transferable()
@lifecycle({ awake: true, destroy: true, deserialize: true })
export class LifecycleContractFixture extends Component {}
`, { encoding: "utf8", flag: "wx" });
  await writeFile(fixtureSystem, `
import { LifecycleContractFixture, systemFor, type ITransfer } from "#tiangz/model";
@systemFor(LifecycleContractFixture)
export class LifecycleContractFixtureSystem extends LifecycleContractFixture implements ITransfer<number> {
  protected override Awake(): void {}
  CaptureTransfer(): number { return 1; }
  RestoreTransfer(_state: number): void {}
}
`, { encoding: "utf8", flag: "wx" });
  await writeFile(declarationSentinel, "// Preserve declarations until a generation succeeds.\n", {
    encoding: "utf8",
    flag: "wx",
  });

  const failed = runCodegen();
  if (failed.status === 0 || !failed.stderr.includes("requires lifecycle method OnDestroy")) {
    throw new Error(`codegen accepted an incomplete lifecycle System:\n${failed.stderr}`);
  }
  const preservedSentinel = await readFile(declarationSentinel, "utf8").catch(() => undefined);
  if (preservedSentinel === undefined) {
    throw new Error("failed codegen deleted the active declaration directory used by the editor");
  }

  await writeFile(fixtureSystem, `
import { LifecycleContractFixture, systemFor, type IDeserialize, type ITransfer } from "#tiangz/model";
@systemFor(LifecycleContractFixture)
export class LifecycleContractFixtureSystem extends LifecycleContractFixture implements IDeserialize, ITransfer<number> {
  protected override Awake(): void {}
  protected override OnDestroy(): void {}
  Deserialize(): void {}
  CaptureTransfer(): number { return 1; }
  RestoreTransfer(_state: number): void {}
}
`, "utf8");
  const passed = runCodegen();
  if (passed.status !== 0) {
    throw new Error(`codegen rejected a complete lifecycle System:\n${passed.stderr}`);
  }
  const staleSentinel = await readFile(declarationSentinel, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (staleSentinel !== undefined) {
    throw new Error("successful codegen did not prune an obsolete System declaration");
  }
} finally {
  await rm(fixtureModelDir, { recursive: true, force: true });
  await rm(fixtureHotfixDir, { recursive: true, force: true });
  await rm(declarationSentinel, { force: true });
  const restored = runCodegen();
  if (restored.status !== 0) {
    throw new Error(`failed to restore generated files after lifecycle fixture:\n${restored.stderr}`);
  }
}

process.stdout.write("System declaration codegen self-test passed\n");

function runCodegen() {
  return spawnSync(process.execPath, [path.join(root, "tools", "codegen_scenes.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
}
