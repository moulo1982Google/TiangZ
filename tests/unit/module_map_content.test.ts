import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { MapContentProfileComponent, type MapContentDefinition } from "../../app/model/mmorpg/map/MapContentProfileComponent";
import { GameConfigRegistry, SpatialMode } from "../../app/generated/model/config";
import { PlayerPersistenceComponent } from "../../app/model/mmorpg/persistence/PlayerPersistenceComponent";

function definition(id = 31991): MapContentDefinition {
  return { id, entryPlayersPerTick: 4, entryQueueCapacity: 20,
    spatial: { spatialMode: SpatialMode.Grid2D, widthCells: 100, depthCells: 100, cellSizeMeters: 1,
      spawnX: 0, spawnY: 0, spawnZ: 0, spawnYaw: 0, navigationAsset: "", navigationHash: "" },
    aoi: { gridSizeCells: 10, enterRangeGrids: 3, detachRangeGrids: 5, tiers: [{rangeGrids:5,syncHz:10}] } };
}

test("module map catalog validates a whole batch, freezes nested inputs and seals before publication", () => {
  GameConfigRegistry.Install(readFileSync("game_config/generated/game-config.manifest.json", "utf8"), readFileSync("game_config/generated/server.json", "utf8"));
  const catalog = new MapContentProfileComponent();
  const value = definition();
  expect(() => catalog.Register("module", [value, {...definition(31992),entryQueueCapacity:0}])).toThrow();
  expect(catalog.Resolve(value.id)).toBeUndefined();
  catalog.Register("module", [value]);
  expect(catalog.Resolve(value.id)?.spatial).not.toBe(value.spatial);
  expect(Object.isFrozen(catalog.Resolve(value.id)?.aoi.tiers[0])).toBe(true);
  expect(() => catalog.Register("other", [value])).toThrow(/conflict/);
  expect(() => catalog.Register("module", [{...definition(31992),aoi:{...value.aoi,gridSizeCells:7}}])).toThrow(/AOI/);
  catalog.Seal();
  expect(() => catalog.Register("module", [definition(31993)])).toThrow(/sealed/);
});

test("local transfer carries module payload and preserves unknown extension state for later attachment", () => {
  const source = new PlayerPersistenceComponent();
  source.RegisterPersistenceExtension({id:"org.test.vitals",version:1,Capture:()=>new Uint8Array([0,42]),Restore:()=>{}});
  const captured = source.CaptureTransfer();
  const target = new PlayerPersistenceComponent();
  target.RestoreTransfer(captured);
  let restored: Uint8Array | undefined;
  target.RegisterPersistenceExtension({id:"org.test.vitals",version:1,Capture:()=>restored!,Restore:p=>{restored=p;}});
  expect(restored).toEqual(new Uint8Array([0,42]));
  captured.extensions![0]!.payload[1]=99;
  expect(restored![1]).toBe(42);
});
