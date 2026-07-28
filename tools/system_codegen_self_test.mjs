import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const cases = [
  ["PlayerUnitSystem.d.ts", ["Move(request: MovePlayer): boolean;", "Snapshot(): PlayerSnapshot;"]],
  ["LoginComponentSystem.d.ts", ["Login(request: C2S_Login): S2C_Login;"]],
  ["ItemComponentSystem.d.ts", [
    "GetItem(itemId: number): ItemView | undefined;",
    "UseItem(itemId: number): ItemSnapshot;",
  ]],
  ["NumericComponentSystem.d.ts", [
    "Get(type: NumericTypeValue): number;",
    "Set(type: NumericTypeValue, value: number): void;",
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
  "app/model/demo/map/PlayerUnit.ts",
  "app/model/demo/login/LoginComponent.ts",
  "app/model/demo/item/ItemComponent.ts",
  "app/model/demo/numeric/NumericComponent.ts",
];
for (const file of modelFiles) {
  const content = await readFile(path.join(root, file), "utf8");
  if (content.includes("System is not installed")) {
    throw new Error(`${file} still contains a handwritten System stub`);
  }
}

const fixtureModelDir = path.join(root, "app", "model", "demo", "__lifecycle_codegen_fixture__");
const fixtureHotfixDir = path.join(root, "app", "hotfix", "demo", "__lifecycle_codegen_fixture__");
const fixtureModel = path.join(fixtureModelDir, "LifecycleContractFixture.ts");
const fixtureSystem = path.join(fixtureHotfixDir, "LifecycleContractFixtureSystem.ts");
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
import { LifecycleContractFixture, systemFor } from "#tiangz/model";
@systemFor(LifecycleContractFixture)
export class LifecycleContractFixtureSystem extends LifecycleContractFixture {
  protected override Awake(): void {}
}
`, { encoding: "utf8", flag: "wx" });

  const failed = runCodegen();
  if (failed.status === 0 || !failed.stderr.includes("requires lifecycle method OnDestroy")) {
    throw new Error(`codegen accepted an incomplete lifecycle System:\n${failed.stderr}`);
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
} finally {
  await rm(fixtureModelDir, { recursive: true, force: true });
  await rm(fixtureHotfixDir, { recursive: true, force: true });
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
