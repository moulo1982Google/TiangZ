import net from "node:net";
import {
  buildEnterMapPacket,
  buildGetLoginServiceAddrPacket,
  buildLoginGatePacket,
  buildLoginPacket,
  buildMovePacket,
  decodeEntityMoveFrame,
  decodeEntityEnterFrame,
  decodeEntityLeaveFrame,
  decodeEnterMapFrame,
  decodeGetLoginServiceAddrFrame,
  decodeLoginGateFrame,
  decodeLoginFrame,
  decodeMapReadyFrame,
} from "../app/demo/client/LoginClientProtocol";
import { BinaryReader, readU16BE } from "../app/core/protocol/binary";
import { LengthPrefixedFrameDecoder } from "../app/core/protocol/frame";
import { MsgCode } from "../app/generated/model/client/demo/protocol/msgcodes";

async function main() {
  const loginAddr = await requestLoginServiceAddr("127.0.0.1", 7000);
  console.log("LoginMgr selected:", loginAddr);

  const [login1, login2] = await Promise.all([
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_user"),
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_user"),
  ]);
  const counts = [login1.loginCount, login2.loginCount].sort((a, b) => a - b);
  if (counts[0] !== 1 || counts[1] !== 2) {
    throw new Error(`expected actor login counts 1,2; got ${counts.join(",")}`);
  }
  console.log("Login responses:", login1, login2);

  const enterMap = await verifyGateSessionLifecycle(login1.gateIp, login1.gatePort, {
    account: login1.account,
    token: login1.token,
    mapId: 1,
  });
  console.log("EnterMap response:", enterMap);

  const peer = await requestLogin(loginAddr.ip, loginAddr.port, "smoke_peer");
  await verifySharedMapBroadcast(
    login1.gateIp,
    login1.gatePort,
    { account: login1.account, token: login1.token, mapId: 1 },
    { account: peer.account, token: peer.token, mapId: 1 },
  );
}

let nextRpcId = 1;

function requestLoginServiceAddr(ip: string, port: number) {
  const rpcId = nextRpcId++;
  return requestOne(ip, port, buildGetLoginServiceAddrPacket(rpcId)).then((frame) => {
    const response = decodeGetLoginServiceAddrFrame(frame);
    if (response.rpcId !== rpcId) {
      throw new Error(`GetLoginServiceAddr rpcId mismatch: ${response.rpcId}`);
    }
    if (response.body.error) {
      throw new Error(`GetLoginServiceAddr failed: ${response.body.error} ${response.body.message ?? ""}`);
    }
    return response.body;
  });
}

function requestLogin(ip: string, port: number, account: string) {
  const rpcId = nextRpcId++;
  return requestOne(ip, port, buildLoginPacket(rpcId, { account })).then((frame) => {
    const response = decodeLoginFrame(frame);
    if (response.rpcId !== rpcId) {
      throw new Error(`Login rpcId mismatch: ${response.rpcId}`);
    }
    if (response.body.error) {
      throw new Error(`Login failed: ${response.body.error} ${response.body.message ?? ""}`);
    }
    return response.body;
  });
}

async function verifyGateSessionLifecycle(
  ip: string,
  port: number,
  request: { account: string; token: string; mapId: number },
) {
  const first = await openGateAndEnterMap(ip, port, request);
  const second = await openGateAndEnterMap(ip, port, request);
  if (second.enterMap.unitId !== first.enterMap.unitId) {
    throw new Error("reconnected account did not reuse its existing map unit");
  }

  await first.gate.close();
  await sleep(150);
  const third = await openGateAndEnterMap(ip, port, request);
  if (third.enterMap.unitId !== first.enterMap.unitId) {
    throw new Error("stale Gate disconnect removed the newly rebound map unit");
  }

  await second.gate.close();
  await sleep(150);
  await third.gate.close();
  await sleep(150);

  const afterDisconnect = await openGateAndEnterMap(ip, port, request);
  try {
    if (afterDisconnect.enterMap.unitId <= first.enterMap.unitId) {
      throw new Error("valid Gate disconnect did not remove the map unit");
    }
    console.log("GateSession lifecycle:", {
      reboundUnitId: first.enterMap.unitId,
      recreatedUnitId: afterDisconnect.enterMap.unitId,
    });
    await verifyAuthoritativeMovement(afterDisconnect.gate, afterDisconnect.enterMap);
    return afterDisconnect.enterMap;
  } finally {
    await afterDisconnect.gate.close();
  }
}

async function verifyAuthoritativeMovement(
  gate: TcpRpcConnection,
  player: { unitId: number; x: number; y: number },
): Promise<void> {
  const firstFrame = gate.waitForMessage(MsgCode.G2C_EntityMove);
  await gate.send(buildMovePacket({ inputX: 1, inputY: 0, sequence: 1 }));
  const first = decodeEntityMoveFrame(await firstFrame).body;
  if (
    first.unitId !== player.unitId ||
    first.sequence !== 1 ||
    first.x <= player.x ||
    first.y !== player.y
  ) {
    throw new Error(`unexpected first authoritative move: ${JSON.stringify(first)}`);
  }

  await sleep(60);
  const secondFrame = gate.waitForMessage(MsgCode.G2C_EntityMove);
  await gate.send(buildMovePacket({ inputX: 1, inputY: 0, sequence: 2 }));
  const second = decodeEntityMoveFrame(await secondFrame).body;
  if (second.sequence !== 2 || second.x <= first.x || second.x - first.x > 20) {
    throw new Error(`unexpected second authoritative move: ${JSON.stringify(second)}`);
  }

  await gate.send(buildMovePacket({ inputX: 1, inputY: 0, sequence: 2 }));
  let duplicateArrived = false;
  try {
    await gate.waitForMessage(MsgCode.G2C_EntityMove, 150);
    duplicateArrived = true;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("timed out")) throw error;
  }
  if (duplicateArrived) {
    throw new Error("duplicate movement sequence produced a client broadcast");
  }
  console.log("Authoritative movement:", { first, second });
}

async function verifySharedMapBroadcast(
  ip: string,
  port: number,
  moverRequest: { account: string; token: string; mapId: number },
  observerRequest: { account: string; token: string; mapId: number },
): Promise<void> {
  const mover = await openGateAndEnterMap(ip, port, moverRequest);
  const enterFrame = mover.gate.waitForMessage(MsgCode.G2C_EntityEnter);
  const observer = await openGateAndEnterMap(ip, port, observerRequest);
  let observerClosed = false;
  try {
    const entered = decodeEntityEnterFrame(await enterFrame).body.entity;
    const snapshotIds = observer.enterMap.entities
      .map((entity) => entity.unitId)
      .sort((left, right) => left - right);
    const expectedIds = [mover.enterMap.unitId, observer.enterMap.unitId].sort(
      (left, right) => left - right,
    );
    if (
      entered.unitId !== observer.enterMap.unitId ||
      entered.account !== observerRequest.account ||
      snapshotIds.length !== expectedIds.length ||
      snapshotIds.some((unitId, index) => unitId !== expectedIds[index])
    ) {
      throw new Error(
        `entity enter/snapshot mismatch: ${JSON.stringify({ entered, snapshotIds, expectedIds })}`,
      );
    }

    const moverFrame = mover.gate.waitForMessage(MsgCode.G2C_EntityMove);
    const observerFrame = observer.gate.waitForMessage(MsgCode.G2C_EntityMove);
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputY: 1, sequence: 1 }),
    );
    const [moverPush, observerPush] = await Promise.all([
      moverFrame.then(decodeEntityMoveFrame),
      observerFrame.then(decodeEntityMoveFrame),
    ]);
    if (
      moverPush.body.unitId !== mover.enterMap.unitId ||
      observerPush.body.unitId !== mover.enterMap.unitId ||
      moverPush.body.x !== observerPush.body.x ||
      moverPush.body.y !== observerPush.body.y
    ) {
      throw new Error(
        `shared map broadcast mismatch: ${JSON.stringify({ moverPush, observerPush })}`,
      );
    }
    console.log("Shared map movement broadcast:", {
      moverUnitId: mover.enterMap.unitId,
      observerUnitId: observer.enterMap.unitId,
      position: { x: observerPush.body.x, y: observerPush.body.y },
    });

    const leaveFrame = mover.gate.waitForMessage(MsgCode.G2C_EntityLeave);
    await observer.gate.close();
    observerClosed = true;
    const left = decodeEntityLeaveFrame(await leaveFrame).body;
    if (left.unitId !== observer.enterMap.unitId) {
      throw new Error(`entity leave mismatch: ${JSON.stringify(left)}`);
    }
    console.log("Shared map entity lifecycle:", {
      snapshotIds,
      enteredUnitId: entered.unitId,
      leftUnitId: left.unitId,
    });
  } finally {
    await Promise.all([
      mover.gate.close(),
      observerClosed ? Promise.resolve() : observer.gate.close(),
    ]);
  }
}

async function openGateAndEnterMap(
  ip: string,
  port: number,
  request: { account: string; token: string; mapId: number },
): Promise<{ gate: TcpRpcConnection; enterMap: ReturnType<typeof decodeEnterMapFrame>["body"] }> {
  const gate = new TcpRpcConnection(ip, port);
  try {
    const loginGateRpcId = nextRpcId++;
    const loginGateFrame = await gate.request(
      buildLoginGatePacket(loginGateRpcId, {
        account: request.account,
        token: request.token,
      }),
    );
    const loginGate = decodeLoginGateFrame(loginGateFrame);
    if (loginGate.rpcId !== loginGateRpcId || loginGate.body.error) {
      throw new Error(`LoginGate failed: ${JSON.stringify(loginGate.body)}`);
    }

    const enterMapRpcId = nextRpcId++;
    const [enterMapFrame, mapReadyFrame] = await Promise.all([
      gate.request(buildEnterMapPacket(enterMapRpcId, { mapId: request.mapId })),
      gate.waitForMessage(MsgCode.G2C_MapReady),
    ]);
    const enterMap = decodeEnterMapFrame(enterMapFrame);
    const mapReady = decodeMapReadyFrame(mapReadyFrame);
    if (enterMap.rpcId !== enterMapRpcId || enterMap.body.error) {
      throw new Error(`EnterMap failed: ${JSON.stringify(enterMap.body)}`);
    }
    if (
      enterMap.body.unitId === 0 ||
      enterMap.body.mapId !== request.mapId ||
      mapReady.rpcId !== undefined ||
      mapReady.body.unitId !== enterMap.body.unitId
      || !enterMap.body.entities.some(
        (entity) => entity.unitId === enterMap.body.unitId,
      )
    ) {
      throw new Error(`unexpected enter map result: ${JSON.stringify(enterMap.body)}`);
    }
    return { gate, enterMap: enterMap.body };
  } catch (error) {
    await gate.close();
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOne(ip: string, port: number, packet: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    const decoder = new LengthPrefixedFrameDecoder();

    socket.on("connect", () => {
      socket.write(Buffer.from(packet));
    });

    socket.on("data", (chunk: Buffer) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) {
          socket.end();
          resolve(frames[0]);
        }
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });

    socket.on("error", reject);
  });
}

class TcpRpcConnection {
  private readonly socket: net.Socket;
  private readonly decoder = new LengthPrefixedFrameDecoder();
  private readonly connected: Promise<void>;
  private readonly closed: Promise<void>;
  private readonly pending: Array<{
    resolve: (frame: Uint8Array) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly messageWaiters = new Map<
    number,
    Array<{
      resolve: (frame: Uint8Array) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();
  private readonly bufferedMessages = new Map<number, Uint8Array[]>();

  constructor(ip: string, port: number) {
    this.socket = net.createConnection({ host: ip, port });
    this.connected = new Promise((resolve, reject) => {
      this.socket.on("connect", resolve);
      this.socket.on("error", reject);
    });
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));

    this.socket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          if (extractRpcId(frame) !== undefined) {
            this.pending.shift()?.resolve(frame);
            continue;
          }
          this.dispatchMessage(readU16BE(frame), frame);
        }
      } catch (error) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      }
    });

    this.socket.on("close", () => {
      this.rejectAll(new Error("gate connection closed"));
    });
  }

  async request(packet: Uint8Array): Promise<Uint8Array> {
    await this.connected;
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(Buffer.from(packet));
    });
  }

  async send(packet: Uint8Array): Promise<void> {
    await this.connected;
    await new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.from(packet), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  waitForMessage(msgcode: number, timeoutMs = 5000): Promise<Uint8Array> {
    const buffered = this.bufferedMessages.get(msgcode);
    const frame = buffered?.shift();
    if (frame) return Promise.resolve(frame);

    return new Promise((resolve, reject) => {
      const waiters = this.messageWaiters.get(msgcode) ?? [];
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.messageWaiters.get(msgcode);
          const index = current?.indexOf(waiter) ?? -1;
          if (index >= 0) current!.splice(index, 1);
          if (current?.length === 0) this.messageWaiters.delete(msgcode);
          reject(new Error(`message ${msgcode} timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      waiters.push(waiter);
      this.messageWaiters.set(msgcode, waiters);
    });
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    this.socket.end();
    await this.closed;
  }

  private rejectAll(error: Error): void {
    while (this.pending.length > 0) {
      this.pending.shift()!.reject(error);
    }
    for (const waiters of this.messageWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.messageWaiters.clear();
  }

  private dispatchMessage(msgcode: number, frame: Uint8Array): void {
    const waiters = this.messageWaiters.get(msgcode);
    const waiter = waiters?.shift();
    if (waiter) {
      if (waiters!.length === 0) this.messageWaiters.delete(msgcode);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    const buffered = this.bufferedMessages.get(msgcode) ?? [];
    buffered.push(frame);
    this.bufferedMessages.set(msgcode, buffered);
  }
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
