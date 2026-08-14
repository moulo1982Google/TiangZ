import {
  HotfixBindingStore,
  HotfixSystem,
  hotfixFor,
  systemFor,
} from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { Component, Entity } from "../app/core/runtime/entities";
import {
  Game,
  InitializeGameSingletons,
} from "../app/core/runtime/Game";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import { TimerSystem } from "../app/core/runtime/TimerSystem";
import { TimeSystem } from "../app/core/runtime/TimeSystem";
import { lifecycle } from "../app/core/runtime/metadata";

class StableCounter {
  value = 10;

  Read(): number {
    return this.value;
  }
}

const instance = new StableCounter();

HotfixSystem.Begin(manifest("v1"));
class CounterV1 extends StableCounter {
  override Read(): number {
    return this.value + 1;
  }
}
hotfixFor(StableCounter)(CounterV1);
HotfixSystem.Commit();
assert(instance.Read() === 11, "existing instance did not receive v1 prototype");

HotfixSystem.Begin(manifest("v2"));
class CounterV2 extends StableCounter {
  override Read(): number {
    return this.value + 2;
  }
}
hotfixFor(StableCounter)(CounterV2);
HotfixSystem.Commit();
assert(instance.Read() === 12, "existing instance did not receive v2 prototype");

HotfixSystem.Begin(manifest("baseline"));
HotfixSystem.Commit();
assert(instance.Read() === 10, "omitted complete patch did not restore Model baseline");

@lifecycle({ awake: true, destroy: true })
class LifecycleComponent extends Component<[value: string]> {
  protected value = "";
  destroyedBy = "";
  timerGeneration = "";
  timerTicks = 0;
  onceTimerGeneration = "";

  Read(): string {
    return this.value;
  }
}

class TestEntity extends Entity {}

class PartialPrototypeTarget extends Component {}

class PartialPrototypeGoodSystem extends PartialPrototypeTarget {
  First(): string { return "good"; }
}

class PartialPrototypeBrokenSystem extends PartialPrototypeTarget {
  First(): string { return "broken"; }
  locked(): string { return "broken"; }
}

InitializeGameSingletons();
const timerBase = TimeSystem.Instance.FrameTime;
HotfixSystem.RequireType(LifecycleComponent);
HotfixSystem.Begin(manifest("missing-initial-system"));
let initialSystemRejected = false;
try {
  HotfixSystem.Commit();
} catch {
  initialSystemRejected = true;
}
assert(initialSystemRejected, "first candidate missing a Model-required System was accepted");

HotfixSystem.Begin(manifest("incomplete-lifecycle"));
class IncompleteLifecycleSystem extends LifecycleComponent {
  protected override Awake(value: string): void {
    this.value = value;
  }
}
systemFor(LifecycleComponent)(IncompleteLifecycleSystem);
let incompleteLifecycleRejected = false;
try {
  HotfixSystem.Commit();
} catch (error) {
  incompleteLifecycleRejected = String(error).includes("LifecycleComponent.OnDestroy");
}
assert(incompleteLifecycleRejected, "candidate missing a declared lifecycle method was accepted");

HotfixSystem.Begin(manifest("system-v1"));
class LifecycleSystemV1 extends LifecycleComponent {
  protected override Awake(value: string): void {
    this.value = `v1:${value}`;
    this.NewRepeatedTimer(10, "Tick");
    this.NewOnceTimer(20, "OnceTick");
  }

  protected override OnDestroy(): void {
    this.destroyedBy = "v1";
  }

  override Read(): string {
    return `read-v1:${this.value}`;
  }

  Tick(): void {
    this.timerGeneration = "v1";
    this.timerTicks += 1;
  }

  OnceTick(): void {
    this.onceTimerGeneration = "v1";
  }
}
systemFor(LifecycleComponent)(LifecycleSystemV1);
HotfixSystem.Commit();

const oldEntity = new TestEntity();
const oldComponent = oldEntity.AddComponent(LifecycleComponent, "old");
assert(oldComponent.Read() === "read-v1:v1:old", "System Awake v1 was not dispatched");
Game.Instance.Update(timerBase + 10, Date.now(), () => undefined);
assert(oldComponent.timerGeneration === "v1", "generation v1 timer method was not dispatched");
assert(oldComponent.timerTicks === 1, "generation v1 repeated timer did not tick once");

HotfixSystem.Begin(manifest("system-v2"));
class LifecycleSystemV2 extends LifecycleComponent {
  protected override Awake(value: string): void {
    this.value = `v2:${value}`;
    this.NewRepeatedTimer(10, "Tick");
  }

  protected override OnDestroy(): void {
    this.destroyedBy = "v2";
  }

  override Read(): string {
    return `read-v2:${this.value}`;
  }

  Tick(): void {
    this.timerGeneration = "v2";
    this.timerTicks += 10;
  }

  OnceTick(): void {
    this.onceTimerGeneration = "v2";
  }
}
systemFor(LifecycleComponent)(LifecycleSystemV2);
HotfixSystem.Commit();

assert(
  oldComponent.Read() === "read-v2:v1:old",
  "existing Component was re-awakened or did not receive the new System",
);
const newEntity = new TestEntity();
const newComponent = newEntity.AddComponent(LifecycleComponent, "new");
assert(newComponent.Read() === "read-v2:v2:new", "new Component did not use System Awake v2");
Game.Instance.Update(timerBase + 20, Date.now(), () => undefined);
assert(oldComponent.timerGeneration === "v2", "existing timer retained the old generation method");
assert(oldComponent.timerTicks === 11, "existing timer did not dispatch exactly once to generation v2");
assert(oldComponent.onceTimerGeneration === "v2", "existing one-shot timer retained generation v1");
assert(newComponent.timerTicks === 10, "new generation timer did not dispatch to generation v2");
oldEntity.__dispose();
newEntity.__dispose();
assert(oldComponent.destroyedBy === "v2", "existing Component did not use current Destroy System");
assert(newComponent.destroyedBy === "v2", "new Component did not use current Destroy System");
assert(TimerSystem.Instance.Count === 0, "disposing Component did not release repeated timers");

HotfixSystem.Begin(manifest("missing-system"));
let missingSystemRejected = false;
try {
  HotfixSystem.Commit();
} catch {
  missingSystemRejected = true;
}
assert(missingSystemRejected, "candidate missing a required System was accepted");
assert(
  HotfixSystem.Status().activeVersion === "system-v2",
  "missing System candidate changed the active generation",
);

const slots = new HotfixBindingStore<{ handler: () => number }>("test-handler");
slots.Register("rpc:1", { handler: () => 1 });
const stableSlot = slots.Values()[0];
HotfixSystem.Begin(manifest("binding-v1"));
systemFor(LifecycleComponent)(LifecycleSystemV2);
slots.Register("rpc:1", { handler: () => 1 });
HotfixSystem.Commit();
assert(stableSlot.handler() === 1, "initial handler slot was not committed");

HotfixSystem.Begin(manifest("binding-v2"));
systemFor(LifecycleComponent)(LifecycleSystemV2);
slots.Register("rpc:1", { handler: () => 2 });
HotfixSystem.Commit();
assert(slots.Values()[0] === stableSlot, "handler slot identity changed");
assert(stableSlot.handler() === 2, "stable handler slot did not switch implementation");

HotfixSystem.Begin(manifest("missing-binding"));
systemFor(LifecycleComponent)(LifecycleSystemV2);
let missingBindingRejected = false;
try {
  HotfixSystem.Commit();
} catch (error) {
  missingBindingRejected = String(error).includes("test-handler:rpc:1");
}
assert(missingBindingRejected, "candidate missing an active Handler binding was accepted");
assert(stableSlot.handler() === 2, "missing Handler candidate changed the active slot");
assert(
  HotfixSystem.Status().activeVersion === "binding-v2",
  "missing Handler candidate changed the active generation",
);

HotfixSystem.Begin(manifest("extra-binding"));
systemFor(LifecycleComponent)(LifecycleSystemV2);
slots.Register("rpc:1", { handler: () => 3 });
slots.Register("rpc:2", { handler: () => 4 });
let extraBindingRejected = false;
try {
  HotfixSystem.Commit();
} catch (error) {
  extraBindingRejected = String(error).includes("test-handler:rpc:2");
}
assert(extraBindingRejected, "candidate adding a new Handler binding was accepted");
assert(slots.Values().length === 1, "extra Handler candidate changed the active key set");
assert(stableSlot.handler() === 2, "extra Handler candidate changed the active slot");
assert(
  HotfixSystem.Status().activeVersion === "binding-v2",
  "extra Handler candidate changed the active generation",
);

Object.defineProperty(stableSlot, "locked", {
  value: 1,
  configurable: false,
  writable: false,
});
HotfixSystem.Begin(manifest("broken-binding"));
systemFor(LifecycleComponent)(LifecycleSystemV2);
slots.Register("rpc:1", Object.defineProperty(
  { handler: () => 999 },
  "locked",
  { value: 2, configurable: false },
));
let brokenBindingRejected = false;
try {
  HotfixSystem.Commit();
} catch {
  brokenBindingRejected = true;
}
assert(brokenBindingRejected, "broken Handler candidate was accepted");
assert(stableSlot.handler() === 2, "Handler rollback changed the active slot");

// 首次安装一个新System时，第二个prototype方法失败也不能泄漏第一个已写入的方法。
// A failed second prototype method during first installation must not leak the first method.
Object.defineProperty(PartialPrototypeTarget.prototype, "locked", {
  value: function lockedBaseline(): string { return "baseline"; },
  configurable: false,
  writable: false,
});
HotfixSystem.Begin(manifest("partial-prototype"));
systemFor(LifecycleComponent)(LifecycleSystemV2);
slots.Register("rpc:1", { handler: () => 2 });
systemFor(PartialPrototypeTarget)(PartialPrototypeBrokenSystem);
let partialPrototypeRejected = false;
try {
  HotfixSystem.Commit();
} catch (error) {
  partialPrototypeRejected = String(error).includes("Cannot redefine property") ||
    String(error).includes("cannot redefine property") ||
    String(error).includes("define property");
}
assert(partialPrototypeRejected, "partial prototype candidate was accepted");
assert(!Object.hasOwn(PartialPrototypeTarget.prototype, "First"), "partial prototype leaked First");
assert(
  (PartialPrototypeTarget.prototype as unknown as { locked: () => string }).locked() === "baseline",
  "partial prototype changed locked baseline",
);
assert(HotfixSystem.Status().phase === "idle", "failed prototype commit left Hotfix phase locked");

HotfixSystem.Begin(manifest("partial-prototype-recovery"));
systemFor(LifecycleComponent)(LifecycleSystemV2);
slots.Register("rpc:1", { handler: () => 2 });
systemFor(PartialPrototypeTarget)(PartialPrototypeGoodSystem);
HotfixSystem.Commit();
const partialEntity = new TestEntity();
const partialComponent = partialEntity.AddComponent(PartialPrototypeTarget);
assert((partialComponent as unknown as { First(): string }).First() === "good", "recovered prototype was not installed");
partialEntity.__dispose();
SingletonRegistry.DestroyAll();

process.stdout.write("hotfix system self-test passed\n");

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

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
