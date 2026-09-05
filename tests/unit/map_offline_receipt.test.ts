import { describe, expect, test, vi } from "vitest";
import { MapComponent } from "../../app/model/mmorpg/map/MapComponent";
import type { PlayerUnit } from "../../app/model/mmorpg/map/PlayerUnit";

function fixture() {
  const map = Object.create(MapComponent.prototype) as MapComponent;
  const record = vi.fn();
  const cleanup = vi.fn();
  const offline = vi.fn().mockResolvedValue(undefined);
  Object.defineProperties(map, {
    requirePlayer: { value: vi.fn() },
    MarkPlayerOffline: { value: offline },
    ScheduleOfflineCleanup: { value: cleanup },
    players: { value: { RecordOffline: record } },
    mapId: { value: 1 }, mapInstanceId: { value: 1n },
    logger: { value: { info: vi.fn(), warn: vi.fn() } },
  });
  const unit = { UnitId: 100, InstanceId: 200, Account: "ACCOUNT42", CharacterId: 7n,
    MapId: 1, MatchesGate: vi.fn().mockReturnValue(true) } as unknown as PlayerUnit;
  const request = { account: "ACCOUNT42", characterId: 7n, unitId: 100, mapId: 1,
    gateName: "gate", gateEpoch: 1n, reason: "character-logout" };
  return { map, unit, request, record, cleanup, offline };
}

describe("map offline evidence publication", () => {
  test("negative Location removal acknowledgement is not a completed offline", async () => {
    const f = fixture();
    const unlock = vi.fn().mockResolvedValue({ unlocked: true });
    Object.defineProperties(f.map, {
      DomainScene: { value: () => ({ GetComponent: () => ({ PlayerLeaving: vi.fn() }) }) },
      nextLocationOperation: { value: 1, writable: true },
      location: { value: {
        Resolve: vi.fn().mockResolvedValue({ found: true, location: { actorInstanceId: 200, revision: 1n } }),
        Lock: vi.fn().mockResolvedValue({}),
        Remove: vi.fn().mockResolvedValue({ removed: false }),
        Unlock: unlock,
      } },
    });
    Object.defineProperty(f.unit, "Offline", { value: vi.fn().mockResolvedValue(undefined) });
    await expect((MapComponent.prototype as any).MarkPlayerOffline.call(f.map, f.unit, "test-offline"))
      .rejects.toThrow("did not confirm offline removal");
    expect(unlock).toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });

  test("publishes only after successful save/removal and before deferred Actor cleanup", async () => {
    const f = fixture();
    let finish!: () => void;
    f.offline.mockImplementation(() => new Promise<void>(resolve => finish = resolve));
    const pending = f.map.PlayerOffline(f.unit, f.request);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
    finish();
    expect((await pending).removed).toBe(true);
    expect(f.record).toHaveBeenCalledWith({ account: "ACCOUNT42", characterId: 7n, unitId: 100,
      actorInstanceId: 200, mapId: 1, mapInstanceId: 1n, gateName: "gate", gateEpoch: 1n });
    expect(f.record.mock.invocationCallOrder[0]).toBeLessThan(f.cleanup.mock.invocationCallOrder[0]);
  });

  test("save or Location failure cannot publish a receipt or dispose the Actor", async () => {
    const f = fixture();
    f.offline.mockRejectedValue(new Error("offline failed"));
    await expect(f.map.PlayerOffline(f.unit, f.request)).rejects.toThrow("offline failed");
    expect(f.record).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
  });

  test("mismatched character never starts persistence or publishes evidence", async () => {
    const f = fixture();
    expect((await f.map.PlayerOffline(f.unit, { ...f.request, characterId: 8n })).removed).toBe(false);
    expect(f.offline).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
});
