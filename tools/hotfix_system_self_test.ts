import {
  HotfixBindingStore,
  HotfixSystem,
  hotfixFor,
  systemFor,
} from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { Component, Entity } from "../app/core/runtime/entities";

class StableCounter {
  value = 10;

  Read(): number {
    return this.value;
  }
}

const instance = new StableCounter();
const slots = new HotfixBindingStore<{ handler: () => number }>("test-handler");

HotfixSystem.Begin(manifest("v1"));
class CounterV1 extends StableCounter {
  override Read(): number {
    return this.value + 1;
  }
}
hotfixFor(StableCounter)(CounterV1);
slots.Register("rpc:1", { handler: () => 1 });
HotfixSystem.Commit();
assert(instance.Read() === 11, "existing instance did not receive v1 prototype");
const stableSlot = slots.Values()[0];
assert(stableSlot.handler() === 1, "initial handler slot was not committed");

HotfixSystem.Begin(manifest("v2"));
class CounterV2 extends StableCounter {
  override Read(): number {
    return this.value + 2;
  }
}
hotfixFor(StableCounter)(CounterV2);
slots.Register("rpc:1", { handler: () => 2 });
HotfixSystem.Commit();
assert(instance.Read() === 12, "existing instance did not receive v2 prototype");
assert(slots.Values()[0] === stableSlot, "handler slot identity changed");
assert(stableSlot.handler() === 2, "stable handler slot did not switch implementation");

Object.defineProperty(stableSlot, "locked", {
  value: 1,
  configurable: false,
  writable: false,
});
HotfixSystem.Begin(manifest("broken"));
class BrokenCounter extends StableCounter {
  override Read(): number {
    return 999;
  }
}
hotfixFor(StableCounter)(BrokenCounter);
slots.Register("rpc:1", Object.defineProperty(
  { handler: () => 999 },
  "locked",
  { value: 2, configurable: false },
));
let rejected = false;
try {
  HotfixSystem.Commit();
} catch {
  rejected = true;
}
assert(rejected, "broken candidate was accepted");
assert(instance.Read() === 12, "prototype rollback did not restore v2");
assert(stableSlot.handler() === 2, "handler rollback changed active slot");

HotfixSystem.Begin(manifest("baseline"));
HotfixSystem.Commit();
assert(instance.Read() === 10, "omitted complete patch did not restore Model baseline");

class LifecycleComponent extends Component<[value: string]> {
  protected value = "";
  destroyedBy = "";

  Read(): string {
    return this.value;
  }
}

class TestEntity extends Entity {}

HotfixSystem.RequireType(LifecycleComponent);
HotfixSystem.Begin(manifest("missing-initial-system"));
let initialSystemRejected = false;
try {
  HotfixSystem.Commit();
} catch {
  initialSystemRejected = true;
}
assert(initialSystemRejected, "first candidate missing a Model-required System was accepted");

HotfixSystem.Begin(manifest("system-v1"));
class LifecycleSystemV1 extends LifecycleComponent {
  protected override Awake(value: string): void {
    this.value = `v1:${value}`;
  }

  protected override OnDestroy(): void {
    this.destroyedBy = "v1";
  }

  override Read(): string {
    return `read-v1:${this.value}`;
  }
}
systemFor(LifecycleComponent)(LifecycleSystemV1);
HotfixSystem.Commit();

const oldEntity = new TestEntity();
const oldComponent = oldEntity.AddComponent(LifecycleComponent, "old");
assert(oldComponent.Read() === "read-v1:v1:old", "System Awake v1 was not dispatched");

HotfixSystem.Begin(manifest("system-v2"));
class LifecycleSystemV2 extends LifecycleComponent {
  protected override Awake(value: string): void {
    this.value = `v2:${value}`;
  }

  protected override OnDestroy(): void {
    this.destroyedBy = "v2";
  }

  override Read(): string {
    return `read-v2:${this.value}`;
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
oldEntity.__dispose();
newEntity.__dispose();
assert(oldComponent.destroyedBy === "v2", "existing Component did not use current Destroy System");
assert(newComponent.destroyedBy === "v2", "new Component did not use current Destroy System");

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
