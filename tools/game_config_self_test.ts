import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  GameConfigFingerprint as clientFingerprint,
  GameConfigs as clientConfigs,
} from "../client_sdk/typescript/Generated/Config";
import {
  BuffConflictPolicy,
  BuffRefreshStatePolicy,
  BuffRefreshTickPolicy,
  BuffStackScope,
  GameConfigRegistry,
  GameConfigs as serverConfigs,
  SkillAutoAttackPolicy,
  SkillDelivery,
  SkillEffectTarget,
  SkillMovementPolicy,
  SkillTargetRelation,
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
  assert.equal(player.initialMp, 100);
  assert.equal(player.maxMp, 100);
  assert.equal(player.attackRange, 2.5);
  assert.equal(player.initialMapId_ref, serverConfigs.MapConfig.Get(1));
  assert.equal(
    player.initialItemConfigId_ref,
    serverConfigs.ItemConfig.Get(player.initialItemConfigId),
  );
  assert.equal(serverConfigs.MapConfig.GetAll().length, 5);
  assert.equal(serverConfigs.MapConfig.Get(1).spatialMode, 1);
  assert.equal(serverConfigs.MapConfig.Get(1).depthCells, 150);
  assert.equal(serverConfigs.MapConfig.Get(1).cellSizeMeters, 1);
  assert.equal(serverConfigs.MapConfig.Get(1).aoiConfigId_ref?.gridSizeCells, 15);
  assert.equal(serverConfigs.MapConfig.Get(1).entryPlayersPerTick, 1);
  assert.equal(serverConfigs.MapConfig.Get(1).entryQueueCapacity, 10_000);
  assert.equal(serverConfigs.MapConfig.Get(1015).widthCells, 225);
  assert.equal(serverConfigs.MapConfig.Get(1020).widthCells, 300);
  const monsterA = serverConfigs.MonsterConfig.Get(1);
  const monsterB = serverConfigs.MonsterConfig.Get(2);
  assert.equal(monsterA.maxHp, 100);
  assert.equal(monsterB.maxHp, 100);
  assert.equal(monsterA.attackRange, 2.5);
  assert.equal(monsterB.attackRange, 2.5);
  assert.equal(monsterA.respawnSeconds, 10);
  assert.equal(monsterB.respawnSeconds, 10);
  assert.equal("respawnSeconds" in serverConfigs.MonsterAreaConfig.Get(10004), false);
  assert.equal("corpseLifetimeSeconds" in serverConfigs.MonsterAreaConfig.Get(10004), false);
  const navigationMap = serverConfigs.MapConfig.Get(100);
  assert.equal(navigationMap.spatialMode, 2);
  assert.equal(navigationMap.navigationAsset, "navigation/maps/demo_3d/generated/navigation.bin");
  assert.equal(navigationMap.navigationVersion, "demo-3d-v2");
  assert.match(navigationMap.navigationHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    [navigationMap.spawnX, navigationMap.spawnY, navigationMap.spawnZ],
    [-3, 1, -18],
  );
  assert.equal(navigationMap.aoiConfigId, 2);
  assert.deepEqual(
    [navigationMap.aoiConfigId_ref?.enterRangeGrids, navigationMap.aoiConfigId_ref?.detachRangeGrids],
    [7, 9],
  );
  assert.equal(
    Math.abs(navigationMap.spawnX) <= 3
      && Math.abs(navigationMap.spawnZ) <= 5
      && navigationMap.spawnY < 3,
    false,
    "Map 100 spawn must not overlap the central graybox obstacle",
  );
  const starterMonsterAreas = serverConfigs.MonsterAreaConfig.GetAll()
    .filter((area) => area.mapConfigId === 100)
    .sort((left, right) => left.id - right.id);
  assert.deepEqual(
    starterMonsterAreas.map((area) => [area.id, area.monsterConfigId, area.spawnX, area.spawnZ]),
    [
      [10004, 1, -18, 18],
      [10005, 1, 18, 18],
      [10006, 2, -18, -18],
      [10007, 2, 18, -18],
      [10008, 1, 0, 18],
    ],
  );
  assert.equal(serverConfigs.QuestObjectiveConfig.Get(5101).requiredCount, 5);
  assert.equal(serverConfigs.QuestObjectiveConfig.Get(5105).targetConfigId, 2);
  assert.equal(serverConfigs.QuestObjectiveConfig.Get(5105).requiredCount, 5);
  assert.deepEqual(serverConfigs.QuestConfig.Get(5001).rewardActionParams, [1001, 10]);
  assert.deepEqual(serverConfigs.QuestConfig.Get(5005).rewardActionParams, [1002, 10]);
  assert.deepEqual(serverConfigs.QuestConfig.Get(5005).requiredQuestIds, [5001]);
  assert.deepEqual(
    [...serverConfigs.QuestConfig.GetAll()]
      .sort((left, right) => left.id - right.id)
      .map((quest) => [quest.id, quest.autoAccept]),
    [[5001, false], [5002, false], [5003, false], [5004, false], [5005, false]],
  );
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
  assert.equal(serverConfigs.ItemConfig.Get(1001).useEffect, 2);
  assert.deepEqual(serverConfigs.ItemConfig.Get(1001).useParams, [6, 150]);
  assert.equal(serverConfigs.ItemConfig.Get(1001).cooldownMs, 30_000);
  assert.equal(serverConfigs.ItemConfig.Get(1001).globalCooldownMs, 1_000);
  assert.equal(clientConfigs.ItemConfig.Get(1001).icon, "UI/Icons/Items/1001");
  assert.equal(serverConfigs.ItemConfig.Get(1002).useEffect, 1);
  assert.deepEqual(serverConfigs.ItemConfig.Get(1002).useParams, [2001]);
  assert.equal(serverConfigs.ItemConfig.Get(1002).cooldownMs, 30_000);
  assert.equal(serverConfigs.ItemConfig.Get(1002).globalCooldownMs, 1_000);
  assert.equal(clientConfigs.ItemConfig.Get(1002).icon, "UI/Icons/Items/1002");
  assert.equal(serverConfigs.BuffConfig.Get(2001).tickIntervalMs, 3_000);
  assert.equal(serverConfigs.BuffConfig.Get(2001).tickActionType, 6);
  assert.deepEqual(serverConfigs.BuffConfig.Get(2001).tickActionParams, [50]);
  const chilled = serverConfigs.BuffConfig.Get(4001);
  assert.equal(chilled.stackScope, BuffStackScope.Target);
  assert.equal(chilled.conflictPolicy, BuffConflictPolicy.Refresh);
  assert.equal(chilled.refreshSource, true);
  assert.equal(chilled.refreshTickPolicy, BuffRefreshTickPolicy.KeepCadence);
  assert.deepEqual(chilled.addActionParams, [30_003, -40]);
  const burning = serverConfigs.BuffConfig.Get(4002);
  assert.equal(burning.stackScope, BuffStackScope.Source);
  assert.equal(burning.conflictPolicy, BuffConflictPolicy.Refresh);
  assert.equal(burning.tickIntervalMs, 1_000);
  const shield = serverConfigs.BuffConfig.Get(4003);
  assert.equal(shield.conflictPolicy, BuffConflictPolicy.Replace);
  assert.equal(shield.refreshRuntimeState, BuffRefreshStatePolicy.Reset);
  assert.equal(shield.addActionType, 5);
  assert.deepEqual(shield.addActionParams, [200]);
  assert.equal(serverConfigs.BuffConfig.Get(4004).conflictPolicy, BuffConflictPolicy.Reject);
  const fortitude = serverConfigs.BuffConfig.Get(4005);
  assert.equal(fortitude.conflictPolicy, BuffConflictPolicy.HigherWins);
  assert.equal(fortitude.conflictPriority, 1);
  assert.deepEqual(fortitude.addActionParams, [10_002, 500]);
  const frostbolt = serverConfigs.SkillConfig.Get(3001);
  assert.equal(frostbolt.targetRelation, SkillTargetRelation.Enemy);
  assert.equal(frostbolt.delivery, SkillDelivery.Projectile);
  assert.equal(frostbolt.movementPolicy, SkillMovementPolicy.InterruptWhileCasting);
  assert.equal(frostbolt.autoAttackPolicy, SkillAutoAttackPolicy.ResetOnStart);
  assert.equal(frostbolt.projectileSpeedMetersPerSecond, 20);
  assert.equal(frostbolt.rangeMeters, 30);
  assert.equal(serverConfigs.SkillConfig.Get(3002).rangeMeters, 10);
  assert.equal(serverConfigs.SkillConfig.Get(3003).rangeMeters, 30);
  const frostboltEffects = serverConfigs.SkillEffectConfig.GetAll()
    .filter((effect) => effect.skillId === frostbolt.id)
    .sort((left, right) => left.order - right.order);
  assert.equal(frostboltEffects.length, 2);
  assert.equal(frostboltEffects[0].target, SkillEffectTarget.PrimaryTarget);
  assert.deepEqual(frostboltEffects[0].actionParams, [50, 2]);
  assert.deepEqual(frostboltEffects[1].actionParams, [4001]);
  assert.equal(serverConfigs.BuffConfig.Get(4002).tickActionType, 4);
  assert.deepEqual(serverConfigs.BuffConfig.Get(4002).tickActionParams, [5, 3]);
  assert.throws(
    () => serverConfigs.MapConfig.Get(999_999),
    /game config not found/,
  );

  const clientPlayer = clientConfigs.PlayerConfig.Get(1);
  assert.equal(clientPlayer.initialMp, 100);
  assert.equal(clientPlayer.maxMp, 100);
  assert.equal(clientPlayer.attackRange, 2.5);
  assert.equal(clientPlayer.initialMapId_ref, clientConfigs.MapConfig.Get(1));
  assert.equal("initialItemConfigId" in clientPlayer, false);
  assert.equal("initialItemCount" in clientPlayer, false);
  assert.equal("description" in serverConfigs.ItemConfig.Get(1001), false);
  assert.equal(clientConfigs.ItemConfig.Get(1001).description.length > 0, true);
  assert.equal("description" in clientConfigs.BuffConfig.Get(4001), false);
  assert.equal("stackGroup" in clientConfigs.BuffConfig.Get(4001), false);
  assert.equal(clientConfigs.SkillConfig.Get(3004).name, "真言术·盾");
  assert.equal("movementPolicy" in clientConfigs.SkillConfig.Get(3004), false);
  assert.equal("SkillEffectConfig" in clientConfigs, false);
  assert.equal(Object.isFrozen(player), true);
  assert.equal(Object.isFrozen(serverConfigs.PlayerConfig.GetAll()), true);

  const oldItem = serverConfigs.ItemConfig.Get(1001);
  const changed = JSON.parse(dataJson) as Record<string, Array<Record<string, unknown>>>;
  const changedItem = changed.game_tbitemconfig.find((item) => item.id === 1001);
  assert.ok(changedItem);
  changedItem.use_params = [6, 77];
  GameConfigRegistry.Install(
    JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "a".repeat(64) }),
    JSON.stringify(changed),
  );
  assert.deepEqual(oldItem.useParams, [6, 150]);
  assert.deepEqual(serverConfigs.ItemConfig.Get(1001).useParams, [6, 77]);

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
  assert.deepEqual(serverConfigs.ItemConfig.Get(1001).useParams, [6, 77]);

  const invalidItemCooldown = structuredClone(changed);
  invalidItemCooldown.game_tbitemconfig[0].cooldown_ms = -1;
  assert.throws(
    () => GameConfigRegistry.Install(
      JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "0".repeat(64) }),
      JSON.stringify(invalidItemCooldown),
    ),
    /invalid cooldown values/,
  );

  const invalidBuffPriority = structuredClone(changed);
  const fortitudeRow = invalidBuffPriority.game_tbbuffconfig.find((buff) => buff.id === 4005);
  assert.ok(fortitudeRow);
  fortitudeRow.conflict_priority = 0;
  assert.throws(
    () => GameConfigRegistry.Install(
      JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "7".repeat(64) }),
      JSON.stringify(invalidBuffPriority),
    ),
    /HigherWins requires a positive conflict priority/,
  );

  const duplicateSkillOrder = structuredClone(changed);
  const frostboltRows = duplicateSkillOrder.game_tbskilleffectconfig
    .filter((effect) => effect.skill_id === 3001);
  assert.equal(frostboltRows.length, 2);
  frostboltRows[1].order = frostboltRows[0].order;
  assert.throws(
    () => GameConfigRegistry.Install(
      JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "6".repeat(64) }),
      JSON.stringify(duplicateSkillOrder),
    ),
    /duplicate effect order/,
  );

  const invalidSkillAction = structuredClone(changed);
  invalidSkillAction.game_tbskilleffectconfig[0].action_type = 6;
  invalidSkillAction.game_tbskilleffectconfig[0].action_params = [-1];
  assert.throws(
    () => GameConfigRegistry.Install(
      JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "5".repeat(64) }),
      JSON.stringify(invalidSkillAction),
    ),
    /Heal needs a non-negative amount/,
  );

  const invalidItemAction = structuredClone(changed);
  invalidItemAction.game_tbitemconfig[0].use_params = [6, -1];
  assert.throws(
    () => GameConfigRegistry.Install(
      JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "4".repeat(64) }),
      JSON.stringify(invalidItemAction),
    ),
    /Heal needs a non-negative amount/,
  );

  console.log("game config self-test passed");
}

main();
