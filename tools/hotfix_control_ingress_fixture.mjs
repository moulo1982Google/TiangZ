import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

// 单一真实 Inner TCP 输入，Model 共享结果等待；不创建数万物理连接或修改默认额度。 / Uses one real Inner TCP producer and a Model-owned result wait, without thousands of sockets or quota overrides.
export async function installControlIngressFixture(module) {
  const replace = (source, before, after) => {
    assert.equal(source.split(before).length - 1, 1, `fixture anchor changed: ${before}`);
    return source.replace(before, after);
  };
  const modelFile = path.join(module, "src/model/counter/CounterScene.ts");
  await writeFile(modelFile, replace(await readFile(modelFile, "utf8"), "export class CounterScene extends EntryScene {", `export class CounterScene extends EntryScene {
  controlIngressGate: Promise<unknown> | undefined;
  controlIngressStarted = 0;
  controlIngressCompleted = 0;`));
  const handlerFile = path.join(module, "src/hotfix/counter/handlers/IncrementHandler.ts");
  await writeFile(handlerFile, 'import { handleControlIngress } from "./ControlIngress";\n' +
    replace(await readFile(handlerFile, "utf8"), "const codeVersion = 10;", `const codeVersion = 10;
    if (request.mode !== undefined && request.mode >= 90 && request.mode <= 94) return handleControlIngress(scene, request.mode);`));
  await writeFile(path.join(module, "src/hotfix/counter/handlers/ControlIngress.ts"), `import { CounterScene, StarterProtocol } from "#tiangz/module";

export async function handleControlIngress(scene: CounterScene, mode: number): Promise<{ count: number }> {
  if (mode === 90) {
    if (scene.controlIngressGate) throw new Error("control fixture already started");
    scene.controlIngressGate = scene.scenes.call(scene.scenes.byName("worker"), StarterProtocol.Work, { mode: 79 }, { timeoutMs: 30000 });
    await scene.controlIngressGate;
    return { count: 1 };
  }
  if (mode === 91) {
    if (!scene.controlIngressGate) throw new Error("control fixture is not ready");
    scene.controlIngressStarted++;
    await scene.controlIngressGate;
    scene.controlIngressCompleted++;
    return { count: scene.controlIngressCompleted };
  }
  if (mode === 92) return { count: scene.controlIngressStarted };
  if (mode === 93) return { count: scene.controlIngressCompleted };
  if (mode === 94) {
    if (scene.controlIngressStarted !== scene.controlIngressCompleted) throw new Error("control fixture is still busy");
    scene.controlIngressGate = undefined;
    scene.controlIngressStarted = scene.controlIngressCompleted = 0;
  }
  return { count: 0 };
}
`);
}

async function innerProducer(port, protocol, token) {
  const socket = net.connect({ host: "127.0.0.1", port });
  const pending = new Set(), completed = new Set(), settled = new Set();
  let buffered = Buffer.alloc(0), failure, sequence = 0, successes = 0, overloads = 0, closing = false;
  const check = () => { if (failure) throw failure; };
  socket.on("error", error => { failure ??= error; });
  socket.on("close", () => { if (!closing) failure ??= new Error("control ingress producer closed unexpectedly"); });
  socket.on("data", bytes => {
    try {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 4) {
        const size = buffered.readUInt32BE(0);
        assert.ok(size >= 2 && size <= 1024 * 1024);
        if (buffered.length < 4 + size) break;
        const frame = buffered.subarray(4, 4 + size); buffered = buffered.subarray(4 + size);
        let id;
        // 29998/6 字节是既有 Transport 过载信封，不是手写业务 protobuf。 / This is the existing transport overload envelope, not a handwritten business codec.
        if (frame.readUInt16BE(0) === 29998) {
          assert.equal(frame.length, 6); id = frame.readUInt32LE(2); overloads++;
        } else {
          assert.equal(frame.readUInt16BE(0), protocol.responseCode);
          const response = protocol.responseCodec.decode(frame.subarray(2));
          assert.equal(response.error ?? 0, 0);
          id = response.rpcId; successes++;
          assert.ok(!completed.has(response.count), "business request executed twice"); completed.add(response.count);
        }
        assert.ok(pending.delete(id), `unknown or duplicate response ${id}`);
        settled.add(id);
      }
    } catch (error) { failure ??= error; socket.destroy(); }
  });
  const write = bytes => new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()));
  try {
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const credential = Buffer.from(token), hello = Buffer.alloc(6 + credential.length);
    hello.write("ETSI"); hello.writeUInt16BE(credential.length, 4); credential.copy(hello, 6);
    await write(hello);
  } catch (error) { closing = true; socket.destroy(); throw error; }
  return {
    async send(count) {
      check(); assert.ok(sequence + count <= 100000, "bounded control fixture input exhausted");
      const packets = [];
      for (let i = 0; i < count; i++) {
        const id = ++sequence, body = protocol.requestCodec.encode({ rpcId: id, mode: 91 });
        const packet = Buffer.alloc(6 + body.length);
        packet.writeUInt32BE(2 + body.length); packet.writeUInt16BE(protocol.requestCode, 4); packet.set(body, 6);
        pending.add(id); packets.push(packet);
      }
      await write(Buffer.concat(packets)); check(); return sequence;
    },
    settled(id) { check(); return settled.has(id); },
    status() { check(); return { sent: sequence, pending: pending.size, successes, overloads }; },
    close() { closing = true; socket.destroy(); pending.clear(); completed.clear(); settled.clear(); },
  };
}

export async function runControlIngressFault({ port, healthPort, protocol, token, open, workerControl, until, sleep, begin, commit }) {
  const metrics = async () => {
    const response = await fetch(`http://127.0.0.1:${healthPort}/metrics`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const lines = (await response.text()).split("\n"), result = {};
    for (const name of ["reserved", "capacity", "max_reserved", "rejections_total", "waits_total"]) {
      const matching = lines.filter(line => line.startsWith(`tiangz_control_ingress_${name}{`));
      assert.equal(matching.length, 1); result[name] = Number(matching[0].split(" ").at(-1));
    }
    result.backingStore = {};
    const queued = lines.filter(line => line.startsWith('tiangz_scene_ingress_queue_length{') && line.includes('scene="control-ingress-target"'));
    assert.equal(queued.length, 1); result.targetQueued = Number(queued[0].split(' ').at(-1));
    for (const name of ["bytes", "max_bytes", "buffers", "created_total"]) {
      const matching = lines.filter(line => line.startsWith(`tiangz_process_host_backing_store_${name}{`));
      assert.equal(matching.length, 1);
      const value = Number(matching[0].split(" ").at(-1));
      assert.ok(Number.isSafeInteger(value) && value >= 0);
      result.backingStore[name] = value;
    }
    return result;
  };
  const control = await open(port);
  await workerControl.call(87);
  await until(async () => (await metrics()).reserved === 0, "control quota starts drained");
  const before = await metrics(), held = control.call(90); held.catch(() => {});
  let producer;
  try {
    await until(async () => (await workerControl.call(86)).count === 1, "control target awaits real Worker response");
    producer = await innerProducer(port, protocol, token);
    let current = before;
    // 避免把瞬时 Native channel 满当作共享 TS 配额：有限分批输入，采样共享指标。 / Pace finite input and inspect the shared quota rather than mistaking a full Native channel for TS saturation.
    for (let round = 0; current.reserved !== 65536 && round < 780; round++) {
      await producer.send(128); await sleep(5);
      if (round % 16 === 15) current = await metrics();
    }
    await until(async () => (current = await metrics()).reserved === 65536, "default control quota fills across Native and real TS", 3000);
    assert.equal(current.capacity, 65536); assert.equal(current.max_reserved, 65536);
    assert.equal(producer.status().successes, 0, "held handlers cannot finish before Worker release");
    const barrier = await producer.send(1);
    await until(async () => (await metrics()).rejections_total > before.rejections_total, "extra Inner RPC receives quota overload");
    // 最后一个 TCP 请求已拒绝且全部保留项已到 TS，才暂停；否则在途尾批会触发另一项 deferred 限额。
    // Pause only after the final TCP request is rejected and every reserved item reaches TS; an in-flight tail otherwise hits the separate deferred limit.
    await until(async () => producer.settled(barrier) && (await metrics()).targetQueued === 65536, "all control input reaches TS before hotfix pause");
    const op = begin(); await op.paused();
    await workerControl.call(81);
    assert.equal((await held).count, 1, "Host completion must pass even when control slots are full");
    await until(() => producer.status().pending === 0, "all accepted control RPCs finish after release", 15000);
    const pauseMs = await commit(op), delivery = producer.status();
    assert.ok(delivery.successes >= 65536); assert.ok(delivery.overloads >= 1);
    assert.equal(delivery.successes + delivery.overloads, delivery.sent);
    await until(async () => (await metrics()).reserved === 0, "control quota returns to zero");
    assert.equal((await control.call(93)).count, delivery.successes);
    const successes = delivery.successes;
    await producer.send(1);
    await until(() => producer.status().successes === successes + 1, "same Inner socket recovers after quota release");
    await control.call(94);
    const after = await metrics();
    assert.ok(after.backingStore.created_total > before.backingStore.created_total);
    assert.ok(after.backingStore.max_bytes > 0);
    // 自然 GC 没有业务完成时限；记录实际存活，不要求请求排空时字节已归零。 / Natural GC has no request deadline; record retention without requiring zero bytes at RPC drain.
    return { ...delivery, capacity: 65536, peak: current.max_reserved, reservedAfter: 0, backingStoreAtCapacity: current.backingStore, backingStoreAfter: after.backingStore, completionBypassedFullQuota: true, pauseMs, recovered: true };
  } finally {
    producer?.close();
    await workerControl.call(81).catch(() => {});
    await held.catch(() => {});
    control.close();
  }
}
