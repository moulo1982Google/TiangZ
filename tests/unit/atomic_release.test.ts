import { expect, test } from "vitest";
import { HotfixSystem, hotfixFor, HotfixBindingStore } from "../../app/core/hotReload/HotfixSystem";
import { ModuleConfigRegistry } from "../../app/core/content/ModuleConfigRegistry";
import type { HotfixManifest } from "../../app/core/hotReload/contracts";

test("a release commits behavior and config together; failed staging or commit preserves the previous pair", () => {
  const hash = "a".repeat(64);
  const id = "org.example.atomic";
  ModuleConfigRegistry.__configure([{ moduleId: id, schemaFingerprint: hash,
    validate: tables => { if (typeof tables.cost !== "number") throw new Error("invalid cost"); } }]);
  const config = (cost: unknown) => [{ moduleId: id, schemaFingerprint: hash, dataFingerprint: hash, tables: { cost } }];
  const manifest = (version: string): HotfixManifest => ({ formatVersion: 1, bundleVersion: version,
    modelFingerprint: hash, modelSourceHash: hash, protocolFingerprint: hash, stableCoreApiHash: hash,
    nativeSchemaHash: hash, hotfixHash: hash, buildMode: "modules" });
  class Building { Rule(): number { return 0; } }
  class Old extends Building { override Rule(): number { return 1; } }
  class Next extends Building { override Rule(): number { return 2; } }
  const building = new Building();
  const bindings = new HotfixBindingStore<{ rule: () => number }>("release");
  const stage = (version: string, cost: number, implementation: typeof Old) => {
    HotfixSystem.Begin(manifest(version), ModuleConfigRegistry.__prepare(config(cost)));
    hotfixFor(Building)(implementation);
    bindings.Register("upgrade", { rule: () => cost });
  };
  stage("old", 10, Old);
  HotfixSystem.Commit();
  const previous = ModuleConfigRegistry.Get(id);
  stage("new", 20, Next);
  expect(building.Rule()).toBe(1);
  expect(ModuleConfigRegistry.Get(id)).toBe(previous);
  HotfixSystem.Commit();
  expect(building.Rule()).toBe(2);
  expect(bindings.Values()[0].rule()).toBe(20);
  expect(ModuleConfigRegistry.Get(id).tables.cost).toBe(20);
  expect(previous.tables.cost).toBe(10);
  const generation = HotfixSystem.Status().activeGeneration;
  const current = ModuleConfigRegistry.Get(id);
  expect(() => ModuleConfigRegistry.__prepare(config("broken"))).toThrow("invalid cost");
  stage("eval-failure", 30, Old);
  HotfixSystem.Abort("candidate threw while evaluating");
  expect(ModuleConfigRegistry.Get(id)).toBe(current);
  // 配置提交被拒绝发生在方法和 Handler 暂时安装之后，必须恢复两者。
  HotfixSystem.Begin(manifest("commit-failure"), () => { throw new Error("config commit rejected"); });
  hotfixFor(Building)(Old);
  bindings.Register("upgrade", { rule: () => 30 });
  expect(() => HotfixSystem.Commit()).toThrow("config commit rejected");
  expect(building.Rule()).toBe(2);
  expect(bindings.Values()[0].rule()).toBe(20);
  expect(ModuleConfigRegistry.Get(id)).toBe(current);
  expect(HotfixSystem.Status().activeGeneration).toBe(generation);
  // 缺少原有 Handler 时拒绝整套提交，不能提前发布新配置。
  HotfixSystem.Begin(manifest("missing-handler"), ModuleConfigRegistry.__prepare(config(99)));
  hotfixFor(Building)(Old);
  expect(() => HotfixSystem.Commit()).toThrow();
  expect(ModuleConfigRegistry.Get(id)).toBe(current);
  stage("rollback-old", 10, Old);
  HotfixSystem.Commit();
  expect(building.Rule()).toBe(1);
  expect(ModuleConfigRegistry.Get(id).tables.cost).toBe(10);
  expect(HotfixSystem.Status().activeGeneration).toBe(generation + 1);
});
