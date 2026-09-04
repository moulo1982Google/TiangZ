import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { InitializeGameSingletons } from "../app/core/runtime/Game";
import { GameConfigRegistry, SpatialMode } from "../app/generated/model/config";
import { NativeUnitRef } from "../app/generated/model/native/NativeUnitRef";
import { CombatComponent } from "../app/model/mmorpg/combat/CombatComponent";
import { CombatStateComponent } from "../app/model/mmorpg/combat/CombatStateComponent";
import { MapComponent } from "../app/model/mmorpg/map/MapComponent";
import { PositionComponent } from "../app/model/mmorpg/map/PositionComponent";
import { NumericComponent } from "../app/model/mmorpg/numeric/NumericComponent";
import { NumericType } from "../app/model/mmorpg/numeric/NumericType";
import { SkillComponent } from "../app/model/mmorpg/skill/SkillComponent";

void main();

async function main(): Promise<void> {
  const gameConfigDirectory = path.resolve("game_config/generated");
  GameConfigRegistry.Install(
    readFileSync(path.join(gameConfigDirectory, "game-config.manifest.json"), "utf8"),
    readFileSync(path.join(gameConfigDirectory, "server.json"), "utf8"),
  );
  InitializeGameSingletons();
  HotfixSystem.Begin(testHotfixManifest());
  const { PlayerUnitSystem } = await import("../app/hotfix/mmorpg/map/PlayerUnitSystem");

  let resetMovementHandle = 0;
  (globalThis as typeof globalThis & { __etsNativeOps?: unknown }).__etsNativeOps = {
    unitResetMovement(handle: number): void {
      resetMovementHandle = handle;
    },
  };

  const native = { alive: 0, Handle: 77 };
  const numeric = {
    [NumericType.CurrentHp]: 0n,
    [NumericType.MaxHp]: 100n,
    [NumericType.CurrentMp]: 0n,
    [NumericType.MaxMp]: 200n,
  };
  const position = {
    x: 12,
    y: 3,
    z: 9,
    yaw: 1,
    SetNavMeshWorldPosition(x: number, y: number, z: number, yaw: number): void {
      this.x = x;
      this.y = y;
      this.z = z;
      this.yaw = yaw;
    },
  };
  let combatClears = 0;
  let attackStops = 0;
  let castInterrupts = 0;
  const combatState = { Clear(): void { combatClears += 1; } };
  const combat = { ToggleAutoAttack(): void { attackStops += 1; } };
  const skill = { Interrupt(): void { castInterrupts += 1; } };
  const map = {
    SpatialProfile: {
      spatialMode: SpatialMode.NavMesh3D,
      spawnX: -3,
      spawnY: 1,
      spawnZ: -18,
      spawnYaw: 0,
    },
    ProjectPosition(point: { x: number; y: number; z: number }): typeof point {
      return point;
    },
  };
  const fakePlayer = {
    mapId: 100,
    GetComponent(componentType: unknown): unknown {
      if (componentType === NativeUnitRef) return native;
      if (componentType === NumericComponent) return numeric;
      if (componentType === PositionComponent) return position;
      if (componentType === CombatStateComponent) return combatState;
      if (componentType === CombatComponent) return combat;
      if (componentType === SkillComponent) return skill;
      throw new Error(`unexpected component: ${String(componentType)}`);
    },
    DomainScene(): { GetComponent(componentType: unknown): unknown } {
      return {
        GetComponent(componentType: unknown): unknown {
          if (componentType === MapComponent) return map;
          throw new Error(`unexpected scene component: ${String(componentType)}`);
        },
      };
    },
  };
  const release = (PlayerUnitSystem.prototype as unknown as {
    ReleaseDeadPlayer(request?: {
      recoveryPosition?: { x: number; y: number; z: number; yaw: number };
    }): {
      released: boolean;
      x: number;
      y: number;
      z: number;
      yaw: number;
      health: bigint;
      maxHealth: bigint;
      mana: bigint;
      maxMana: bigint;
    };
  }).ReleaseDeadPlayer;
  const revive = (PlayerUnitSystem.prototype as unknown as {
    RevivePlayer(): {
      revived: boolean;
      x: number;
      y: number;
      z: number;
      yaw: number;
      health: bigint;
      maxHealth: bigint;
      mana: bigint;
      maxMana: bigint;
    };
  }).RevivePlayer;

  const released = release.call(fakePlayer, {
    recoveryPosition: { x: 5, y: 2, z: -7, yaw: 0.5 },
  });
  assert.deepEqual(released, {
    released: true,
    x: 5,
    y: 2,
    z: -7,
    yaw: 0.5,
    health: 0n,
    maxHealth: 100n,
    mana: 0n,
    maxMana: 200n,
  });
  assert.equal(native.alive, 0);

  const result = revive.call(fakePlayer);
  assert.deepEqual(result, {
    revived: true,
    x: 5,
    y: 2,
    z: -7,
    yaw: 0.5,
    health: 50n,
    maxHealth: 100n,
    mana: 100n,
    maxMana: 200n,
  });
  assert.equal(native.alive, 1);
  assert.equal(resetMovementHandle, 77);
  assert.equal(combatClears, 2);
  assert.equal(attackStops, 2);
  assert.equal(castInterrupts, 2);

  const duplicate = revive.call(fakePlayer);
  assert.equal(duplicate.revived, false);
  assert.equal(combatClears, 2);
  assert.equal(attackStops, 2);
  assert.equal(castInterrupts, 2);
  HotfixSystem.Abort("player revive self-test complete");
  console.log("[player-revive] self-test passed");
}

function testHotfixManifest(): HotfixManifest {
  return {
    formatVersion: 1,
    bundleVersion: "player-revive-self-test",
    modelFingerprint: "player-revive-self-test",
    modelSourceHash: "player-revive-self-test",
    protocolFingerprint: "player-revive-self-test",
    stableCoreApiHash: "player-revive-self-test",
    nativeSchemaHash: "player-revive-self-test",
    hotfixHash: "player-revive-self-test",
    buildMode: "demo",
  };
}
