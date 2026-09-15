import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GlobalIdSystem } from "../../app/core/public";
import { InitializeGameSingletons } from "../../app/core/runtime/Game";
import { SingletonRegistry } from "../../app/core/runtime/Singleton";
import { MapAdmission } from "../../app/model/mmorpg/mapHost/MapAdmission";
import { MapManagerComponent } from "../../app/model/mmorpg/mapManager/MapManagerComponent";
import { DynamicMapProtocol, MapHostControlProtocol, PublicMapHostProtocol } from "../../app/generated/model/server/demo/protocol/rpcs";

beforeEach(() => { InitializeGameSingletons(); let next = 10000n; vi.spyOn(GlobalIdSystem.Instance, "Next").mockImplementation(() => next++); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); SingletonRegistry.DestroyAll(); });

function fixture(maxMaps = 2, maxPlayers = 200) {
  const manager = new MapManagerComponent();
  const hosts = new Map<string, ReturnType<typeof host>>();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const call = vi.fn(async (endpoint: { name: string }, protocol: unknown, request: any) => {
    const h = hosts.get(endpoint.name)!;
    if (protocol === MapHostControlProtocol.CreateAssigned) {
      if (!h.assignments.has(request.mapInstanceId)) {
        h.admission.RequireCreation(request.mapConfigId, h.assignments.size);
        h.assignments.set(request.mapInstanceId, { ...request });
        h.occupants.set(request.mapInstanceId, new Set());
        if (request.channelId) h.admission.AddChannel(request.mapInstanceId, request.channelId, request.maxPlayers);
      }
      return { instance: { mapInstanceId: request.mapInstanceId, mapConfigId: request.mapConfigId,
        mapHostName: endpoint.name, dynamic: true, mapHost: h.endpoint } };
    }
    if (protocol === PublicMapHostProtocol.Reserve) {
      const expires = h.admission.Reserve(request.mapInstanceId, request.characterId, h.occupants);
      return { accepted: expires > 0, expiresAtMs: BigInt(expires), hostOccupied: h.admission.Occupied(h.occupants).size };
    }
    if (protocol === PublicMapHostProtocol.Status) {
      h.admission.Sweep(h.occupants);
      return { found: h.assignments.has(request.mapInstanceId), playerCount: h.occupants.get(request.mapInstanceId)?.size ?? 0,
        reservedCount: h.admission.Channels.get(request.mapInstanceId)?.reservations.size ?? 0 };
    }
    if (protocol === DynamicMapProtocol.Dispose) {
      if (h.occupants.get(request.mapInstanceId)!.size || h.admission.Channels.get(request.mapInstanceId)!.reservations.size) throw new Error("occupied");
      h.assignments.delete(request.mapInstanceId); h.occupants.delete(request.mapInstanceId); h.admission.Channels.delete(request.mapInstanceId);
      return { disposed: true };
    }
    throw new Error("unexpected RPC");
  });
  function attach(value: MapManagerComponent) {
    Object.defineProperty(value, "publicRecoveryReadyAt", { value: 0, configurable:true });
    Object.defineProperty(value, "owner", { value: { logger, scenes: { call } } });
    value.ConfigurePublicMaps([{ mapConfigId: 1, maxPlayers: 50, minChannels: 1, idleTimeoutMs: 30_000 }]);
    return value;
  }
  function host(name: string, port: number) {
    const admission = new MapAdmission(); admission.Configure({ maxMaps, maxPlayers, mapConfigIds: [1] });
    return { admission, occupants: new Map<bigint, Set<bigint>>(), assignments: new Map<bigint, any>(),
      endpoint: { name, ip: "127.0.0.1", port, protocol: "tcp", audience: "inner" } };
  }
  function register(target: MapManagerComponent, name: string) {
    const h = hosts.get(name)!;
    target.Register({ endpoint: h.endpoint, generation: 1n, staticMapCount: 0,
      dynamicMapCount: h.assignments.size, playerCount: h.admission.Occupied(h.occupants).size,
      assignments: [...h.assignments.values()], maxMaps, maxPlayers, mapConfigIds: [1] });
  }
  attach(manager);
  hosts.set("host-a", host("host-a", 7301)); hosts.set("host-b", host("host-b", 7302));
  register(manager, "host-a"); register(manager, "host-b");
  const acquire = (id: number, preferredInstanceId = 0n, target = manager) => target.AcquirePublicMap({ mapConfigId: 1, characterId: BigInt(id), preferredInstanceId });
  return { manager, hosts, acquire, call, register, attach };
}

test("101 concurrent reservations create 50/50/1 seats across two MapHosts", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 101 }, (_, i) => f.acquire(i + 1)));
  const channels = await f.manager.ListPublicMaps(1);
  expect(channels.map(c => c.reservedCount)).toEqual([50, 50, 1]);
  expect(channels.map(c => c.instance.mapHostName)).toEqual(["host-a", "host-a", "host-b"]);
  expect(new Set(results.map(r => r.instance.mapInstanceId)).size).toBe(3);
  expect(f.hosts.get("host-a")!.assignments.size).toBe(2);
  await f.acquire(101, results[100].instance.mapInstanceId);
  expect((await f.manager.ListPublicMaps(1))[2].reservedCount).toBe(1);
});

test("admission expires, rejects bypass, counts staged players and permits local moves at host capacity", () => {
  const ledger = new MapAdmission();
  expect(ledger.RequiresAdmission(100n)).toBe(false);
  ledger.Configure({ maxMaps: 2, maxPlayers: 1, mapConfigIds: [1] });
  expect(ledger.RequiresAdmission(100n)).toBe(true);
  ledger.AddChannel(100n, 1, 1); ledger.AddChannel(200n, 2, 1);
  const occupied = new Map<bigint, Set<bigint>>([[100n, new Set()], [200n, new Set()]]);
  expect(ledger.Reserve(100n, 1n, occupied, 0)).toBe(30_000);
  expect(ledger.Reserve(100n, 2n, occupied, 0)).toBe(0);
  expect(() => ledger.Admit(100n, 2n, occupied, 1)).toThrow();
  expect(() => ledger.Admit(100n, 1n, occupied, 30_000)).toThrow();
  ledger.Reserve(100n, 1n, occupied, 31_000); ledger.Admit(100n, 1n, occupied, 31_001);
  occupied.get(100n)!.add(1n);
  expect(ledger.Reserve(200n, 2n, occupied, 31_002)).toBe(0);
  expect(ledger.Reserve(200n, 1n, occupied, 31_002)).toBeGreaterThan(0);
  ledger.Admit(200n, 1n, occupied, 31_003); occupied.get(200n)!.add(1n);
  expect(ledger.Occupied(occupied).size).toBe(1);
});

test("manager restart recovers public metadata and reservations from living hosts", async () => {
  const f = fixture(); const first = await f.acquire(1);
  const restarted = f.attach(new MapManagerComponent());
  f.register(restarted, "host-a"); f.register(restarted, "host-b");
  const retry = await f.acquire(1, first.instance.mapInstanceId, restarted);
  expect(retry.instance).toEqual(first.instance); expect(retry.channelId).toBe(first.channelId);
  expect(retry.expiresAtMs).toBe(first.expiresAtMs);
  expect((await restarted.ListPublicMaps(1))).toHaveLength(1);
});

test("lost host is excluded and a fresh public channel is allocated elsewhere", async () => {
  const f = fixture(); const first = await f.acquire(1);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
  f.manager.Heartbeat({ mapHostName: "host-b", generation: 1n, staticMapCount: 0, dynamicMapCount: 0,
    playerCount: 0, maxMaps: 2, maxPlayers: 200, mapConfigIds: [1] });
  const next = await f.acquire(1, first.instance.mapInstanceId);
  expect(next.instance.mapHostName).toBe("host-b"); expect(next.instance.mapInstanceId).not.toBe(first.instance.mapInstanceId);
});

test("extra idle channels are reclaimed while minimum channels remain", async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 51 }, (_, i) => f.acquire(i + 1)));
  const start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start + 31_000);
  f.register(f.manager, "host-a"); f.register(f.manager, "host-b");
  await (f.manager as any).MaintainPublicMaps();
  clock.mockReturnValue(start + 62_000);
  f.register(f.manager, "host-a"); f.register(f.manager, "host-b");
  await (f.manager as any).MaintainPublicMaps();
  expect(await f.manager.ListPublicMaps(1)).toHaveLength(1);
});

test("host player budget triggers placement elsewhere before the channel itself is full", async () => {
  const f = fixture(2, 5);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => f.acquire(i + 1)));
  expect(results.map(r => r.instance.mapHostName)).toEqual(["host-a", "host-a", "host-a", "host-a", "host-a", "host-b"]);
  expect((await f.manager.ListPublicMaps(1)).map(c => c.reservedCount)).toEqual([5, 1]);
});

test("lost create response retries the same assigned instance instead of opening another channel", async () => {
  const f = fixture(); const original = f.call.getMockImplementation()!;
  f.call.mockImplementationOnce(async (...args) => { await original(...args); throw new Error("create response lost"); });
  await expect(f.acquire(1)).rejects.toThrow("create response lost");
  const id = [...f.hosts.get("host-a")!.assignments.keys()][0];
  expect((await f.acquire(1)).instance.mapInstanceId).toBe(id);
  expect(f.hosts.get("host-a")!.assignments.size).toBe(1);
});

test("manager recovery rejects admissions until its registration grace has elapsed", async () => {
  const manager = new MapManagerComponent();
  manager.ConfigurePublicMaps([{ mapConfigId: 1, maxPlayers: 50, minChannels: 1, idleTimeoutMs: 30_000 }]);
  await expect(manager.AcquirePublicMap({ mapConfigId: 1, characterId: 1n, preferredInstanceId: 0n })).rejects.toThrow("recovering");
});


test("private dynamic assignments keep roster across retries and manager recovery", async () => {
  const f = fixture();
  const request = { mapConfigId: 1, requestId: "private-run-1", privateRoster: { characterIds: [2n, 1n] } };
  const created = await f.manager.Create(request);
  expect((await f.manager.Create({ ...request, privateRoster: { characterIds: [1n, 2n] } })).instance.mapInstanceId).toBe(created.instance.mapInstanceId);
  await expect(f.manager.Create({ ...request, privateRoster: undefined })).rejects.toThrow(/conflict/);
  await expect(f.manager.Create({ ...request, privateRoster: { characterIds: [1n, 3n] } })).rejects.toThrow(/conflict/);
  request.privateRoster.characterIds.push(99n);
  const recovery = f.attach(new MapManagerComponent());
  f.register(recovery, created.instance.mapHostName);
  expect((await recovery.Create({ ...request, privateRoster: { characterIds: [1n, 2n] } })).instance.mapInstanceId).toBe(created.instance.mapInstanceId);
  await expect(recovery.Create({ ...request, privateRoster: undefined })).rejects.toThrow(/conflict/);
});


test("private requests wait for host recovery and inspection never allocates",async()=>{
  const f=fixture();
  Object.defineProperty(f.manager,"publicRecoveryReadyAt",{value:Date.now()+15000});
  expect(f.manager.Inspect("unknown")).toEqual({state:"recovering",mapInstanceId:0n});
  await expect(f.manager.Create({mapConfigId:1,requestId:"private-recover",privateRoster:{characterIds:[1n]}})).rejects.toThrow(/recovering/);
  expect(f.call).not.toHaveBeenCalled();
  Object.defineProperty(f.manager,"publicRecoveryReadyAt",{value:0});
  expect(f.manager.Inspect("unknown").state).toBe("unknown");
  const result=await f.manager.Create({mapConfigId:1,requestId:"private-recover",privateRoster:{characterIds:[1n]}});
  expect(f.manager.Inspect("private-recover")).toEqual({state:"active",mapInstanceId:result.instance.mapInstanceId});
  const old=Date.now();vi.spyOn(Date,"now").mockReturnValue(old+16000);
  expect(f.manager.Inspect("private-recover").state).toBe("lost");
});
