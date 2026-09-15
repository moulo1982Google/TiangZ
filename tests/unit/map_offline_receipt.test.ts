import { describe, expect, test, vi } from "vitest";
import { MapComponent } from "../../app/model/mmorpg/map/MapComponent";
import type { PlayerUnit } from "../../app/model/mmorpg/map/PlayerUnit";

function fixture() {
  const map = Object.create(MapComponent.prototype) as MapComponent;
  const record = vi.fn();
  const cleanup = vi.fn();
  const remove = vi.fn();
  const offline = vi.fn().mockResolvedValue(undefined);
  Object.defineProperties(map, {
    requirePlayer: { value: vi.fn() },
    offlineOperations: { value: new WeakMap() },
    MarkPlayerOffline: { value: offline },
    ScheduleOfflineCleanup: { value: cleanup },
    players: { value: { RecordOffline: record, Remove: remove } },
    mapId: { value: 1 }, mapInstanceId: { value: 1n },
    logger: { value: { info: vi.fn(), warn: vi.fn() } },
  });
  const unit = { UnitId: 100, InstanceId: 200, Account: "ACCOUNT42", CharacterId: 7n,
    MapId: 1, MatchesGate: vi.fn().mockReturnValue(true) } as unknown as PlayerUnit;
  Object.defineProperty(map,"units",{value:{Get:()=>unit},configurable:true});
  const request = { account: "ACCOUNT42", characterId: 7n, unitId: 100, mapId: 1,
    gateName: "gate", gateEpoch: 1n, reason: "character-logout" };
  return { map, unit, request, record, cleanup, offline, remove };
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

  test("concurrent logout and shutdown share final save; completed removal is not repeated", async () => {
    const f=fixture(); let finish!:()=>void;
    const commit=vi.fn().mockImplementation(()=>new Promise<void>(resolve=>finish=resolve));
    Object.defineProperty(f.map,"CommitPlayerOffline",{value:commit});
    const invoke=()=> (MapComponent.prototype as any).MarkPlayerOffline.call(f.map,f.unit,"logout");
    const first=invoke(), second=invoke();
    expect(commit).toHaveBeenCalledTimes(1);
    finish(); await Promise.all([first,second]); await invoke();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  test("shutdown waits for logout and does not remove an Actor already cleaned up", async () => {
    const f=fixture(); let finish!:()=>void;
    let present=true;
    Object.defineProperty(f.map,"units",{value:{Get:()=>present?f.unit:undefined}});
    Object.defineProperties(f.map,{
      pendingOfflineCleanup:{value:new Map()},
      RemovePlayer:{value:vi.fn()},
      PublishAoiChanges:{value:vi.fn()},
    });
    f.offline.mockImplementation(()=>new Promise<void>(resolve=>finish=resolve));
    const pending=(MapComponent.prototype as any).OfflinePlayerAndBroadcast.call(f.map,f.unit,"shutdown");
    present=false; finish(); await pending;
    expect((f.map as any).RemovePlayer).not.toHaveBeenCalled();
  });

  test("failed shared final save remains retryable", async () => {
    const f=fixture();
    const commit=vi.fn().mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(undefined);
    Object.defineProperty(f.map,"CommitPlayerOffline",{value:commit});
    const invoke=()=> (MapComponent.prototype as any).MarkPlayerOffline.call(f.map,f.unit,"shutdown");
    await expect(invoke()).rejects.toThrow("database unavailable"); await invoke();
    expect(commit).toHaveBeenCalledTimes(2);
  });

  test.each([true,false])("logout and host stop share the real Location transaction (logout first: %s)", async logoutFirst => {
    const map=Object.create(MapComponent.prototype) as any;
    let present=true, finish!:()=>void;
    const offline=vi.fn(()=>new Promise<void>(resolve=>finish=resolve));
    const unit={UnitId:100,InstanceId:200,Account:"ACCOUNT42",CharacterId:7n,MapId:1,
      MatchesGate:()=>true,GetComponent:()=>({gateName:"gate"}),Offline:offline};
    const location={Resolve:vi.fn().mockResolvedValue({found:true,location:{actorInstanceId:200,revision:1n}}),
      Lock:vi.fn().mockResolvedValue({}),Remove:vi.fn().mockResolvedValue({removed:true}),Unlock:vi.fn()};
    Object.defineProperties(map,Object.fromEntries(Object.entries({
      requirePlayer:vi.fn(),offlineOperations:new WeakMap(),pendingOfflineCleanup:new Map(),nextLocationOperation:1,
      mapId:1,mapInstanceId:1n,location,units:{Get:()=>present?unit:undefined,GetAll:()=>present?[unit]:[]},
      players:{RecordOffline:vi.fn(),Remove:vi.fn()},ScheduleOfflineCleanup:vi.fn(),
      scenes:{byName:()=>({}),send:()=>undefined},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()},
      DomainScene:()=>({GetComponent:()=>({PlayerLeaving:vi.fn()})}),
      RemovePlayer:vi.fn(()=>{present=false;return [];}),PublishAoiChanges:vi.fn().mockResolvedValue(undefined),
    }).map(([key,value])=>[key,{value,writable:true}])));
    const logout=()=>map.PlayerOffline(unit,{account:"ACCOUNT42",characterId:7n,unitId:100,mapId:1,
      gateName:"gate",gateEpoch:1n,reason:"character-logout"});
    const first=logoutFirst?logout():map.KickAllPlayers("host-stop");
    const second=logoutFirst?map.KickAllPlayers("host-stop"):logout();
    await vi.waitFor(()=>expect(offline).toHaveBeenCalledTimes(1));
    finish(); await Promise.all([first,second]);
    expect(location.Resolve).toHaveBeenCalledTimes(1);
    expect(location.Lock).toHaveBeenCalledTimes(1);
    expect(location.Remove).toHaveBeenCalledTimes(1);
    expect(map.players.RecordOffline).toHaveBeenCalledTimes(1);
    expect(map.RemovePlayer).toHaveBeenCalledTimes(1);
    expect(present).toBe(false);
  });

  test("publishes only after successful save/removal and before deferred Actor cleanup", async () => {
    const f = fixture();
    let finish!: () => void;
    f.offline.mockImplementation(() => new Promise<void>(resolve => finish = resolve));
    const pending = f.map.PlayerOffline(f.unit, f.request);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    finish();
    expect((await pending).removed).toBe(true);
    expect(f.record).toHaveBeenCalledWith({ account: "ACCOUNT42", characterId: 7n, unitId: 100,
      actorInstanceId: 200, mapId: 1, mapInstanceId: 1n, gateName: "gate", gateEpoch: 1n });
    expect(f.record.mock.invocationCallOrder[0]).toBeLessThan(f.cleanup.mock.invocationCallOrder[0]);
    expect(f.remove).toHaveBeenCalledWith(f.unit);
    expect(f.remove.mock.invocationCallOrder[0]).toBeLessThan(f.cleanup.mock.invocationCallOrder[0]);
  });

  test("save or Location failure cannot publish a receipt or dispose the Actor", async () => {
    const f = fixture();
    f.offline.mockRejectedValue(new Error("offline failed"));
    await expect(f.map.PlayerOffline(f.unit, f.request)).rejects.toThrow("offline failed");
    expect(f.record).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  test("mismatched character never starts persistence or publishes evidence", async () => {
    const f = fixture();
    expect((await f.map.PlayerOffline(f.unit, { ...f.request, characterId: 8n })).removed).toBe(false);
    expect(f.offline).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
});
