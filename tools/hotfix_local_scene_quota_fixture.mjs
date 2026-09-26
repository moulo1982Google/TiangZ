import assert from "node:assert/strict";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

// 本地调用通过真实远程 RPC 等待 Worker 结果；不靠 Spawn 或时间等待维持屏障。 / Local calls await real Worker RPC completion, without borrowing Spawn or elapsed-time waits.
export async function installLocalSceneQuotaFixture(module) {
  const replace = (source, before, after) => {
    assert.equal(source.split(before).length - 1, 1, `fixture anchor changed: ${before}`);
    return source.replace(before, after);
  };
  const modelFile = path.join(module, "src/model/counter/CounterScene.ts");
  await writeFile(modelFile, replace(await readFile(modelFile, "utf8"), "export class CounterScene extends EntryScene {", `export class CounterScene extends EntryScene {
  localQuotaTargetWait: Promise<void> | undefined;
  localQuotaWorkerGate: Promise<void> | undefined;
  localQuotaWorkerRelease: (() => void) | undefined;
  localQuotaWorkerWaiting = 0;
  localQuotaPendingRpc = 0;
  localQuotaReceived = 0;
  localQuotaCompleted = 0;
  localQuotaFailures = 0;`));
  await appendFile(path.join(module, "proto/Starter_C_40000.proto"), `
// @ets.msg protocol=Starter method=LocalQuota
message C2S_LocalQuota // IMessage
{
  uint32 sceneIndex = 1;
}
`);
  await appendFile(path.join(module, "proto/Starter_S_22000.proto"), `
// @ets.msg protocol=Starter method=LocalHold
message S2S_LocalHold // IMessage
{
  uint32 value = 1;
}
`);
  const handlerFile = path.join(module, "src/hotfix/counter/handlers/IncrementHandler.ts");
  await writeFile(handlerFile, 'import { handleLocalQuotaControl } from "./LocalQuotaControl";\n' +
    replace(await readFile(handlerFile, "utf8"), "const codeVersion = 10;", `const codeVersion = 10;
    if (request.mode !== undefined && request.mode >= 47 && request.mode <= 63) return handleLocalQuotaControl(scene, request.mode);`));
  await writeFile(path.join(module, "src/hotfix/counter/handlers/LocalQuotaControl.ts"), `import { CounterScene, StarterProtocol, StarterMessages } from "#tiangz/module";

export function waitForWorker(scene: CounterScene): Promise<void> {
  scene.localQuotaReceived++;
  scene.localQuotaTargetWait ??= scene.scenes.call(scene.scenes.byName("worker"), StarterProtocol.Work, { mode: 48 }, { timeoutMs: 30000 }).then(() => {});
  return scene.localQuotaTargetWait.then(() => { scene.localQuotaCompleted++; });
}

function fill(scene: CounterScene, index: number): void {
  const target = scene.scenes.byName("local-quota-" + index);
  for (let i = 0; i < 4096; i++) {
    if (i % 2) {
      scene.scenes.send(target, StarterMessages.LocalHold, { value: i });
    } else {
      scene.localQuotaPendingRpc++;
      void scene.scenes.call(target, StarterProtocol.Work, { mode: 47 })
        .catch(() => { scene.localQuotaFailures++; })
        .finally(() => { scene.localQuotaPendingRpc--; });
    }
  }
}

export async function handleLocalQuotaControl(scene: CounterScene, mode: number): Promise<{ count: number }> {
  if (mode === 47) { await waitForWorker(scene); return { count: 1 }; }
  if (mode === 48) {
    scene.localQuotaWorkerGate ??= new Promise<void>(resolve => { scene.localQuotaWorkerRelease = resolve; });
    scene.localQuotaWorkerWaiting++;
    try { await scene.localQuotaWorkerGate; return { count: 1 }; }
    finally { scene.localQuotaWorkerWaiting--; }
  }
  if (mode === 49) { fill(scene, 0); return { count: scene.localQuotaPendingRpc }; }
  if (mode === 50) { for (let i = 1; i < 4; i++) fill(scene, i); return { count: scene.localQuotaPendingRpc }; }
  if (mode === 51 || mode === 53) return scene.scenes.call(scene.scenes.byName("local-quota-" + (mode === 51 ? 0 : 4)), StarterProtocol.Work, { mode: 47 });
  if (mode === 52 || mode === 54) {
    scene.scenes.send(scene.scenes.byName("local-quota-" + (mode === 52 ? 0 : 4)), StarterMessages.LocalHold, { value: 0 });
    return { count: 1 };
  }
  if (mode === 55) { scene.localQuotaWorkerRelease?.(); scene.localQuotaWorkerRelease = undefined; return { count: 0 }; }
  if (mode === 56) return { count: scene.localQuotaPendingRpc };
  if (mode === 57) return { count: scene.localQuotaReceived };
  if (mode === 58) return { count: scene.localQuotaCompleted };
  if (mode === 59) return { count: scene.localQuotaFailures };
  if (mode === 60) return { count: scene.localQuotaWorkerWaiting };
  if (mode === 61) {
    if (scene.localQuotaPendingRpc || scene.localQuotaWorkerWaiting || scene.localQuotaReceived !== scene.localQuotaCompleted) throw new Error("local quota cleanup before actual completion");
    scene.localQuotaTargetWait = scene.localQuotaWorkerGate = undefined;
    scene.localQuotaWorkerRelease = undefined;
    return { count: 0 };
  }
  if (mode === 62) return scene.scenes.call(scene.scenes.byName("worker-local-quota"), StarterProtocol.Work, { mode: 63 });
  if (mode === 63) return { count: 1 };
  throw new Error("unknown local Scene quota fixture mode");
}
`);
  await writeFile(path.join(module, "src/hotfix/counter/handlers/LocalQuotaHandler.ts"), `import { messageHandler, type SceneMessageHandler } from "#tiangz/model";
import { CounterScene, StarterMessages, type C2S_LocalQuota } from "#tiangz/module";
@messageHandler(CounterScene, StarterMessages.LocalQuota)
export class LocalQuotaHandler implements SceneMessageHandler<CounterScene, C2S_LocalQuota> {
  handle(scene: CounterScene, message: C2S_LocalQuota) {
    return scene.scenes.send(scene.scenes.byName("local-quota-" + (message.sceneIndex ?? 0)), StarterMessages.LocalHold, { value: 0 });
  }
}
`);
  await writeFile(path.join(module, "src/hotfix/counter/handlers/LocalHoldHandler.ts"), `import { messageHandler, type SceneMessageHandler } from "#tiangz/model";
import { CounterScene, StarterMessages, type S2S_LocalHold } from "#tiangz/module";
import { waitForWorker } from "./LocalQuotaControl";
@messageHandler(CounterScene, StarterMessages.LocalHold)
export class LocalHoldHandler implements SceneMessageHandler<CounterScene, S2S_LocalHold> {
  handle(scene: CounterScene, _message: S2S_LocalHold) { return waitForWorker(scene); }
}
`);
  await appendFile(path.join(module, "src/hotfix/index.ts"), '\nimport "./counter/handlers/LocalQuotaHandler";\nimport "./counter/handlers/LocalHoldHandler";\n');
}
