import net from "node:net";
import {
  buildEnterMapPacket,
  buildGetLoginServiceAddrPacket,
  buildLoginGatePacket,
  buildLoginPacket,
  buildMapSnapshotReadyPacket,
  buildUseItemPacket,
  decodeEnterMapFrame,
  decodeGetLoginServiceAddrFrame,
  decodeLoginFrame,
  decodeLoginGateFrame,
  decodeMapSnapshotReadyFrame,
} from "./support/DemoClientProtocol";
import {
  G2C_BuffAddedCodec,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import { MsgCode } from "../client_sdk/typescript/Generated/Model/demo/protocol/msgcodes";
import { BinaryReader, readU16BE } from "../app/core/protocol/binary";
import { LengthPrefixedFrameDecoder } from "../app/core/protocol/frame";

const LOGIN_MGR_HOST = process.env.TIANGZ_LOGIN_HOST ?? "14.103.24.32";
const LOGIN_MGR_PORT = Number(process.env.TIANGZ_LOGIN_PORT ?? 17_000);

async function main(): Promise<void> {
  const loginAddress = await requestOne(
    LOGIN_MGR_HOST,
    LOGIN_MGR_PORT,
    buildGetLoginServiceAddrPacket(1),
  ).then((frame) => decodeGetLoginServiceAddrFrame(frame).body);
  const account = `buff_probe_${Date.now()}`;
  const login = await requestOne(
    loginAddress.ip,
    loginAddress.port,
    buildLoginPacket(2, { account }),
  ).then((frame) => decodeLoginFrame(frame).body);
  const gate = new ProbeConnection(login.gateIp, login.gatePort);
  try {
    const loginGate = decodeLoginGateFrame(
      await gate.request(buildLoginGatePacket(3, { account: login.account, token: login.token })),
    ).body;
    if (loginGate.error) throw new Error(`LoginGate failed: ${loginGate.error} ${loginGate.message ?? ""}`);

    const ready = gate.wait(MsgCode.G2C_MapReady, 5_000);
    const enter = decodeEnterMapFrame(
      await gate.request(buildEnterMapPacket(4, { mapId: 100, mapInstanceId: 0n })),
    ).body;
    if (enter.error) throw new Error(`EnterMap failed: ${enter.error} ${enter.message ?? ""}`);
    await ready;

    if (enter.entities.length === 0) {
      const snapshot = gate.wait(MsgCode.G2C_AoiDelta, 5_000);
      const response = decodeMapSnapshotReadyFrame(
        await gate.request(buildMapSnapshotReadyPacket(5, { unitId: enter.unitId })),
      ).body;
      if (response.error) throw new Error(`MapSnapshotReady failed: ${response.error} ${response.message ?? ""}`);
      await snapshot;
    }

    const largePotion = enter.items.find((item) => item.configId === 1002 && item.count > 0);
    if (!largePotion) throw new Error("EnterMap did not provide a usable item 1002");
    const added = gate.wait(MsgCode.G2C_BuffAdded, 5_000);
    const response = await gate.request(buildUseItemPacket(6, { itemId: largePotion.itemId }));
    const responseCode = readU16BE(response, 0);
    if (responseCode !== MsgCode.M2C_UseItem) {
      throw new Error(`UseItem response msgcode mismatch: ${responseCode}`);
    }
    const frame = await added;
    const message = G2C_BuffAddedCodec.decode(frame.subarray(2));
    console.log("BuffAdded external probe:", {
      account,
      unitId: enter.unitId,
      buffUnitId: message.buff.unitId,
      buffConfigId: message.buff.buffConfigId,
      buffInstanceId: message.buff.buffInstanceId.toString(),
      expireTimeMs: message.buff.expireTimeMs.toString(),
    });
    if (message.buff.unitId !== enter.unitId || message.buff.buffConfigId !== 2001) {
      throw new Error(`BuffAdded payload did not target the player: ${JSON.stringify({ unitId: message.buff.unitId, buffConfigId: message.buff.buffConfigId })}`);
    }
  } finally {
    await gate.close();
  }
}

class ProbeConnection {
  private readonly socket: net.Socket;
  private readonly decoder = new LengthPrefixedFrameDecoder();
  private readonly connected: Promise<void>;
  private readonly pending = new Map<number, { resolve: (frame: Uint8Array) => void; reject: (error: Error) => void }>();
  private readonly waiters = new Map<number, Array<{ resolve: (frame: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>>();

  constructor(host: string, port: number) {
    this.socket = net.createConnection({ host, port });
    this.connected = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) this.dispatch(frame);
    });
    this.socket.on("close", () => this.rejectAll(new Error("probe gate connection closed")));
  }

  async request(packet: Uint8Array): Promise<Uint8Array> {
    await this.connected;
    const rpcId = extractRpcId(packet.subarray(4));
    if (rpcId === undefined) throw new Error("probe request has no rpcId");
    return new Promise((resolve, reject) => {
      this.pending.set(rpcId, { resolve, reject });
      this.socket.write(Buffer.from(packet));
    });
  }

  wait(msgcode: number, timeoutMs: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(msgcode);
        if (list) this.waiters.set(msgcode, list.filter((item) => item.resolve !== resolve));
        reject(new Error(`message ${msgcode} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const list = this.waiters.get(msgcode) ?? [];
      list.push({ resolve, reject, timer });
      this.waiters.set(msgcode, list);
    });
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => this.socket.end(resolve));
  }

  private dispatch(frame: Uint8Array): void {
    const rpcId = extractRpcId(frame);
    if (rpcId !== undefined) {
      const request = this.pending.get(rpcId);
      if (request) {
        this.pending.delete(rpcId);
        request.resolve(frame);
        return;
      }
    }
    const msgcode = readU16BE(frame, 0);
    const list = this.waiters.get(msgcode);
    const waiter = list?.shift();
    if (!waiter) return;
    if (list!.length === 0) this.waiters.delete(msgcode);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const list of this.waiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }
}

function requestOne(host: string, port: number, packet: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const decoder = new LengthPrefixedFrameDecoder();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`request ${host}:${port} timed out`));
    }, 5_000);
    socket.once("connect", () => socket.write(Buffer.from(packet)));
    socket.on("data", (chunk: Buffer) => {
      const frames = decoder.push(chunk);
      if (frames.length === 0) return;
      clearTimeout(timeout);
      socket.end();
      resolve(frames[0]);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function extractRpcId(frame: Uint8Array): number | undefined {
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
