import { runSelfTest } from "./self_test_entry";
import { strict as assert } from "node:assert";

import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import {
  defineGameModule,
  sealGameModules,
} from "../app/core/modules/GameModuleSystem";
import {
  applyEntityExtensions,
  entityExtensionHandler,
  type EntityExtensionHandler,
} from "../app/core/modules/EntityExtensionSystem";
import { Component, Entity } from "../app/core/runtime/entities";
import { systemFor } from "../app/core/hotReload/HotfixSystem";
export function main(): void {
  class GreetingCounter extends Component {
    protected count = 0;
  }

  class ExtensionTarget extends Entity {}
  class ExtensionMarker extends Component {}
  class AttachExtensionMarker implements EntityExtensionHandler<ExtensionTarget> {
    Attach(entity: ExtensionTarget): void {
      entity.AddComponent(ExtensionMarker);
    }
  }

  assert.throws(
    () => defineGameModule({ id: "invalid", version: "1.0.0", modelExports: {} }),
    /invalid game module id/,
  );
  assert.throws(
    () => defineGameModule({ id: "org.example.invalid-version", version: "1.0.0-01", modelExports: {} }),
    /invalid game module version/,
  );
  const accessorExports = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessorExports, "Dynamic", {
    enumerable: true,
    get: () => ({}),
  });
  assert.throws(
    () => defineGameModule({
      id: "org.example.accessor",
      version: "1.0.0",
      modelExports: accessorExports,
    }),
    /enumerable data properties/,
  );

  const moduleMetadata = { labels: ["fixture"] };

  defineGameModule({
    id: "org.example.greeting",
    version: "1.0.0+fixture.1",
    modelExports: { GreetingCounter, moduleMetadata },
    requiredSystems: [GreetingCounter],
  });
  sealGameModules([{ id: "org.example.greeting", version: "1.0.0+fixture.1" }], {
    "org.example.greeting": { GreetingCounter },
  });
  const publicApis = (globalThis as typeof globalThis & {
    __tiangzModulePublicApis: Record<string, Record<string, unknown>>;
  }).__tiangzModulePublicApis;
  assert.equal(publicApis["org.example.greeting"].GreetingCounter, GreetingCounter);
  assert.equal(Object.isFrozen(publicApis["org.example.greeting"]), true);
  assert.equal(Reflect.set(publicApis, "injected", {}), false);

  const installed = (globalThis as typeof globalThis & {
    __tiangzModuleModelExports: Record<string, Record<string, unknown>>;
  }).__tiangzModuleModelExports;
  assert.equal(installed["org.example.greeting"].GreetingCounter, GreetingCounter);
  assert.equal(installed["org.example.greeting"].moduleMetadata, moduleMetadata);
  assert.equal(Object.isFrozen(installed), true);
  assert.equal(Object.isFrozen(installed["org.example.greeting"]), true);
  assert.equal(Object.isFrozen(moduleMetadata), true);
  assert.equal(Object.isFrozen(moduleMetadata.labels), true);
  assert.equal(Reflect.set(moduleMetadata, "changed", true), false);
  assert.throws(
    () => defineGameModule({ id: "org.example.late", version: "1.0.0", modelExports: {} }),
    /registration is sealed/,
  );

  HotfixSystem.Begin(manifest("missing"));
  assert.throws(() => HotfixSystem.Commit(), /required System is missing/);

  HotfixSystem.Begin(manifest("complete"));
  systemFor(GreetingCounter)(class GreetingCounterSystem extends GreetingCounter {
    Increment(): number {
      this.count += 1;
      return this.count;
    }
  });
  entityExtensionHandler(ExtensionTarget, { id: "org.example.extension-marker" })(
    AttachExtensionMarker,
  );
  const status = HotfixSystem.Commit();
  assert.equal(status.activeGeneration, 1);
  assert.equal(status.activeVersion, "complete");

  const extended = new ExtensionTarget();
  assert.deepEqual(applyEntityExtensions(extended), { handlerCount: 1 });
  assert.equal(extended.HasComponent(ExtensionMarker), true);
  assert.throws(() => applyEntityExtensions(extended), /already applied/);

  process.stdout.write("game module system self-test passed\n");

  function manifest(bundleVersion: string): HotfixManifest {
    return {
      formatVersion: 1,
      bundleVersion,
      modelFingerprint: "module-self-test",
      modelSourceHash: "module-self-test",
      protocolFingerprint: "module-self-test",
      stableCoreApiHash: "module-self-test",
      nativeSchemaHash: "module-self-test",
      hotfixHash: bundleVersion,
      buildMode: "demo",
    };
  }
}

runSelfTest(main);
