import { expect, test, vi } from "vitest";
import { MapComponent } from "../../app/model/mmorpg/map/MapComponent";
import { PlayerUnit } from "../../app/model/mmorpg/map/PlayerUnit";
import { SummonedUnit } from "../../app/model/mmorpg/summon/SummonedUnit";
import { NumericType } from "../../app/model/mmorpg/numeric/NumericType";
vi.mock("#tiangz/model", async original => ({
  ...await original<object>(), systemFor: () => () => undefined,
}));
import { SummonComponentSystem } from "../../app/hotfix/mmorpg/summon/SummonComponentSystem";

function fixture() {
  const owner = Object.create(PlayerUnit.prototype);
  const observer = Object.create(PlayerUnit.prototype);
  const summon = Object.create(SummonedUnit.prototype);
  const numeric = { [NumericType.CurrentMp]: 25n, [NumericType.MaxMp]: 25n };
  for (const [unit, id] of [[owner, 7], [observer, 8], [summon, 9]] as const) {
    Object.defineProperties(unit, {
      UnitId: { value: id }, OwnerUnitId: { value: 7 },
      Snapshot: { value: () => ({ unitId: id, ownerUnitId: 7, numerics: [
        { unitId: id, numericType: NumericType.CurrentHp, value: 50n },
        { unitId: id, numericType: NumericType.CurrentMp, value: numeric[NumericType.CurrentMp] },
        { unitId: id, numericType: NumericType.MaxMp, value: numeric[NumericType.MaxMp] },
      ] }) },
      GetComponent: { value: () => ({ ...numeric, SnapshotPublic: () => [] }) },
      DomainScene: { value: () => ({ TryGetComponent: () => undefined }) },
    });
  }
  const units = new Map([[7, owner], [8, observer], [9, summon]]);
  const publish = vi.fn().mockResolvedValue(undefined);
  const privatePublish = vi.fn().mockResolvedValue(undefined);
  const map = Object.create(MapComponent.prototype);
  Object.defineProperties(map, {
    requirePlayer: { value: vi.fn() }, requireMapUnit: { value: vi.fn() },
    units: { value: { Get: (id: number) => units.get(id) } },
    aoi: { value: { VisibleUnitIds: () => [7, 8, 9] } },
    entryMetrics: { value: new Proxy({}, { get: (o, k) => Reflect.get(o, k) ?? 0 }) },
    mapInstanceId: { value: 1n }, serverTick: { value: 10 },
    logger: { value: { warn: vi.fn() } },
    AudienceForRecipients: { value: (ids: number[]) => ({ routes: ids.map(id => ({ recipientId: id })) }) },
    broadcast: { value: { Publish: publish } },
    clientBroadcast: { value: { PublishMany: privatePublish } },
  });
  return { map, owner, observer, summon, units, numeric, publish, privatePublish };
}

test("shared entry cache never shares owned resources with another observer", () => {
  const f = fixture();
  const cache = { byAudience: new Map(), byUnit: new Map() };
  for (const player of [f.owner, f.observer, f.owner]) {
    const rows = f.map.BuildEntitySnapshots(player, cache);
    const resource = rows.find((row: any) => row.unitId === 9).numerics.find(
      (row: any) => row.numericType === NumericType.CurrentMp,
    );
    expect(resource?.value).toBe(player === f.owner ? 25n : undefined);
  }
});

test("AOI enter separates owner detail from the shared public audience", async () => {
  const f = fixture();
  await f.map.PublishAoiChanges([
    { observerId: 7, subjectId: 9, visible: true },
    { observerId: 8, subjectId: 9, visible: true },
  ]);
  for (const id of [7, 8]) {
    const call = f.publish.mock.calls.find(([audience]) => audience.routes.some((route: any) => route.recipientId === id));
    expect(call).toBeDefined();
    const mp = call![2].enters[0].numerics.find((row: any) => row.numericType === NumericType.CurrentMp);
    expect(mp?.value).toBe(id === 7 ? 25n : undefined);
  }
});

test("resource updates use the current player owner and stop after owner removal", async () => {
  const f = fixture();
  expect(await f.map.PublishOwnedUnitResources(f.summon)).toBe(true);
  const [audience, , rows] = f.privatePublish.mock.calls[0];
  expect(audience.UnitIds).toEqual([7]);
  expect(rows).toEqual([
    { unitId: 9, numericType: NumericType.CurrentMp, value: 25n },
    { unitId: 9, numericType: NumericType.MaxMp, value: 25n },
  ]);
  f.units.delete(7);
  expect(await f.map.PublishOwnedUnitResources(f.summon)).toBe(false);
  expect(f.privatePublish).toHaveBeenCalledTimes(1);
});

test("changed resources retry failed delivery and coalesce unchanged state", async () => {
  const f = fixture();
  const publish = vi.fn().mockRejectedValueOnce(new Error("route unavailable")).mockResolvedValue(true);
  const component = {
    units: { Get: (id: number) => f.units.get(id) },
    map: { PublishOwnedUnitResources: publish }, DomainScene: () => ({ logger: { warn: vi.fn() } }),
  };
  const state = { summon: f.summon, ownerUnitId: 7 };
  const tick = async () => {
    (SummonComponentSystem.prototype as any).PublishResourceChanges.call(component, state);
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  await tick();
  await tick();
  expect(publish).toHaveBeenCalledTimes(2);
  await tick();
  expect(publish).toHaveBeenCalledTimes(2);
  f.numeric[NumericType.CurrentMp] = 15n;
  await tick();
  expect(publish).toHaveBeenCalledTimes(3);
  f.numeric[NumericType.CurrentMp] = 18n;
  await tick();
  expect(publish).toHaveBeenCalledTimes(4);
  f.numeric[NumericType.MaxMp] = 30n;
  await tick();
  expect(publish).toHaveBeenCalledTimes(5);
  f.units.delete(7);
  f.numeric[NumericType.CurrentMp] = 20n;
  await tick();
  expect(publish).toHaveBeenCalledTimes(5);
});
