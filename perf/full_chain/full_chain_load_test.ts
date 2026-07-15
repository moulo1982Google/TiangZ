import net from "node:net";
import { performance, PerformanceObserver } from "node:perf_hooks";
import v8 from "node:v8";
import { BinaryReader, readU16BE } from "../../app/core/protocol/binary";
import { LengthPrefixedFrameDecoder } from "../../app/core/protocol/frame";
import {
  buildEnterMapPacket,
  buildGetLoginServiceAddrPacket,
  buildLoginGatePacket,
  buildLoginPacket,
  buildMapProbePacket,
  buildMovePacket,
  decodeEnterMapFrame,
  decodeEntityMoveFrame,
  decodeGetLoginServiceAddrFrame,
  decodeLoginFrame,
  decodeLoginGateFrame,
  decodeMapProbeFrame,
  decodeMapReadyFrame,
} from "../../app/demo/client/LoginClientProtocol";
import { MsgCode } from "../../app/generated/model/client/demo/protocol/msgcodes";

interface Options {
  host: string;
  managerPort: number;
  players: number;
  setupConcurrency: number;
  warmupSeconds: number;
  durationSeconds: number;
  timeoutMs: number;
  movementTimeoutMs: number;
  moveRate: number;
  probeRate: number;
  label: string;
}

interface TimingResult {
  count: number;
  perSecond: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

interface PlayerResult {
  player: GamePlayer;
  setupLatencyMs: number;
}

const options = parseOptions(process.argv.slice(2));
let nextRpcId = 1;
const initialResourceUsage = process.resourceUsage();
let gcCount = 0;
let gcDurationMs = 0;
const gcObserver = new PerformanceObserver((items) => {
  for (const entry of items.getEntries()) {
    gcCount += 1;
    gcDurationMs += entry.duration;
  }
});
gcObserver.observe({ entryTypes: ["gc"] });

async function main(): Promise<void> {
  const setupStartedAt = performance.now();
  const players = await mapLimit(
    Array.from({ length: options.players }, (_, index) => index),
    options.setupConcurrency,
    createPlayer,
  );
  const setupElapsedSeconds = (performance.now() - setupStartedAt) / 1000;
  const setupLatencies = players.map((item) => item.setupLatencyMs).sort(numberOrder);

  const measurementStart = performance.now() + options.warmupSeconds * 1000;
  const sendDeadline = measurementStart + options.durationSeconds * 1000;
  const measurementStartedAtUnixMs = Date.now() + options.warmupSeconds * 1000;
  const workloads = await Promise.all(
    players.map(async ({ player }, index) => {
      const [movement, probe] = await Promise.all([
        player.runMovement(measurementStart, sendDeadline, index, options.moveRate),
        player.runProbes(measurementStart, sendDeadline, options.probeRate),
      ]);
      return { movement, probe };
    }),
  );

  const movementLatencies = workloads
    .flatMap((item) => item.movement.latenciesMs)
    .sort(numberOrder);
  const probeLatencies = workloads
    .flatMap((item) => item.probe.latenciesMs)
    .sort(numberOrder);
  const errors = workloads.reduce((sum, item) => sum + item.movement.errors, 0);
  const probeErrors = workloads.reduce((sum, item) => sum + item.probe.errors, 0);
  const pushes = players.reduce((sum, item) => sum + item.player.entityMovePushes, 0);
  await Promise.all(players.map(({ player }) => player.close()));
  gcObserver.disconnect();
  const finalResourceUsage = process.resourceUsage();
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();

  const result = {
    scenario: "gameplay-full-chain",
    label: options.label,
    players: options.players,
    setupConcurrency: options.setupConcurrency,
    warmupSeconds: options.warmupSeconds,
    durationSeconds: options.durationSeconds,
    targetMoveRatePerPlayer: options.moveRate,
    targetProbeRatePerPlayer: options.probeRate,
    measurementStartedAtUnixMs,
    measurementEndedAtUnixMs:
      measurementStartedAtUnixMs + options.durationSeconds * 1000,
    workload: options.moveRate > 0 ? `steady-${options.moveRate}hz` : "saturation",
    setup: {
      ...timing(setupLatencies, setupElapsedSeconds),
      elapsedSeconds: setupElapsedSeconds,
    },
    movement: {
      ...timing(movementLatencies, options.durationSeconds),
      entityMovePushes: pushes,
      pushesPerSecond: pushes / (options.warmupSeconds + options.durationSeconds),
      errors,
    },
    probe: {
      ...timing(probeLatencies, options.durationSeconds),
      errors: probeErrors,
    },
    loadGenerator: {
      cpuUserMs:
        (finalResourceUsage.userCPUTime - initialResourceUsage.userCPUTime) / 1000,
      cpuSystemMs:
        (finalResourceUsage.systemCPUTime - initialResourceUsage.systemCPUTime) / 1000,
      maxRssBytes: finalResourceUsage.maxRSS * 1024,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      v8HeapLimitBytes: heap.heap_size_limit,
      gcCount,
      gcDurationMs,
    },
  };

  console.log(
    `[full-chain:${options.label}/${result.workload}] players=${options.players} setup=${result.setup.perSecond.toFixed(1)} users/s ` +
      `moves=${result.movement.perSecond.toFixed(1)}/s pushes=${result.movement.pushesPerSecond.toFixed(1)}/s ` +
      `move_p50=${result.movement.p50Ms.toFixed(2)}ms p95=${result.movement.p95Ms.toFixed(2)}ms ` +
      `p99=${result.movement.p99Ms.toFixed(2)}ms errors=${errors} ` +
      `probe=${result.probe.perSecond.toFixed(1)}/s p90=${result.probe.p90Ms.toFixed(2)}ms ` +
      `p95=${result.probe.p95Ms.toFixed(2)}ms p99=${result.probe.p99Ms.toFixed(2)}ms errors=${probeErrors}`,
  );
  console.log(`RESULT_JSON ${JSON.stringify(result)}`);
}

async function createPlayer(index: number): Promise<PlayerResult> {
  const startedAt = performance.now();
  const account = `perf_${options.label}_${options.moveRate}_${options.players}_${index}_${Date.now()}`;
  const managerRpcId = allocateRpcId();
  const managerFrame = await requestOne(
    options.host,
    options.managerPort,
    buildGetLoginServiceAddrPacket(managerRpcId),
    options.timeoutMs,
  );
  const loginAddress = decodeGetLoginServiceAddrFrame(managerFrame).body;
  checkResponse(loginAddress, managerRpcId, "GetLoginServiceAddr");

  const loginRpcId = allocateRpcId();
  const loginFrame = await requestOne(
    loginAddress.ip,
    loginAddress.port,
    buildLoginPacket(loginRpcId, { account }),
    options.timeoutMs,
  );
  const login = decodeLoginFrame(loginFrame).body;
  checkResponse(login, loginRpcId, "Login");

  const gate = new GateConnection(login.gateIp, login.gatePort, options.timeoutMs);
  await gate.connect();
  const loginGateRpcId = allocateRpcId();
  const loginGate = decodeLoginGateFrame(
    await gate.request(
      loginGateRpcId,
      buildLoginGatePacket(loginGateRpcId, { account, token: login.token }),
    ),
  ).body;
  checkResponse(loginGate, loginGateRpcId, "LoginGate");

  const enterMapRpcId = allocateRpcId();
  const [enterMapFrame, mapReadyFrame] = await Promise.all([
    gate.request(enterMapRpcId, buildEnterMapPacket(enterMapRpcId, { mapId: 1 })),
    gate.waitForMessage(MsgCode.G2C_MapReady),
  ]);
  const enterMap = decodeEnterMapFrame(enterMapFrame).body;
  checkResponse(enterMap, enterMapRpcId, "EnterMap");
  const mapReady = decodeMapReadyFrame(mapReadyFrame).body;
  if (mapReady.unitId !== enterMap.unitId) {
    throw new Error(`MapReady unit mismatch for ${account}`);
  }
  gate.setUnitId(enterMap.unitId);
  return {
    player: new GamePlayer(gate),
    setupLatencyMs: performance.now() - startedAt,
  };
}

class GamePlayer {
  constructor(private readonly gate: GateConnection) {}

  get entityMovePushes(): number { return this.gate.entityMovePushes; }

  runMovement(
    measurementStart: number,
    sendDeadline: number,
    directionSeed: number,
    moveRate: number,
  ): Promise<{ latenciesMs: number[]; errors: number }> {
    return this.gate.runMovement(measurementStart, sendDeadline, directionSeed, moveRate);
  }

  runProbes(
    measurementStart: number,
    sendDeadline: number,
    probeRate: number,
  ): Promise<{ latenciesMs: number[]; errors: number }> {
    return this.gate.runProbes(measurementStart, sendDeadline, probeRate);
  }

  close(): Promise<void> { return this.gate.close(); }
}

class GateConnection {
  private readonly socket: net.Socket;
  private readonly decoder = new LengthPrefixedFrameDecoder();
  private readonly connected: Promise<void>;
  private readonly closed: Promise<void>;
  private readonly pendingRpc = new Map<number, PendingFrame>();
  private readonly messageWaiters = new Map<number, PendingFrame[]>();
  private unitId = 0;
  private moveHandler?: (frame: Uint8Array) => void;
  entityMovePushes = 0;

  constructor(ip: string, port: number, private readonly timeoutMs: number) {
    this.socket = net.createConnection({ host: ip, port });
    this.socket.setNoDelay(true);
    this.connected = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("close", () => this.rejectAll(new Error("gate connection closed")));
  }

  connect(): Promise<void> { return this.connected; }
  setUnitId(unitId: number): void { this.unitId = unitId; }

  async request(rpcId: number, packet: Uint8Array): Promise<Uint8Array> {
    await this.connected;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(rpcId);
        reject(new Error(`RPC ${rpcId} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pendingRpc.set(rpcId, { resolve, reject, timer });
      this.socket.write(packet);
    });
  }

  waitForMessage(msgcode: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const waiter: PendingFrame = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.messageWaiters.get(msgcode);
          const index = current?.indexOf(waiter) ?? -1;
          if (index >= 0) current!.splice(index, 1);
          reject(new Error(`message ${msgcode} timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs),
      };
      const waiters = this.messageWaiters.get(msgcode) ?? [];
      waiters.push(waiter);
      this.messageWaiters.set(msgcode, waiters);
    });
  }

  runMovement(
    measurementStart: number,
    sendDeadline: number,
    directionSeed: number,
    moveRate: number,
  ): Promise<{ latenciesMs: number[]; errors: number }> {
    const latenciesMs: number[] = [];
    let sequence = 0;
    let sentAt = 0;
    let nextSendAt = performance.now();
    let measured = false;
    let errors = 0;

    return new Promise((resolve) => {
      let finished = false;
      const hardTimeout = setTimeout(
        () => {
          errors += 1;
          finish();
        },
        Math.max(
          options.movementTimeoutMs,
          sendDeadline - performance.now() + options.movementTimeoutMs,
        ),
      );
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(hardTimeout);
        this.moveHandler = undefined;
        resolve({ latenciesMs, errors });
      };
      const sendNext = () => {
        const now = performance.now();
        if (now >= sendDeadline) {
          finish();
          return;
        }
        sequence += 1;
        sentAt = now;
        measured = now >= measurementStart;
        const axis = (directionSeed + sequence) & 1;
        this.socket.write(
          buildMovePacket({
            inputX: axis === 0 ? 1 : 0,
            inputY: axis === 0 ? 0 : 1,
            sequence,
          }),
          (error) => {
            if (error) {
              errors += 1;
              finish();
            }
          },
        );
      };
      this.moveHandler = (frame) => {
        const move = decodeEntityMoveFrame(frame).body;
        if (move.unitId !== this.unitId || move.sequence !== sequence) return;
        if (measured) latenciesMs.push(performance.now() - sentAt);
        if (moveRate <= 0) {
          sendNext();
          return;
        }
        nextSendAt += 1000 / moveRate;
        setTimeout(sendNext, Math.max(0, nextSendAt - performance.now()));
      };
      sendNext();
    });
  }

  async runProbes(
    measurementStart: number,
    sendDeadline: number,
    probeRate: number,
  ): Promise<{ latenciesMs: number[]; errors: number }> {
    const latenciesMs: number[] = [];
    let sequence = 0;
    let errors = 0;
    if (probeRate <= 0) return { latenciesMs, errors };

    while (performance.now() < sendDeadline) {
      const startedAt = performance.now();
      sequence += 1;
      const rpcId = allocateRpcId();
      try {
        const response = decodeMapProbeFrame(
          await this.request(
            rpcId,
            buildMapProbePacket(rpcId, { sequence }),
          ),
        ).body;
        checkResponse(response, rpcId, "MapProbe");
        if (response.sequence !== sequence) {
          throw new Error(`MapProbe sequence mismatch: ${response.sequence} != ${sequence}`);
        }
        if (startedAt >= measurementStart) {
          latenciesMs.push(performance.now() - startedAt);
        }
      } catch {
        errors += 1;
      }

      const elapsed = performance.now() - startedAt;
      await sleep(Math.max(0, 1000 / probeRate - elapsed));
    }
    return { latenciesMs, errors };
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    this.socket.end();
    await Promise.race([this.closed, sleep(1000)]);
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        const msgcode = readU16BE(frame);
        if (msgcode === MsgCode.G2C_EntityMove) {
          this.entityMovePushes += 1;
          this.moveHandler?.(frame);
          continue;
        }
        const rpcId = extractRpcId(frame);
        if (rpcId !== undefined) {
          const pending = this.pendingRpc.get(rpcId);
          if (!pending) continue;
          this.pendingRpc.delete(rpcId);
          clearTimeout(pending.timer);
          pending.resolve(frame);
          continue;
        }
        const waiter = this.messageWaiters.get(msgcode)?.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      }
    } catch (error) {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRpc.clear();
    for (const waiters of this.messageWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.messageWaiters.clear();
  }
}

interface PendingFrame {
  resolve: (frame: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function requestOne(
  host: string,
  port: number,
  packet: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const decoder = new LengthPrefixedFrameDecoder();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${host}:${port} request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => socket.write(packet));
    socket.on("data", (chunk: Buffer) => {
      const frame = decoder.push(chunk)[0];
      if (!frame) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(frame);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function checkResponse(
  response: { rpcId?: number; error?: number; message?: string },
  rpcId: number,
  operation: string,
): void {
  if (response.rpcId !== rpcId) throw new Error(`${operation} rpcId mismatch`);
  if (response.error) {
    throw new Error(`${operation} failed: ${response.error} ${response.message ?? ""}`);
  }
}

function extractRpcId(frame: Uint8Array): number | undefined {
  const reader = new BinaryReader(frame.subarray(2));
  while (!reader.eof()) {
    const tag = reader.tag();
    if (tag.fieldNo === 90 && tag.wireType === 0) return reader.uint32();
    reader.skip(tag.wireType);
  }
  return undefined;
}

function allocateRpcId(): number {
  const value = nextRpcId;
  nextRpcId = (nextRpcId % 0xffff_ffff) + 1;
  return value;
}

function timing(latencies: number[], elapsedSeconds: number): TimingResult {
  return {
    count: latencies.length,
    perSecond: latencies.length / elapsedSeconds,
    p50Ms: percentile(latencies, 0.50),
    p90Ms: percentile(latencies, 0.90),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.at(-1) ?? 0,
  };
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function mapLimit<T, TResult>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await worker(values[index]);
      }
    }),
  );
  return results;
}

function numberOrder(left: number, right: number): number { return left - right; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--?/, "").toLowerCase();
    const value = args[index + 1];
    if (key && value) values.set(key, value);
  }
  const number = (name: string, fallback: number) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid --${name}`);
    return value;
  };
  return {
    host: values.get("host") ?? "127.0.0.1",
    managerPort: Math.floor(number("manager-port", 7000)),
    players: Math.floor(number("players", 50)),
    setupConcurrency: Math.floor(number("setup-concurrency", 16)),
    warmupSeconds: number("warmup", 2),
    durationSeconds: number("duration", 5),
    timeoutMs: Math.floor(number("timeout", 15_000)),
    movementTimeoutMs: Math.floor(number("movement-timeout", 5_000)),
    moveRate: nonNegativeNumber(values, "move-rate", 0),
    probeRate: nonNegativeNumber(values, "probe-rate", 0),
    label: values.get("label") ?? "manual",
  };
}

function nonNegativeNumber(values: Map<string, string>, name: string, fallback: number): number {
  const value = Number(values.get(name) ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid --${name}`);
  return value;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
