import { describe, expect, test } from "vitest";

import {
  HotfixBindingStore,
  HotfixSystem,
  hotfixFor,
} from "../../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../../app/core/hotReload/contracts";

describe("HotfixSystem failure isolation", () => {
  test("rejects async reserved hooks before modifying the target prototype", () => {
    class Target {
      Awake(): void {}
    }
    HotfixSystem.Begin(manifest("async-hook"));
    class AsyncCandidate extends Target {
      override async Awake(): Promise<void> { await Promise.resolve(); }
    }
    hotfixFor(Target)(AsyncCandidate);
    expect(() => HotfixSystem.Commit()).toThrow(/Awake.*synchronous|synchronous.*Awake/);
    expect(Target.prototype.Awake.constructor.name).not.toBe("AsyncFunction");
    expect(HotfixSystem.Status().activeVersion).toBeUndefined();
  });

  test("reports rollback failures as AggregateError and returns to idle", () => {
    const good = new HotfixBindingStore<{ value: number }>("unit-good");
    const bad = new HotfixBindingStore<{ value: number }>("unit-bad");
    good.Register("slot", { value: 1 });
    bad.Register("slot", { value: 1 });

    HotfixSystem.Begin(manifest("binding-baseline"));
    good.Register("slot", { value: 1 });
    bad.Register("slot", { value: 1 });
    HotfixSystem.Commit();

    const locked = bad.Values()[0];
    Object.defineProperty(locked, "value", {
      value: 1,
      configurable: false,
      writable: false,
      enumerable: true,
    });
    const originalRollback = good.__rollback.bind(good);
    (good as unknown as { __rollback: () => void }).__rollback = () => {
      throw new Error("injected rollback failure");
    };

    HotfixSystem.Begin(manifest("binding-broken"));
    good.Register("slot", { value: 2 });
    bad.Register("slot", { value: 2 });
    let failure: unknown;
    try {
      HotfixSystem.Commit();
    } catch (error) {
      failure = error;
    } finally {
      (good as unknown as { __rollback: typeof originalRollback }).__rollback = originalRollback;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String).join("\n")).toContain("injected rollback failure");
    expect(HotfixSystem.Status().phase).toBe("idle");
  });
});

function manifest(bundleVersion: string): HotfixManifest {
  return {
    formatVersion: 1,
    bundleVersion,
    modelFingerprint: "model",
    modelSourceHash: "source",
    protocolFingerprint: "protocol",
    stableCoreApiHash: "core",
    nativeSchemaHash: "native",
    hotfixHash: bundleVersion,
    buildMode: "demo",
  };
}
