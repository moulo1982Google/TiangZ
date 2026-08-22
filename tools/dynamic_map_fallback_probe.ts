import net from "node:net";
import readline from "node:readline";
import { BinaryReader } from "../app/core/protocol/binary";
import { LengthPrefixedFrameDecoder } from "../app/core/protocol/frame";
import {
  buildEnterMapPacket,
  buildEnterStarterDungeonPacket,
  buildLoginGatePacket,
  buildLoginPacket,
  buildRegisterPacket,
  decodeEnterMapFrame,
  decodeEnterStarterDungeonFrame,
  decodeLoginFrame,
  decodeLoginGateFrame,
  decodeRegisterFrame,
} from "./support/DemoClientProtocol";

const account = `dynamic_ha_${Date.now().toString(36)}`;
const password = `dynamic_ha_password_${account}`;
let nextRpcId = 1;

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await register();
  const firstLogin = await login();
  const first = await enter(firstLogin.gateIp, firstLogin.gatePort, firstLogin.token);
  const dungeon = decodeEnterStarterDungeonFrame(await first.connection.request(
    buildEnterStarterDungeonPacket(nextRpcId++, { operationId: `dynamic-ha-${Date.now()}` }),
    15_000,
  )).body;
  if (dungeon.error || dungeon.enterMap.mapId !== 200 || dungeon.enterMap.mapInstanceId <= 0n) {
    throw new Error(`dynamic dungeon entry failed: ${dungeon.error} ${dungeon.message}`);
  }
  await first.connection.close();
  console.log(`DYNAMIC_FALLBACK_READY ${JSON.stringify({
    account,
    mapInstanceId: dungeon.enterMap.mapInstanceId.toString(),
    unitId: dungeon.enterMap.unitId,
  })}`);

  await waitForCommand("continue");
  const recoveredLogin = await login();
  const recovered = await enter(recoveredLogin.gateIp, recoveredLogin.gatePort, recoveredLogin.token);
  try {
    if (recovered.mapId !== 1 || recovered.mapInstanceId !== 1n) {
      throw new Error(
        `lost dynamic map did not fall back to safe map: ${recovered.mapId}/${recovered.mapInstanceId}`,
      );
    }
    console.log(`DYNAMIC_FALLBACK_PASSED ${JSON.stringify({
      account,
      previousMapInstanceId: dungeon.enterMap.mapInstanceId.toString(),
      safeMapId: recovered.mapId,
      safeMapInstanceId: recovered.mapInstanceId.toString(),
    })}`);
  } finally {
    await recovered.connection.close();
  }
  // Windows下被强杀MapHost留下的TCP句柄可能延迟释放；断言完成后显式结束探针。
  // A killed MapHost may leave Windows TCP handles pending; exit explicitly
  // after all assertions and client cleanup have completed.
  setImmediate(() => process.exit(0));
}

async function register(): Promise<void> {
  const rpcId = nextRpcId++;
  const response = decodeRegisterFrame(await requestOne(
    "127.0.0.1",
    7001,
    buildRegisterPacket(rpcId, { account, password }),
  ));
  if (response.rpcId !== rpcId || response.body.error) {
    throw new Error(`Register failed: ${response.body.error} ${response.body.message}`);
  }
}

async function login() {
  const rpcId = nextRpcId++;
  const response = decodeLoginFrame(await requestOne(
    "127.0.0.1",
    7001,
    buildLoginPacket(rpcId, { account, password }),
  ));
  if (response.rpcId !== rpcId || response.body.error) {
    throw new Error(`Login failed: ${response.body.error} ${response.body.message}`);
  }
  return response.body;
}

async function enter(ip: string, port: number, token: string) {
  const connection = new TcpRpcConnection(ip, port);
  try {
    const gateLogin = decodeLoginGateFrame(await connection.request(buildLoginGatePacket(
      nextRpcId++,
      { account, token },
    ))).body;
    if (gateLogin.error) throw new Error(`LoginGate failed: ${gateLogin.message}`);
    const entered = decodeEnterMapFrame(await connection.request(buildEnterMapPacket(
      nextRpcId++,
      { mapId: 100, mapInstanceId: 100n },
    ), 20_000)).body;
    if (entered.error || entered.unitId <= 0) {
      throw new Error(`EnterMap failed: ${entered.error} ${entered.message}`);
    }
    return { ...entered, connection };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

function waitForCommand(expected: string): Promise<void> {
  const input = readline.createInterface({ input: process.stdin });
  return new Promise((resolve, reject) => {
    input.once("line", (line) => {
      input.close();
      if (line.trim() === expected) resolve();
      else reject(new Error(`expected command ${expected}, got ${line.trim()}`));
    });
  });
}

function requestOne(ip: string, port: number, packet: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    const decoder = new LengthPrefixedFrameDecoder();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`request ${ip}:${port} timed out`));
    }, 5_000);
    socket.once("connect", () => socket.write(Buffer.from(packet)));
    socket.on("data", (chunk: Buffer) => decoder.pushEach(chunk, (frame) => {
      clearTimeout(timer);
      socket.end();
      resolve(frame);
    }));
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

class TcpRpcConnection {
  private readonly socket: net.Socket;
  private readonly decoder = new LengthPrefixedFrameDecoder();
  private readonly connected: Promise<void>;
  private readonly closed: Promise<void>;
  private readonly pending = new Map<number, {
    resolve: (frame: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(ip: string, port: number) {
    this.socket = net.createConnection({ host: ip, port });
    this.connected = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));
    this.socket.on("data", (chunk: Buffer) => this.decoder.pushEach(chunk, (frame) => {
      const rpcId = extractRpcId(frame);
      if (rpcId === undefined) return;
      const pending = this.pending.get(rpcId);
      if (!pending) return;
      this.pending.delete(rpcId);
      clearTimeout(pending.timer);
      pending.resolve(frame);
    }));
    this.socket.on("close", () => this.rejectAll(new Error("Gate connection closed")));
  }

  async request(packet: Uint8Array, timeoutMs = 5_000): Promise<Uint8Array> {
    await this.connected;
    const rpcId = extractRpcId(packet.subarray(4));
    if (rpcId === undefined) throw new Error("request has no rpcId");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcId);
        reject(new Error(`RPC ${rpcId} timed out`));
      }, timeoutMs);
      this.pending.set(rpcId, { resolve, reject, timer });
      this.socket.write(Buffer.from(packet));
    });
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    this.socket.end();
    await this.closed;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function extractRpcId(frame: Uint8Array): number | undefined {
  if (frame.length < 2) return undefined;
  try {
    const reader = new BinaryReader(frame.subarray(2));
    while (!reader.eof()) {
      const tag = reader.tag();
      if (tag.fieldNo === 90 && tag.wireType === 0) return reader.uint32();
      reader.skip(tag.wireType);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
