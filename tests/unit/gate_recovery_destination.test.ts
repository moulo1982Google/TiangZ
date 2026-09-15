import { expect, test, vi } from "vitest";
import { GateScene } from "../../app/model/mmorpg/scenes/GateScene";

function fixture(branch: "session" | "location" | "route" = "session") {
  const scene = Object.create(GateScene.prototype) as any;
  const map = { mapId: 700, mapInstanceId: 700n, unitId: 1, actorInstanceId: 2, mapHostName: "lost-host", gateName: "gate", state: "active", mapHost: { name: "lost-host", ip: "127.0.0.1", port: 7000, protocol: "tcp", audience: "inner" } };
  const route: any = { characterId: 1n, actorState: "active", map: branch === "location" ? undefined : map, BindMap(value: unknown) { this.map = value; } };
  const session = { needsSecondEnter: branch === "session" };
  const destination = vi.fn(async () => 990n);
  const resolveMap = vi.fn(async () => ({ found: false }));
  Object.assign(scene, {
    RequireCurrentRoute: () => route, AssertCurrentRoute: vi.fn(),
    ResumeOrRecoverMapHost: vi.fn(async () => { route.map = undefined; return { routeLost: true }; }),
    ResolveRecoveryMapInstance: destination,
    EnsureGateOwnership: async (_s: unknown, _r: unknown, location: unknown) => location,
    BindConnectionRoute: vi.fn(), routesByUnitId: new Map(),
    location: { Resolve: vi.fn(async () => branch === "location" ? { found: true, location: map } : { found: false }), ResolveMapInstance: resolveMap },
    dynamicFallbackMetrics: { attempts: 0, failed: 0, completed: 0 },
  });
  const enter = (admitted?: bigint) => scene.EnterMapCore(session, { mapId: 700, mapInstanceId: 700n }, undefined, 0, admitted);
  return { scene, route, session, destination, resolveMap, enter };
}

for (const branch of ["session", "location", "route"] as const) {
  test(`authoritative route loss uses module destination from ${branch} recovery`, async () => {
    const f = fixture(branch);
    await expect(f.enter()).rejects.toThrow("map instance not found: 990");
    expect(f.destination).toHaveBeenCalledOnce(); expect(f.destination).toHaveBeenCalledWith(f.session);
    expect(f.resolveMap).toHaveBeenCalledWith({ mapInstanceId: 990n });
  });
}

test("public entry reuses its already admitted instance after route loss", async () => {
  const f = fixture();
  await expect(f.enter(880n)).rejects.toThrow("map instance not found: 880");
  expect(f.destination).not.toHaveBeenCalled(); expect(f.resolveMap).toHaveBeenCalledWith({ mapInstanceId: 880n });
});

test("live instance resume bypasses destination selection", async () => {
  const f = fixture(); f.scene.ResumeOrRecoverMapHost.mockResolvedValue({ response: { mapInstanceId: 700n }, routeLost: false });
  await expect(f.enter()).resolves.toEqual({ mapInstanceId: 700n }); expect(f.destination).not.toHaveBeenCalled();
});

test("recovery allocation cannot enter after the session route changes", async () => {
  const f = fixture();
  f.destination.mockImplementation(async () => { f.scene.AssertCurrentRoute = () => { throw new Error("route changed"); }; return 990n; });
  await expect(f.enter()).rejects.toThrow("route changed"); expect(f.resolveMap).not.toHaveBeenCalled();
});

test("unavailable authority cannot select a recovery map", async () => {
  const f = fixture(); f.scene.ResumeOrRecoverMapHost.mockRejectedValue(new Error("Location unavailable"));
  await expect(f.enter()).rejects.toThrow("Location unavailable"); expect(f.destination).not.toHaveBeenCalled();
});
