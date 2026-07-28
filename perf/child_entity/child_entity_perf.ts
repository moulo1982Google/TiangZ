import { performance } from "node:perf_hooks";
import {
  Actor,
  ChildEntity,
  Component,
  Scene,
} from "../../app/core/runtime/entities";
import { InitializeGameSingletons } from "../../app/core/runtime/Game";
import { ProcessHost } from "../../app/core/runtime/host";
import { actor, component, scene } from "../../app/core/runtime/metadata";
import { SingletonRegistry } from "../../app/core/runtime/Singleton";

const childCount = positiveArg("--children", 100_000);
const lookupCount = positiveArg("--lookups", 1_000_000);

@scene({ sceneType: "ChildEntityPerf" })
class PerfScene extends Scene {}

@actor({ mailbox: "ordered" })
class PerfActor extends Actor {}

@component()
class PerfOwner extends Component {}

class PerfChild extends ChildEntity<[value: number]> {
  value = 0;

  protected override Awake(value: number): void {
    this.value = value;
  }
}

InitializeGameSingletons();
try {
  forceGc();
  const baselineHeap = process.memoryUsage().heapUsed;
  const host = new ProcessHost("child-entity-perf");
  host.spawnScene("perf:1", PerfScene);
  const actorInstance = host.spawnActor("perf:1", "owner", PerfActor);
  const owner = actorInstance.AddComponent(PerfOwner);

  const create = measure(() => {
    for (let id = 1; id <= childCount; id += 1) {
      owner.AddChild(PerfChild, id, id);
    }
  });
  forceGc();
  const retainedHeap = process.memoryUsage().heapUsed - baselineHeap;

  let checksum = 0;
  let seed = 0x1234_5678;
  const lookup = measure(() => {
    for (let index = 0; index < lookupCount; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const id = (seed % childCount) + 1;
      checksum += owner.GetChild(PerfChild, id).value;
    }
  });

  const iterate = measure(() => {
    for (const child of owner.GetChildren(PerfChild)) checksum += child.value;
  });

  const remove = measure(() => {
    for (let id = childCount; id >= 1; id -= 1) {
      owner.RemoveChild(PerfChild, id);
    }
  });
  forceGc();
  const releasedHeap = process.memoryUsage().heapUsed - baselineHeap;

  if (owner.ChildCount !== 0 || host.Root.Count !== 2) {
    throw new Error(
      `child entity leak: children=${owner.ChildCount} root=${host.Root.Count}`,
    );
  }

  const result = {
    childCount,
    lookupCount,
    checksum,
    createMs: create,
    createPerSecond: childCount / (create / 1000),
    lookupMs: lookup,
    lookupPerSecond: lookupCount / (lookup / 1000),
    iterateMs: iterate,
    iteratePerSecond: childCount / (iterate / 1000),
    removeMs: remove,
    removePerSecond: childCount / (remove / 1000),
    retainedHeapBytes: retainedHeap,
    retainedBytesPerChild: retainedHeap / childCount,
    releasedHeapBytes: releasedHeap,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  host.Dispose();
} finally {
  SingletonRegistry.DestroyAll();
}

function measure(run: () => void): number {
  const startedAt = performance.now();
  run();
  return performance.now() - startedAt;
}

function forceGc(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  gc?.();
  gc?.();
}

function positiveArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
