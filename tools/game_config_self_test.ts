import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  GameConfigFingerprint as clientFingerprint,
  GameConfigs as clientConfigs,
} from "../client_sdk/typescript/Generated/Config";
import {
  GameConfigRegistry,
  GameConfigs as serverConfigs,
} from "../app/generated/model/config";
import {
  IsMapCapacityGridCrossingPlayer,
  MapCapacitySpeedCellsPerSecond,
} from "../app/hotfix/bench/MapCapacityLayout";

/** 验证Luban配置的查询、分端裁剪、引用解析和只读约束。 / Verifies Luban lookup, target filtering, references, and immutability. */
function main(): void {
  const generated = path.resolve("game_config/generated");
  const manifestJson = readFileSync(
    path.join(generated, "game-config.manifest.json"),
    "utf8",
  );
  const dataJson = readFileSync(path.join(generated, "server.json"), "utf8");
  const manifest = JSON.parse(manifestJson) as { dataFingerprint: string };
  GameConfigRegistry.Install(manifestJson, dataJson);
  assert.equal(manifest.dataFingerprint, clientFingerprint);

  const player = serverConfigs.PlayerConfig.Get(1);
  assert.equal(player.initialMapId_ref, serverConfigs.MapConfig.Get(1));
  assert.equal(
    player.initialItemConfigId_ref,
    serverConfigs.ItemConfig.Get(player.initialItemConfigId),
  );
  assert.equal(serverConfigs.MapConfig.GetAll().length, 4);
  assert.equal(serverConfigs.MapConfig.Get(1).spatialMode, 1);
  assert.equal(serverConfigs.MapConfig.Get(1).depthCells, 150);
  assert.equal(serverConfigs.MapConfig.Get(1).cellSizeMeters, 1);
  assert.equal(serverConfigs.MapConfig.Get(1).aoiConfigId_ref?.gridSizeCells, 15);
  assert.equal(serverConfigs.MapConfig.Get(1).entryPlayersPerTick, 1);
  assert.equal(serverConfigs.MapConfig.Get(1).entryQueueCapacity, 10_000);
  assert.equal(serverConfigs.MapConfig.Get(1015).widthCells, 225);
  assert.equal(serverConfigs.MapConfig.Get(1020).widthCells, 300);
  const defaultAoi = serverConfigs.AoiConfig.Get(1);
  const defaultSyncTiers = serverConfigs.AoiSyncTierConfig.GetAll()
    .filter((tier) => tier.aoiConfigId === defaultAoi.id)
    .sort((left, right) => left.rangeGrids - right.rangeGrids);
  assert.equal(defaultSyncTiers.length > 0, true);
  assert.equal(defaultSyncTiers.at(-1)?.rangeGrids, defaultAoi.detachRangeGrids);
  const crossingPlayers = Array.from(
    { length: 3_000 },
    (_, playerIndex) => playerIndex,
  ).filter((playerIndex) => IsMapCapacityGridCrossingPlayer(1, playerIndex, 1));
  assert.equal(crossingPlayers.length, 600);
  for (let gridIndex = 0; gridIndex < 100; gridIndex += 1) {
    const crossingInGrid = Array.from(
      { length: 30 },
      (_, slot) => gridIndex + slot * 100,
    ).filter((playerIndex) => IsMapCapacityGridCrossingPlayer(1, playerIndex, 1));
    assert.equal(crossingInGrid.length, 6);
  }
  assert.equal(MapCapacitySpeedCellsPerSecond(1, 0, 1), 7.5);
  assert.equal(MapCapacitySpeedCellsPerSecond(1, 100, 1), 1);
  assert.equal(serverConfigs.ItemConfig.TryGet(999_999), undefined);
  assert.throws(
    () => serverConfigs.MapConfig.Get(999_999),
    /game config not found/,
  );

  const clientPlayer = clientConfigs.PlayerConfig.Get(1);
  assert.equal(clientPlayer.initialMapId_ref, clientConfigs.MapConfig.Get(1));
  assert.equal("initialItemConfigId" in clientPlayer, false);
  assert.equal("initialItemCount" in clientPlayer, false);
  assert.equal("description" in serverConfigs.ItemConfig.Get(1001), false);
  assert.equal(clientConfigs.ItemConfig.Get(1001).description.length > 0, true);
  assert.equal(Object.isFrozen(player), true);
  assert.equal(Object.isFrozen(serverConfigs.PlayerConfig.GetAll()), true);

  const oldItem = serverConfigs.ItemConfig.Get(1001);
  const changed = JSON.parse(dataJson) as Record<string, Array<Record<string, unknown>>>;
  const changedItem = changed.game_tbitemconfig.find((item) => item.id === 1001);
  assert.ok(changedItem);
  changedItem.restore_hp = 77;
  GameConfigRegistry.Install(
    JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "a".repeat(64) }),
    JSON.stringify(changed),
  );
  assert.equal(oldItem.restoreHp, 50);
  assert.equal(serverConfigs.ItemConfig.Get(1001).restoreHp, 77);

  assert.throws(
    () => GameConfigRegistry.Install(
      JSON.stringify({
        ...JSON.parse(manifestJson),
        dataFingerprint: "d".repeat(64),
        coldDataFingerprint: "e".repeat(64),
      }),
      dataJson,
    ),
    /cold game config changed/,
  );

  const invalidNavMesh = structuredClone(changed);
  invalidNavMesh.game_tbmapconfig[0].spatial_mode = 2;
  assert.throws(
    () => GameConfigRegistry.Install(
      JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "c".repeat(64) }),
      JSON.stringify(invalidNavMesh),
    ),
    /needs an asset, version, and lowercase SHA-256/,
  );

  const extendedAoi = structuredClone(changed);
  extendedAoi.game_tbaoiconfig[0].detach_range_grids = 7;
  extendedAoi.game_tbaoisynctierconfig.push({
    id: 3,
    aoi_config_id: 1,
    range_grids: 7,
    sync_hz: 1,
  });
  GameConfigRegistry.Install(
    JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "f".repeat(64) }),
    JSON.stringify(extendedAoi),
  );
  assert.equal(serverConfigs.AoiConfig.Get(1).detachRangeGrids, 7);
  assert.equal(serverConfigs.AoiSyncTierConfig.Get(3).syncHz, 1);

  const incompleteAoi = structuredClone(extendedAoi);
  incompleteAoi.game_tbaoisynctierconfig.pop();
  assert.throws(
    () => GameConfigRegistry.Install(
      JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "9".repeat(64) }),
      JSON.stringify(incompleteAoi),
    ),
    /outermost sync tier must equal Detach range/,
  );
  GameConfigRegistry.Install(
    JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "8".repeat(64) }),
    JSON.stringify(changed),
  );

  const invalid = structuredClone(changed);
  invalid.game_tbplayerconfig[0].initial_map_id = 999_999;
  assert.throws(
    () => GameConfigRegistry.Install(
      JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "b".repeat(64) }),
      JSON.stringify(invalid),
    ),
    /missing reference/,
  );
  assert.equal(serverConfigs.ItemConfig.Get(1001).restoreHp, 77);

  console.log("game config self-test passed");
}

main();
