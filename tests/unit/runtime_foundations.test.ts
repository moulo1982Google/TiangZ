import { describe, expect, test } from "vitest";

import { CoroutineLockSystem } from "../../app/core/runtime/CoroutineLockSystem";
import { Component, Scene } from "../../app/core/runtime/entities";
import { InitializeGameSingletons } from "../../app/core/runtime/Game";
import { ProcessHost } from "../../app/core/runtime/host";
import { SingletonRegistry } from "../../app/core/runtime/Singleton";
import {
  defineSyncEvent,
  syncEventHandler,
  type SyncSceneEventHandler,
} from "../../app/core/runtime/SceneEventSystem";
import type { InstanceId } from "../../app/core/runtime/types";

describe("CoroutineLockSystem", () => {
  test("enforces queue capacity and removes aborted waiters", async () => {
    const locks = new CoroutineLockSystem();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const first = locks.RunExclusive(1 as InstanceId, "Trade", "player", () => gate);
    const second = locks.RunExclusive(
      1 as InstanceId,
      "Trade",
      "player",
      () => undefined,
      { timeoutMs: 0, maxQueueLength: 1 },
    );
    await expect(locks.RunExclusive(
      1 as InstanceId,
      "Trade",
      "player",
      () => undefined,
      { timeoutMs: 0, maxQueueLength: 1 },
    )).rejects.toThrow(/queue is full/);
    expect(locks.WaitingCount).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(locks.WaitingCount).toBe(0);

    let releaseAgain!: () => void;
    const secondGate = new Promise<void>((resolve) => releaseAgain = resolve);
    const holder = locks.RunExclusive(1 as InstanceId, "Trade", "abort", () => secondGate);
    const controller = new AbortController();
    const waiting = locks.RunExclusive(
      1 as InstanceId,
      "Trade",
      "abort",
      () => undefined,
      { timeoutMs: 0, signal: controller.signal },
    );
    controller.abort(new Error("caller cancelled"));
    await expect(waiting).rejects.toThrow(/caller cancelled/);
    expect(locks.WaitingCount).toBe(0);
    releaseAgain();
    await holder;
  });
});

describe("SceneEventSystem scene matching", () => {
  test("does not apply a base Scene handler to a derived Scene", () => {
    interface ProbeEvent { readonly value: number }
    const descriptor = defineSyncEvent<ProbeEvent>("Unit.BaseSceneExactMatch");
    class BaseScene extends Scene { total = 0 }
    class DerivedScene extends BaseScene {}
    class Handler implements SyncSceneEventHandler<BaseScene, ProbeEvent> {
      Handle(scene: BaseScene, event: ProbeEvent): void { scene.total += event.value; }
    }
    syncEventHandler(BaseScene, descriptor, { id: "base-only" })(Handler);

    InitializeGameSingletons();
    const host = new ProcessHost("scene-event-unit");
    try {
      const base = host.spawnScene("base", BaseScene, { sceneType: "BaseScene" });
      const derived = host.spawnScene("derived", DerivedScene, { sceneType: "DerivedScene" });
      expect(base.Events.Publish(descriptor, { value: 3 })).toEqual({ handlerCount: 1, failedCount: 0 });
      expect(derived.Events.Publish(descriptor, { value: 5 })).toEqual({ handlerCount: 0, failedCount: 0 });
      expect(base.total).toBe(3);
      expect(derived.total).toBe(0);
    } finally {
      host.Dispose();
      SingletonRegistry.DestroyAll();
    }
  });
});

describe("Component disposal", () => {
  test("clears the parent when OnDestroy violates the synchronous contract", () => {
    class TestScene extends Scene {}
    class InvalidDestroyComponent extends Component {
      protected override OnDestroy(): void {
        return Promise.resolve() as unknown as void;
      }
    }

    InitializeGameSingletons();
    const host = new ProcessHost("component-disposal-unit");
    try {
      const scene = host.spawnScene("component-disposal", TestScene, { sceneType: "TestScene" });
      const component = scene.AddComponent(InvalidDestroyComponent);
      expect(() => scene.RemoveComponent(InvalidDestroyComponent)).toThrow(/must be synchronous/);
      expect(component.IsDisposed).toBe(true);
      expect(() => component.Parent).toThrow(/has no parent/);
      expect(scene.HasComponent(InvalidDestroyComponent)).toBe(false);
    } finally {
      host.Dispose();
      SingletonRegistry.DestroyAll();
    }
  });
});
