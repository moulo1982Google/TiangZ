import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// 正式 S 协议在真实 Worker 保留 256 个调用，Model 拥有结果等待和观测状态。 / Generated S RPCs retain 256 calls on a real Worker, with waits and observations owned by Model.
export async function installRemoteDeadlineFixture(module) {
  const replace = (source, before, after) => {
    assert.equal(source.split(before).length - 1, 1, `fixture anchor changed: ${before}`);
    return source.replace(before, after);
  };
  const modelFile = path.join(module, "src/model/counter/CounterScene.ts");
  await writeFile(modelFile, replace(await readFile(modelFile, "utf8"), "export class CounterScene extends EntryScene {", `export class CounterScene extends EntryScene {
  remoteDeadlineGate: Promise<void> | undefined;
  remoteDeadlineRelease: (() => void) | undefined;
  remoteDeadlineWaiting = 0;
  remoteDeadlinePending = 0;
  remoteDeadlineCompleted = 0;
  remoteDeadlineFailed = 0;
  remoteDeadlineShort = 0;
  remoteDeadlineUnexpectedRuns = 0;`));
  const handlerFile = path.join(module, "src/hotfix/counter/handlers/IncrementHandler.ts");
  await writeFile(handlerFile, 'import { handleRemoteDeadlineControl } from "./RemoteDeadlineControl";\n' +
    replace(await readFile(handlerFile, "utf8"), "const codeVersion = 10;", `const codeVersion = 10;
    if (request.mode !== undefined && request.mode >= 78 && request.mode <= 89) return handleRemoteDeadlineControl(scene, request.mode);`));
  await writeFile(path.join(module, "src/hotfix/counter/handlers/RemoteDeadlineControl.ts"), `import { CounterScene, StarterMessages, StarterProtocol } from "#tiangz/module";

export async function handleRemoteDeadlineControl(scene: CounterScene, mode: number): Promise<{ count: number }> {
  if (mode === 78) {
    const target = scene.scenes.byName("worker"), calls: Promise<unknown>[] = [];
    for (let i = 0; i < 256; i++) {
      scene.remoteDeadlinePending++;
      const call = scene.scenes.call(target, StarterProtocol.Work, { mode: 79 }, { timeoutMs: 30000 })
        .then(() => { scene.remoteDeadlineCompleted++; }, () => { scene.remoteDeadlineFailed++; })
        .finally(() => { scene.remoteDeadlinePending--; });
      calls.push(call);
    }
    try {
      scene.scenes.send(target, StarterMessages.HostQueued, { sequence: 90000 }, { timeoutMs: 80 });
      try {
        await scene.scenes.call(target, StarterProtocol.Work, { mode: 80 }, { timeoutMs: 80 });
        scene.remoteDeadlineShort = 2;
      } catch (error) {
        scene.remoteDeadlineShort = typeof error === "object" && error !== null && "code" in error && error.code === 1006 &&
          error instanceof Error && error.message.includes("timed out before dispatch") ? 1 : 3;
      }
    } finally { await Promise.all(calls); }
    if (scene.remoteDeadlineShort !== 1 || scene.remoteDeadlineFailed !== 0) throw new Error("remote deadline fixture failed");
    return { count: scene.remoteDeadlineCompleted };
  }
  if (mode === 79) {
    if (!scene.remoteDeadlineGate) scene.remoteDeadlineGate = new Promise<void>(resolve => { scene.remoteDeadlineRelease = resolve; });
    scene.remoteDeadlineWaiting++;
    try { await scene.remoteDeadlineGate; return { count: 1 }; }
    finally { scene.remoteDeadlineWaiting--; }
  }
  if (mode === 80) { scene.remoteDeadlineUnexpectedRuns++; return { count: 1 }; }
  if (mode === 81) {
    scene.remoteDeadlineRelease?.(); scene.remoteDeadlineRelease = undefined; scene.remoteDeadlineGate = undefined;
    return { count: scene.remoteDeadlineWaiting };
  }
  if (mode === 83) return { count: scene.remoteDeadlinePending };
  if (mode === 84) return { count: scene.remoteDeadlineShort };
  if (mode === 85) return { count: scene.remoteDeadlineUnexpectedRuns };
  if (mode === 86) return { count: scene.remoteDeadlineWaiting };
  if (mode === 87) {
    if (scene.remoteDeadlineWaiting || scene.remoteDeadlinePending) throw new Error("deadline fixture still has live work");
    scene.remoteDeadlineCompleted = scene.remoteDeadlineFailed = scene.remoteDeadlineShort = scene.remoteDeadlineUnexpectedRuns = 0;
    return { count: 0 };
  }
  return { count: 0 };
}
`);
}
