import assert from "node:assert/strict";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

// 只扩展本轮临时测试模块；业务协议仍交给正式生成器。 / Extends only the temporary fixture; production codegen still owns its protocol and SDK.
export async function installActorQuotaFixture(module) {
  const replace = (source, before, after, count = 1) => {
    assert.equal(source.split(before).length - 1, count, `fixture anchor changed: ${before}`);
    return source.replaceAll(before, after);
  };
  const modelFile = path.join(module, "src/model/counter/CounterScene.ts");
  let model = await readFile(modelFile, "utf8");
  model = replace(model, "@entryScene()", '@actor({ mailbox: "unordered" })\nexport class QuotaActor extends ActorUnit {}\n@entryScene()');
  model = replace(model, "export class CounterScene extends EntryScene {", `export class CounterScene extends EntryScene {
  actorQuotaOwners: QuotaActor[] = [];
  actorQuotaWait: Promise<void> | undefined;
  actorQuotaRelease: (() => void) | undefined;
  actorQuotaPending = 0;
  actorQuotaStarted = 0;
  actorQuotaProbeCalls = 0;
  actorQuotaUnexpectedFailures = 0;`);
  await writeFile(modelFile, model);
  const index = path.join(module, "src/model/index.ts");
  let modelIndex = replace(await readFile(index, "utf8"), "DrainActor, DrainScene", "DrainActor, DrainScene, QuotaActor", 3);
  modelIndex = 'import { StarterMessages } from "./generated/protocol/starter/protocol/messageDescriptors";\n' +
    replace(modelIndex, "CounterComponent, StarterProtocol", "CounterComponent, StarterProtocol, StarterMessages", 2);
  await writeFile(index, modelIndex);
  await appendFile(path.join(module, "proto/Starter_C_40000.proto"), `
// @ets.msg protocol=Starter method=ActorQuota
message C2S_ActorQuota // IMessage
{
  uint32 actorIndex = 1;
}
`);
  const handlerFile = path.join(module, "src/hotfix/counter/handlers/IncrementHandler.ts");
  await writeFile(handlerFile, 'import { handleActorQuotaControl } from "./ActorQuotaHandler";\n' +
    replace(await readFile(handlerFile, "utf8"), "const codeVersion = 10;", `const codeVersion = 10;
    if (request.mode !== undefined && request.mode >= 34 && request.mode <= 46) {
      return { count: handleActorQuotaControl(scene, request.mode) };
    }`));
  await writeFile(path.join(module, "src/hotfix/counter/handlers/ActorQuotaHandler.ts"), `import { messageHandler, type SceneMessageHandler } from "#tiangz/model";
import { CounterScene, QuotaActor, StarterMessages, type C2S_ActorQuota } from "#tiangz/module";

@messageHandler(CounterScene, StarterMessages.ActorQuota)
export class ActorQuotaHandler implements SceneMessageHandler<CounterScene, C2S_ActorQuota> {
  handle(scene: CounterScene, message: C2S_ActorQuota) {
    return probe(scene, message.actorIndex ?? 0);
  }
}

function probe(scene: CounterScene, index: number): void | Promise<void> {
  const actor = scene.actorQuotaOwners[index];
  if (!actor) throw new Error("quota fixture Actor not found");
  return scene.RunLocalActorMailbox(actor, () => { scene.actorQuotaProbeCalls++; });
}

function hold(scene: CounterScene, index: number): void {
  const actor = scene.actorQuotaOwners[index]!, result = scene.actorQuotaWait!;
  for (let i = 0; i < 4096; i++) {
    const task = scene.RunLocalActorMailbox(actor, () => { scene.actorQuotaStarted++; return result; });
    scene.actorQuotaPending++;
    // 销毁后的实际结果仍由原 Host 计数；不得借 Spawn 的额度或屏障遮盖 Actor 行为。
    // Original Host tracks actual results after disposal, without borrowing Spawn quota or barriers.
    void Promise.resolve(task).catch(error => {
      if (!String(error).includes("actor despawned during mailbox execution")) scene.actorQuotaUnexpectedFailures++;
    }).finally(() => { scene.actorQuotaPending--; });
  }
}

export function handleActorQuotaControl(scene: CounterScene, mode: number): number {
  if (mode === 34) {
    if (scene.actorQuotaOwners.length) throw new Error("Actor quota fixture already active");
    scene.actorQuotaWait = new Promise<void>(resolve => { scene.actorQuotaRelease = resolve; });
    for (let i = 0; i < 5; i++) scene.actorQuotaOwners.push(scene.SpawnActor(9000 + i, QuotaActor));
    hold(scene, 0);
    return scene.actorQuotaPending;
  }
  if (mode === 35) { for (let i = 1; i < 4; i++) hold(scene, i); return scene.actorQuotaPending; }
  if (mode === 36 || mode === 37) { probe(scene, mode === 36 ? 0 : 4); return 1; }
  if (mode === 38) {
    let removed = 0;
    for (let i = 0; i < 4; i++) if (scene.DespawnActor(9000 + i)) removed++;
    return removed;
  }
  if (mode === 39) { scene.actorQuotaRelease?.(); scene.actorQuotaRelease = undefined; return 0; }
  if (mode === 40) return scene.actorQuotaPending;
  if (mode === 41) {
    if (scene.actorQuotaPending !== 0) throw new Error("cleanup before actual Actor completion");
    for (let i = 0; i < 5; i++) scene.DespawnActor(9000 + i);
    scene.actorQuotaOwners.length = 0; scene.actorQuotaWait = undefined;
    return 0;
  }
  if (mode === 42) return scene.actorQuotaProbeCalls;
  if (mode === 43) return scene.actorQuotaStarted;
  if (mode === 44) return scene.actorQuotaUnexpectedFailures;
  if (mode === 45 || mode === 46) {
    scene.scenes.send(scene.scenes.byName("counter"), StarterMessages.ActorQuota, { actorIndex: mode === 45 ? 0 : 4 });
    return 1;
  }
  throw new Error("unknown Actor quota fixture mode");
}
`);
  await appendFile(path.join(module, "src/hotfix/index.ts"), '\nimport "./counter/handlers/ActorQuotaHandler";\n');
}
