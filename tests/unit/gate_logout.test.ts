import { describe, expect, test, vi } from "vitest";
import { GateScene } from "../../app/model/mmorpg/scenes/GateScene";
import { GateSession } from "../../app/model/mmorpg/gate/GateSession";
import { GatePlayerRoute } from "../../app/model/mmorpg/gate/GatePlayerRoute";
import { TimeSystem, RpcError, SystemErrCode } from "../../app/core/public";

function fixture() {
  const route = new GatePlayerRoute("ACCOUNT42", 7n, 1, "gate", 10, 1000);
  route.BindMap({ mapService: "map", mapHost: { name: "map", sceneType: "MapHost", innerIp: "127.0.0.1", port: 1 }, mapId: 1, mapInstanceId: 1n, unitId: 100, actorInstanceId: 200, revision: 1n, gateEpoch: 1n });
  const session = Object.create(GateSession.prototype) as GateSession;
  Object.defineProperty(session, "ConnectionId", { value: 10 });
  session.BindLogin("ACCOUNT42", "token", route);
  const routes = new Map([[route.account, route]]);
  const callActor = vi.fn().mockResolvedValue({ unitId: 100, removed: true });
  const call = vi.fn().mockResolvedValue({ unitId: 100, completed: false });
  const unbind = vi.fn();
  const resolve = vi.fn().mockResolvedValue({ found: false });
  const scene = Object.create(GateScene.prototype) as GateScene;
  Object.defineProperties(scene, {
    Locks: { value: { RunExclusive: (_kind: string, _key: unknown, callback: () => unknown) => callback() } },
    scenes: { value: { callActor, call } },
    location: { value: { Resolve: resolve } },
    self: { value: { name: "gate" } },
    actorLocations: { value: { unbindConnection: unbind } },
    routesByAccount: { value: routes },
    routesByConnection: { value: new Map([[10, route]]) },
    routesByUnitId: { value: new Map([[100, route]]) },
    connectionIdsByUnitId: { value: new Map([[100, 10]]) },
    finalOfflinePending: { value: new Set() },
    disconnecting: { value: new Set() },
    logger: { value: { info: vi.fn(), error: vi.fn() } },
  });
  return { scene, session, route, routes, callActor, call, unbind, resolve };
}

describe("explicit character logout", () => {
  test("disconnected timeout route recovers only after explicit missing Actor and authoritative absence", async () => {
    const f = fixture();
    f.route.BeginRemoving();
    f.route.Detach(10, 2000);
    f.callActor.mockRejectedValue(new RpcError(SystemErrCode.ActorLocationNotFound, "missing actor"));
    await (f.scene as any).FinalOffline(f.route, "client-reconnect-timeout");
    expect(f.routes.size).toBe(0);
    expect(f.resolve).toHaveBeenCalledWith({ unitId: 0, account: "", characterId: 7n });
  });

  test("orphan recovery cannot bypass live ownership, unavailable authority, host errors or explicit logout", async () => {
    for (const kind of ["owned", "location-down", "host-down", "invalid-receipt", "connected", "explicit", "storage"]) {
      const f = fixture();
      f.route.BeginRemoving();
      if (kind !== "connected") f.route.Detach(10, 2000);
      f.callActor.mockRejectedValue(new RpcError(kind === "storage" ? SystemErrCode.HandlerFailed : SystemErrCode.ActorLocationNotFound, "not confirmed"));
      if (kind === "owned") f.resolve.mockResolvedValue({ found: true });
      if (kind === "location-down") f.resolve.mockRejectedValue(new Error("Location unavailable"));
      if (kind === "host-down") f.call.mockRejectedValue(new Error("host unavailable"));
      if (kind === "invalid-receipt") f.call.mockResolvedValue({ unitId: 101, completed: false });
      await expect((f.scene as any).FinalOffline(f.route, kind === "explicit" ? "character-logout" : "client-reconnect-timeout")).rejects.toThrow();
      expect(f.routes.size).toBe(1);
    }
  });
  test("an active retry connection renews liveness without reviving a removing route", () => {
    const f = fixture();
    f.route.BeginRemoving();
    f.route.TouchReceive(10, 5000);
    f.route.TouchReceive(11, 9000);
    expect(f.route.lastReceiveTimeMs).toBe(5000);
    expect(f.route.state).toBe("removing");
    expect(() => f.route.Attach(11, 9001)).toThrow(/removing/);
  });

  test("scanner recovers a disconnected failed logout once, respecting backoff", async () => {
    const clock = vi.spyOn(TimeSystem, "Instance", "get").mockReturnValue({ FrameTime: 40_000 } as TimeSystem);
    try {
      const f = fixture();
      f.callActor.mockRejectedValueOnce(new Error("save failed"));
      await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).rejects.toThrow();
      await (f.scene as any).onDisconnect(10);
      (f.scene as any).SweepClientTimeouts();
      expect(f.callActor).toHaveBeenCalledTimes(1);
      f.route.nextOfflineRetryAtMs = 0;
      (f.scene as any).SweepClientTimeouts();
      (f.scene as any).SweepClientTimeouts();
      await vi.waitFor(() => expect(f.routes.size).toBe(0));
      expect(f.callActor).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  test("queued old retry does not touch a replacement route", async () => {
    const f = fixture();
    f.route.BeginRemoving();
    f.route.Detach(10, 2000);
    const next = new GatePlayerRoute("ACCOUNT42", 8n, 1, "gate", 11, 3000);
    f.routes.set("ACCOUNT42", next);
    (f.scene as any).QueueFinalOffline(f.route, "character-logout");
    await Promise.resolve();
    expect(f.routes.get("ACCOUNT42")).toBe(next);
    expect(f.callActor).not.toHaveBeenCalled();
  });

  test("repeated offline failures cap retry delay without releasing ownership", () => {
    const f = fixture();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      f.route.DeferOfflineRetry(100);
      expect(f.route.nextOfflineRetryAtMs).toBe(100 + delay);
    }
  });

  test("lost actor acknowledgement is recovered only through a positive host receipt", async () => {
    const f = fixture();
    f.callActor.mockRejectedValue(new Error("actor already disposed"));
    f.call.mockResolvedValue({ unitId: 100, completed: true });
    await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).resolves.toEqual({ characterId: 7n, released: true });
    expect(f.call.mock.calls[0][2]).toEqual({ account: "ACCOUNT42", characterId: 7n,
      unitId: 100, actorInstanceId: 200, mapId: 1, mapInstanceId: 1n, gateName: "gate", gateEpoch: 1n });
  });

  test("absent, invalid and unavailable receipt evidence cannot release ownership", async () => {
    for (const response of [{ unitId: 100, completed: false }, { unitId: 101, completed: true }, undefined]) {
      const f = fixture();
      f.callActor.mockRejectedValue(new Error("offline uncertain"));
      if (response) f.call.mockResolvedValue(response);
      else f.call.mockRejectedValue(new Error("host unavailable"));
      await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).rejects.toThrow("offline uncertain");
      expect(f.routes.size).toBe(1);
    }
  });

  test("failed offline survives transport loss and retries without reviving the actor route", async () => {
    const f = fixture();
    f.callActor.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).rejects.toThrow();
    expect(f.route.Detach(10, 2000)).toBe(true);
    expect(f.route.connectionId).toBeUndefined();
    expect(f.route.state).toBe("removing");
    expect(() => f.route.Attach(11, 2001)).toThrow(/removing/);
    await (f.scene as any).FinalOffline(f.route, "character-logout");
    expect(f.routes.size).toBe(0);
  });

  test("timeout offline failure must not unconditionally release the account", async () => {
    const f = fixture();
    f.route.BeginRemoving();
    f.callActor.mockRejectedValue(new Error("save failed"));
    await expect((f.scene as any).FinalOffline(f.route, "client-reconnect-timeout")).rejects.toThrow("save failed");
    expect(f.routes.size).toBe(1);
  });

  test("an unbound Gate route cannot bypass a character still owned by Location", async () => {
    const f = fixture();
    f.route.ClearMap();
    f.resolve.mockResolvedValue({ found: true });
    await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).rejects.toThrow(/recover its map/);
    expect(f.route.state).toBe("online");
    expect(f.routes.size).toBe(1);
    expect(f.callActor).not.toHaveBeenCalled();
  });

  test("a never-entered character releases only after confirming no Location owner", async () => {
    const f = fixture();
    f.route.ClearMap();
    await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).resolves.toEqual({ characterId: 7n, released: true });
    expect(f.resolve).toHaveBeenCalledWith({ unitId: 0, account: "", characterId: 7n });
  });

  test("does not release ownership or report success before map acknowledgement", async () => {
    const f = fixture();
    let acknowledge!: (value: unknown) => void;
    f.callActor.mockImplementation(() => new Promise((resolve) => acknowledge = resolve));
    const pending = f.scene.LogoutCharacter(f.session, { characterId: 7n });
    expect(f.routes.has("ACCOUNT42")).toBe(true);
    expect(f.route.state).toBe("removing");
    expect(f.unbind).toHaveBeenCalledWith(10);
    expect(f.session.IsAuthenticated).toBe(true);
    acknowledge({ unitId: 100, removed: true });
    await expect(pending).resolves.toEqual({ characterId: 7n, released: true });
    expect(f.routes.size).toBe(0);
    expect(f.session.IsAuthenticated).toBe(false);
  });

  test("a failed save retains ownership and allows the same connection to retry", async () => {
    const f = fixture();
    f.callActor.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).rejects.toThrow("storage unavailable");
    expect(f.routes.get("ACCOUNT42")).toBe(f.route);
    expect(() => f.route.Attach(11, 2000)).toThrow(/removing/);
    await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).resolves.toEqual({ characterId: 7n, released: true });
  });

  test("negative or mismatched map acknowledgements cannot release a character", async () => {
    for (const response of [{ unitId: 100, removed: false }, { unitId: 101, removed: true }]) {
      const f = fixture();
      f.callActor.mockResolvedValue(response);
      await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).rejects.toThrow(/offline acknowledgement/);
      expect(f.routes.size).toBe(1);
    }
  });

  test("stale character, stale connection and unauthenticated requests cannot log out the owner", async () => {
    const f = fixture();
    await expect(f.scene.LogoutCharacter(f.session, { characterId: 8n })).rejects.toThrow();
    f.route.Attach(11, 2000);
    await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).rejects.toThrow();
    f.session.Invalidate();
    await expect(f.scene.LogoutCharacter(f.session, { characterId: 7n })).rejects.toThrow();
    expect(f.callActor).not.toHaveBeenCalled();
  });
});
