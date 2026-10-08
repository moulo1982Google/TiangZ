import assert from "node:assert/strict";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

// 临时模块通过正式协议填充真实远程队列，所有状态归 Model。 / A temporary module fills real remote queues through generated protocols, with state owned by Model.
export async function installHostOperationFixture(module) {
  const replace = (source, before, after) => {
    assert.equal(source.split(before).length - 1, 1, `fixture anchor changed: ${before}`);
    return source.replace(before, after);
  };
  const modelFile = path.join(module, "src/model/counter/CounterScene.ts");
  await writeFile(modelFile, replace(await readFile(modelFile, "utf8"), "export class CounterScene extends EntryScene {", `export class CounterScene extends EntryScene {
  hostOperationSeen = new Set<number>();
  hostOperationReceived = 0;
  hostOperationDuplicates = 0;
  hostOperationBlobBytes = 0;
  hostOperationBlobs = 0;
  hostOperationProbeCalls = 0;`));
  await appendFile(path.join(module, "proto/Starter_S_22000.proto"), `
// @ets.msg protocol=Starter method=HostQueued
message S2S_HostQueued // IMessage
{
  uint32 sequence = 1;
}
// @ets.msg protocol=Starter method=HostBlob
message S2S_HostBlob // IMessage
{
  bytes payload = 1;
}
`);
  const handlerFile = path.join(module, "src/hotfix/counter/handlers/IncrementHandler.ts");
  await writeFile(handlerFile, 'import { handleHostOperationControl } from "./HostOperationControl";\n' +
    replace(await readFile(handlerFile, "utf8"), "const codeVersion = 10;", `const codeVersion = 10;
    if (request.mode !== undefined && request.mode >= 66 && request.mode <= 77) return handleHostOperationControl(scene, request.mode);`));
  await writeFile(path.join(module, "src/hotfix/counter/handlers/HostOperationControl.ts"), `import { CounterScene, StarterMessages, StarterProtocol } from "#tiangz/module";

function overloaded(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 1011;
}

async function rejectNewWork(scene: CounterScene): Promise<{ count: number }> {
  const target = scene.scenes.byName("worker");
  let count = 0;
  try { scene.scenes.send(target, StarterMessages.HostQueued, { sequence: 65536 }); }
  catch (error) { if (!overloaded(error)) throw error; count++; }
  try { await scene.scenes.call(target, StarterProtocol.Work, { mode: 70 }); }
  catch (error) { if (!overloaded(error)) throw error; count++; }
  if (count !== 2) throw new Error("shared Host queue accepted overflow work");
  return { count };
}

export async function handleHostOperationControl(scene: CounterScene, mode: number): Promise<{ count: number }> {
  if (mode === 66) {
    for (let sequence = 0; sequence < 65536; sequence++) scene.scenes.send(scene.scenes.byName("worker"), StarterMessages.HostQueued, { sequence });
    return rejectNewWork(scene);
  }
  if (mode === 67) return { count: scene.hostOperationReceived };
  if (mode === 68) return { count: scene.hostOperationSeen.size };
  if (mode === 69) return { count: scene.hostOperationDuplicates };
  if (mode === 70) { scene.hostOperationProbeCalls++; return { count: 1 }; }
  if (mode === 71) {
    scene.hostOperationSeen.clear();
    scene.hostOperationReceived = scene.hostOperationDuplicates = scene.hostOperationBlobBytes = scene.hostOperationBlobs = scene.hostOperationProbeCalls = 0;
    return { count: 0 };
  }
  if (mode === 72) {
    const target = scene.scenes.byName("worker"), maxFrame = 1048576, packetBytes = 67108864;
    const payload = new Uint8Array(maxFrame - 6);
    const tailFrame = packetBytes - 4 - 63 * (maxFrame + 17) - 17;
    const tail = new Uint8Array(tailFrame - 6);
    if (StarterMessages.HostBlob.codec.encode({ payload }).length + 2 !== maxFrame ||
      StarterMessages.HostBlob.codec.encode({ payload: tail }).length + 2 !== tailFrame) throw new Error("generated blob frame size changed");
    for (let i = 0; i < 63; i++) scene.scenes.send(target, StarterMessages.HostBlob, { payload });
    scene.scenes.send(target, StarterMessages.HostBlob, { payload: tail });
    return rejectNewWork(scene);
  }
  if (mode === 73) return { count: scene.hostOperationBlobs };
  if (mode === 74) return { count: scene.hostOperationBlobBytes };
  if (mode === 75) return { count: scene.hostOperationProbeCalls };
  if (mode === 76) return scene.scenes.call(scene.scenes.byName("worker"), StarterProtocol.Work, { mode: 70 });
  if (mode === 77) return { count: 0 };
  throw new Error("unknown Host operation fixture mode");
}
`);
  await writeFile(path.join(module, "src/hotfix/counter/handlers/HostQueuedHandler.ts"), `import { messageHandler, type SceneMessageHandler } from "#tiangz/model";
import { CounterScene, StarterMessages, type S2S_HostQueued } from "#tiangz/module";
@messageHandler(CounterScene, StarterMessages.HostQueued)
export class HostQueuedHandler implements SceneMessageHandler<CounterScene, S2S_HostQueued> {
  handle(scene: CounterScene, message: S2S_HostQueued) {
    const sequence = message.sequence ?? 0;
    scene.hostOperationReceived++;
    if (scene.hostOperationSeen.has(sequence)) scene.hostOperationDuplicates++;
    scene.hostOperationSeen.add(sequence);
  }
}
`);
  await writeFile(path.join(module, "src/hotfix/counter/handlers/HostBlobHandler.ts"), `import { messageHandler, type SceneMessageHandler } from "#tiangz/model";
import { CounterScene, StarterMessages, type S2S_HostBlob } from "#tiangz/module";
@messageHandler(CounterScene, StarterMessages.HostBlob)
export class HostBlobHandler implements SceneMessageHandler<CounterScene, S2S_HostBlob> {
  handle(scene: CounterScene, message: S2S_HostBlob) {
    scene.hostOperationBlobs++;
    scene.hostOperationBlobBytes += message.payload?.length ?? 0;
  }
}
`);
  await appendFile(path.join(module, "src/hotfix/index.ts"), '\nimport "./counter/handlers/HostQueuedHandler";\nimport "./counter/handlers/HostBlobHandler";\n');
}
