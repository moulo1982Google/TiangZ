import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GlobalIdSystem } from "../../app/core/public";
import { InitializeGameSingletons } from "../../app/core/runtime/Game";
import { SingletonRegistry } from "../../app/core/runtime/Singleton";
import { MapHostComponent } from "../../app/model/mmorpg/mapHost/MapHostComponent";
import { MapHostRegistrationComponent } from "../../app/model/mmorpg/mapHost/MapHostRegistrationComponent";

beforeEach(() => { InitializeGameSingletons(); let next = 10000n; vi.spyOn(GlobalIdSystem.Instance, "Next").mockImplementation(() => next++); });
afterEach(() => { vi.restoreAllMocks(); SingletonRegistry.DestroyAll(); });

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function lifecycle(component: MapHostComponent | MapHostRegistrationComponent) {
  let disposed = false;
  const logger = { warn: vi.fn(), info: vi.fn() };
  const call = vi.fn();
  const owner = { IsDisposed: false, self: { name: "host-a" }, logger, scenes: { one: () => ({ name: "manager" }), call } };
  Object.defineProperty(component, "IsDisposed", { get: () => disposed });
  // Detached parents must never be looked up by a stale continuation.
  Object.defineProperty(component, "owner", { get: () => { if (disposed) throw new Error("detached parent"); return owner; } });
  return { component: component as any, owner, logger, call, dispose: () => { disposed = true; owner.IsDisposed = true; } };
}

for (const reject of [false, true]) {
  test(`heartbeat after disposal stops before registration (reject=${reject})`, async () => {
    const f = lifecycle(new MapHostRegistrationComponent());
    f.component.registered = true; f.component.heartbeat = () => ({});
    const response = deferred<{ registered: boolean }>(); f.call.mockReturnValue(response.promise);
    const report = f.component.ReportToMapManager(); expect(f.call).toHaveBeenCalledTimes(1);
    f.dispose();
    if (reject) response.reject(new Error("transport closed")); else response.resolve({ registered: false });
    await expect(report).resolves.toBeUndefined();
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.logger.warn).not.toHaveBeenCalled();
    await f.component.ReportToMapManager(); expect(f.call).toHaveBeenCalledTimes(1);
  });

  test(`location owner response cannot revive a disposed host (reject=${reject})`, async () => {
    const f = lifecycle(new MapHostComponent());
    const response = deferred<any>();
    Object.defineProperty(f.component, "players", { value: { GetAll: () => [] } });
    f.component.location = { RecoverOwner: vi.fn(() => response.promise) };
    const report = f.component.RecoverOwnedLocations(); f.dispose();
    if (reject) response.reject(new Error("transport closed")); else response.resolve({ recovered: 1, unchanged: 0, ownerReplaced: true });
    await expect(report).resolves.toBeUndefined();
    expect(f.component.locationOwnerClaimed).toBe(false);
    expect(f.logger.warn).not.toHaveBeenCalled(); expect(f.logger.info).not.toHaveBeenCalled();
  });

  test(`map route recovery stops after disposal (reject=${reject})`, async () => {
    const f = lifecycle(new MapHostComponent()); const response = deferred<any>();
    f.component.maps.set(1n, { MapInstanceId: 1n, MapId: 1, IsDynamic: true });
    f.component.maps.set(2n, { MapInstanceId: 2n, MapId: 1, IsDynamic: true });
    f.component.EndpointSnapshot = () => ({});
    const register = vi.fn(() => response.promise); f.component.location = { RegisterMapInstance: register };
    const report = f.component.RecoverHostedMapInstances(); f.dispose();
    if (reject) response.reject(new Error("transport closed")); else response.resolve({});
    await expect(report).resolves.toBeUndefined(); expect(register).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).not.toHaveBeenCalled();
  });
}

test("late registration acknowledgement cannot flush disposed maps", async () => {
  const f = lifecycle(new MapHostRegistrationComponent()); f.component.registration = () => ({});
  const response = deferred<{ accepted: boolean }>(); f.call.mockReturnValue(response.promise);
  f.component.pendingDisposedMaps.set("1", { mapInstanceId: 1n });
  const report = f.component.ReportToMapManager(); f.dispose(); response.resolve({ accepted: true });
  await report; expect(f.component.registered).toBe(false); expect(f.call).toHaveBeenCalledTimes(1);
});

test("disposal acknowledgement cannot continue flushing after host disposal", async () => {
  const f = lifecycle(new MapHostRegistrationComponent());
  f.component.mapHost = { OwnerGeneration: 1n };
  f.component.pendingDisposedMaps.set("1", { mapInstanceId: 1n });
  f.component.pendingDisposedMaps.set("2", { mapInstanceId: 2n });
  const response = deferred<{ accepted: boolean }>(); f.call.mockReturnValue(response.promise);
  const flush = f.component.FlushDisposedMaps({}); f.dispose(); response.resolve({ accepted: true });
  await flush; expect(f.call).toHaveBeenCalledTimes(1);
});

test("entry ownership wait rejects if the host is destroyed during publication", async () => {
  const f = lifecycle(new MapHostComponent()); const response = deferred<any>();
  Object.defineProperty(f.component, "players", { value: { GetAll: () => [] } });
  f.component.location = { RecoverOwner: () => response.promise };
  const enter = f.component.EnsureLocationOwner(); f.dispose(); response.resolve({ ownerReplaced: false });
  await expect(enter).rejects.toThrow(/disposed/);
});
