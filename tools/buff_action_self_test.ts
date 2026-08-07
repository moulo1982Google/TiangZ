import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { InitializeGameSingletons } from "../app/core/runtime/Game";
import { ProcessHost } from "../app/core/runtime/host";
import { Scene } from "../app/core/runtime/entities";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import { TimeSystem } from "../app/core/runtime/TimeSystem";
import { TimerSystem } from "../app/core/runtime/TimerSystem";
import { actor, scene } from "../app/core/runtime/metadata";
import type { NativeHostOpsApi } from "../app/generated/model/native/NativeOps";
import { NativeUnitRef } from "../app/generated/model/native/NativeUnitRef";
import { GameConfigRegistry, GameConfigs } from "../app/generated/model/config";
import { ActionType } from "../app/model/demo/action/ActionType";
import { BuffComponent } from "../app/model/demo/buff/BuffComponent";
import { CombatComponent } from "../app/model/demo/combat/CombatComponent";
import { NumericComponent } from "../app/model/demo/numeric/NumericComponent";
import { IsDerivedNumericType, NumericType } from "../app/model/demo/numeric/NumericType";
import { ActorUnit } from "../app/core/runtime/Unit";

@scene({ sceneType: "BuffTest" })
class BuffTestScene extends Scene {}

@actor({ mailbox: "ordered" })
class BuffTestUnit extends ActorUnit {}

void main();

async function main(): Promise<void> {
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 11, workerId: 2 },
  );
  const manifestPath = path.resolve("game_config/generated/game-config.manifest.json");
  const dataPath = path.resolve("game_config/generated/server.json");
  GameConfigRegistry.Install(
    readFileSync(manifestPath, "utf8"),
    readFileSync(dataPath, "utf8"),
  );

  HotfixSystem.Begin(testHotfixManifest());
  await import("../app/hotfix/demo/numeric/NumericComponentSystem");
  await import("../app/hotfix/demo/combat/CombatComponentSystem");
  await import("../app/hotfix/demo/buff/BuffSystem");
  await import("../app/hotfix/demo/buff/BuffComponentSystem");
  HotfixSystem.Commit();

  const host = new ProcessHost("buff-action-self-test");
  const scene = host.spawnScene("buff", BuffTestScene);
  const unit = scene.SpawnActor(1, BuffTestUnit);
  installNativeHostOps();
  unit.AddComponent(NativeUnitRef, { id: 1, instanceId: unit.InstanceId, mapId: 1 });
  unit.AddComponent(NumericComponent, {
    [NumericType.CurrentHp]: 1n,
    [NumericType.MaxHpBase]: 200n,
    [NumericType.CurrentMp]: 0n,
    [NumericType.MaxMpBase]: 100n,
  });
  unit.AddComponent(CombatComponent);
  const buffs = unit.AddComponent(BuffComponent);

  assert.equal(GameConfigs.BuffConfig.Get(2001).tickIntervalMs, 3_000);
  const buff = buffs.AddBuff(2001);
  assert.equal(buffs.GetBuff(buff.Id as bigint), buff);
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.CurrentHp], 1n);

  // 触发一个3秒Tick；Actor Timer会经过Unit mailbox，因此每次推进后让出一次微任务。
  // Fire one three-second Tick. Actor timers pass through the Unit mailbox,
  // so yield once after each simulated update.
  const baseFrame = TimeSystem.Instance.FrameTime;
  const baseServer = TimeSystem.Instance.ServerNow;
  TimeSystem.Instance.__update(baseFrame + 3_000, baseServer + 3_000);
  TimerSystem.Instance.__update(baseFrame + 3_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.CurrentHp], 51n);

  // 传送只恢复纯值和时间戳，不重复执行Buff的AddAction；目标HP应从Numeric快照恢复为51，而不是再次加50。
  // Transfer restores value state and wall-clock deadlines without replaying AddAction; the target HP must be 51, not 101.
  const transfer = unit.CaptureTransfer();
  const target = scene.SpawnActor(2, BuffTestUnit);
  target.AddComponent(NativeUnitRef, { id: 2, instanceId: target.InstanceId, mapId: 1 });
  target.AddComponent(NumericComponent, {
    [NumericType.CurrentHp]: 1n,
    [NumericType.MaxHpBase]: 200n,
    [NumericType.CurrentMp]: 0n,
    [NumericType.MaxMpBase]: 100n,
  });
  target.AddComponent(CombatComponent);
  const targetBuffs = target.AddComponent(BuffComponent);
  target.RestoreTransfer(transfer);
  assert.equal(target.GetComponent(NumericComponent)[NumericType.CurrentHp], 51n);
  assert.equal(targetBuffs.GetBuff(buff.Id as bigint)?.Id, buff.Id);

  assert.equal(buffs.RemoveBuff(buff.Id as bigint, "test"), true);
  assert.equal(buffs.GetBuff(buff.Id as bigint), undefined);
  assert.equal(buffs.RemoveBuff(buff.Id as bigint), false);
  assert.equal(targetBuffs.RemoveBuff(buff.Id as bigint, "target-test"), true);
  assert.equal(targetBuffs.RemoveBuff(buff.Id as bigint), false);

  host.Dispose();
  SingletonRegistry.DestroyAll();
  console.log("buff action self-test passed", { actionTypes: ActionType });
}

function installNativeHostOps(): void {
  let nextHandle = 1;
  const entities = new Map<number, Float64Array>();
  const numerics = new Map<number, Map<number, bigint>>();
  (globalThis as typeof globalThis & { __etsNativeOps?: NativeHostOpsApi }).__etsNativeOps = {
    entityCreate: (_type, values) => {
      const handle = nextHandle++;
      entities.set(handle, values.slice());
      return handle;
    },
    entityDestroy: (handle) => { entities.delete(handle); numerics.delete(handle); },
    entityGetNumber: (handle, field) => entities.get(handle)![field - 1],
    entitySetNumber: (handle, field, value) => { entities.get(handle)![field - 1] = value; },
    numericAttach: (handle) => { numerics.set(handle, new Map()); },
    numericDetach: (handle) => { numerics.delete(handle); },
    numericGet: (handle, type) => numerics.get(handle)?.get(type) ?? 0n,
    numericSet: (handle, type, value) => {
      const values = numerics.get(handle)!;
      if (IsDerivedNumericType(type)) throw new Error("derived Numeric is read-only");
      if (values.get(type) === value) return false;
      values.set(type, value);
      const target = Math.trunc(type / 10);
      const suffix = type % 10;
      if (IsDerivedNumericType(target) && suffix >= 1 && suffix <= 3) {
        const base = values.get(target * 10 + 1) ?? 0n;
        const addition = values.get(target * 10 + 2) ?? 0n;
        const pct = values.get(target * 10 + 3) ?? 0n;
        values.set(target, (base + addition) * (100n + pct) / 100n);
      }
      return true;
    },
  } as NativeHostOpsApi;
}

function testHotfixManifest(): HotfixManifest {
  return {
    formatVersion: 1,
    bundleVersion: "buff-action-self-test",
    modelFingerprint: "buff-action-self-test",
    modelSourceHash: "buff-action-self-test",
    protocolFingerprint: "buff-action-self-test",
    stableCoreApiHash: "buff-action-self-test",
    nativeSchemaHash: "buff-action-self-test",
    hotfixHash: "buff-action-self-test",
    buildMode: "demo",
  };
}
