import assert from "node:assert/strict";

import {
  RuntimeDataPackRegistry,
  type RuntimeDataPackInput,
} from "../app/core/content/RuntimeDataPackRegistry";
import { ProcessRuntime } from "../app/core/process/ProcessRuntime";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import { defineGameModule, sealGameModules } from "../app/core/modules/GameModuleSystem";

interface CardCatalog {
  readonly cards: readonly {
    readonly id: number;
    readonly labels: readonly string[];
  }[];
}

void main();

async function main(): Promise<void> {
  defineGameModule({ id: "org.example.cards", version: "1.0.0" });
  sealGameModules([{ id: "org.example.cards", version: "1.0.0" }]);
  await acceptsAndFreezesNeutralDataPacks();
  rejectsDuplicatePackIdsAndRollsBackBootstrap();
  rejectsNonJsonPayloadsAndRollsBackBootstrap();
  process.stdout.write("runtime data pack self-test passed\n");
}

async function acceptsAndFreezesNeutralDataPacks(): Promise<void> {
  const later = pack("org.example.cards.expansion", "b", 2);
  const base = pack("org.example.cards.base", "a", 1);
  const runtime = new ProcessRuntime({
    process: { name: "neutral-data-pack" },
    scenes: [],
    knownScenes: [],
    tickMs: 50,
    dataPacks: [later, base],
  });

  try {
    const registry = RuntimeDataPackRegistry.Instance;
    assert.equal(registry.Count, 2);
    assert.deepEqual(
      registry.List("org.example.cards").map((entry) => entry.id),
      ["org.example.cards.base", "org.example.cards.expansion"],
    );
    const installed = registry.Get<CardCatalog>("org.example.cards.base");
    assert.equal(installed.ownerModuleId, "org.example.cards");
    assert.equal(installed.payload.cards[0]?.id, 1);
    assert.equal(Object.isFrozen(installed), true);
    assert.equal(Object.isFrozen(installed.payload), true);
    assert.equal(Object.isFrozen(installed.payload.cards), true);
    assert.equal(Object.isFrozen(installed.payload.cards[0]?.labels), true);
    assert.equal(Reflect.set(installed.payload.cards[0]!, "id", 99), false);
    assert.equal(registry.TryGet("org.example.missing"), undefined);
  } finally {
    await runtime.stop();
  }

  assert.throws(() => RuntimeDataPackRegistry.Instance, /singleton not found/);
}

function rejectsDuplicatePackIdsAndRollsBackBootstrap(): void {
  assert.throws(
    () => new ProcessRuntime({
      process: { name: "duplicate-data-pack" },
      scenes: [],
      knownScenes: [],
      tickMs: 50,
      dataPacks: [
        pack("org.example.cards.base", "a", 1),
        pack("org.example.cards.base", "b", 2),
      ],
    }),
    /duplicate runtime data pack id: org\.example\.cards\.base/,
  );
  assert.equal(SingletonRegistry.TryGet(RuntimeDataPackRegistry), undefined);
}

function rejectsNonJsonPayloadsAndRollsBackBootstrap(): void {
  const invalid = pack("org.example.cards.invalid", "c", 3);
  (invalid.payload as { cards: unknown[] }).cards.push({ generatedAt: new Date() });
  assert.throws(
    () => new ProcessRuntime({
      process: { name: "invalid-data-pack" },
      scenes: [],
      knownScenes: [],
      tickMs: 50,
      dataPacks: [invalid],
    }),
    /payload must contain JSON values only/,
  );
  assert.equal(SingletonRegistry.TryGet(RuntimeDataPackRegistry), undefined);
}

function pack(id: string, hashCharacter: string, cardId: number): RuntimeDataPackInput {
  return {
    formatVersion: 1,
    id,
    ownerModuleId: "org.example.cards",
    contentHash: hashCharacter.repeat(64),
    source: `fixtures/${id}.runtime.pack.json`,
    fileHash: hashCharacter.repeat(64),
    payload: {
      cards: [{ id: cardId, labels: ["starter", "neutral"] }],
    },
  };
}
