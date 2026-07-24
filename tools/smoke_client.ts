import net from "node:net";
import {
  buildEnterMapPacket,
  buildGetLoginServiceAddrPacket,
  buildLoginGatePacket,
  buildLoginPacket,
  buildMovePacket,
  buildUseItemPacket,
  decodeEntityMoveFrame,
  decodeEntityEnterFrame,
  decodeEntityLeaveFrame,
  decodeEnterMapFrame,
  decodeEntityNumericFrame,
  decodeEntityStateFrame,
  decodeItemChangedFrame,
  decodeUseItemFrame,
  decodeGetLoginServiceAddrFrame,
  decodeLoginGateFrame,
  decodeLoginFrame,
  decodeMapReadyFrame,
} from "../app/demo/client/LoginClientProtocol";
import { BinaryReader, readU16BE } from "../app/core/protocol/binary";
import { LengthPrefixedFrameDecoder } from "../app/core/protocol/frame";
import { MsgCode } from "../app/generated/model/client/demo/protocol/msgcodes";
import type { CellMovementState } from "../app/generated/model/client/demo/protocol/messages";

type TimedMovementState = CellMovementState & { serverTick: number };

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

  const afterDisconnect = await openGateAndEnterMap(ip, port, request, true);
  try {
    if (afterDisconnect.enterMap.unitId <= first.enterMap.unitId) {
      throw new Error("valid Gate disconnect did not remove the map unit");
    }
    console.log("GateSession lifecycle:", {
      reboundUnitId: first.enterMap.unitId,
      recreatedUnitId: afterDisconnect.enterMap.unitId,
    });
    await verifyNumericTimer(
      afterDisconnect.gate,
      afterDisconnect.enterMap.unitId,
      afterDisconnect.initialNumericFrame,
    );
    await verifyItemChange(afterDisconnect.gate, afterDisconnect.enterMap);
    await verifyAuthoritativeMovement(afterDisconnect.gate, afterDisconnect.enterMap);
    return afterDisconnect.enterMap;
  } finally {
    await afterDisconnect.gate.close();
  }
}

async function verifyItemChange(
  gate: TcpRpcConnection,
  enterMap: { items: readonly { itemId: number; count: number; version: number }[] },
): Promise<void> {
  const initial = enterMap.items.find((item) => item.itemId === 1);
  if (!initial || initial.count !== 3) {
    throw new Error("enter-map snapshot did not include the initial item state");
  }
  const pushed = gate.waitForMessage(MsgCode.G2C_ItemChanged);
  const statePushed = gate.waitForMessage(MsgCode.G2C_EntityState);
  const responseFrame = await gate.request(buildUseItemPacket(nextRpcId++, { itemId: 1 }));
  const response = decodeUseItemFrame(responseFrame).body.item;
  const event = decodeItemChangedFrame(await pushed).body.item;
  if (response.count !== 2 || event.count !== 2 || response.version !== event.version) {
    throw new Error("immediate item response and event are inconsistent");
  }
  const state = decodeEntityStateFrame(await statePushed).body.states[0];
  if (!state || (state.dirtyMaskLow & (1 << 3)) === 0 || state.speedCellsPerSecond !== 11) {
    throw new Error("speed potion did not produce the expected fixed-field delta");
  }
  console.log("Immediate item event:", {
    itemId: event.itemId,
    count: event.count,
    version: event.version,
    speedCellsPerSecond: state.speedCellsPerSecond,
  });
}

async function verifyNumericTimer(
  gate: TcpRpcConnection,
  unitId: number,
  initialFrame?: Uint8Array,
): Promise<void> {
  let previous: number | undefined;
  let maxHp: number | undefined;
  const frames: Uint8Array[] = initialFrame ? [initialFrame] : [];
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const frame = frames.shift() ?? await gate.waitForMessage(
        MsgCode.G2C_EntityNumeric,
        Math.max(1, deadline - Date.now()),
      );
    const body = decodeEntityNumericFrame(frame).body;
    for (const numeric of body.numerics.filter((candidate) => candidate.unitId === unitId)) {
      if (numeric.numericType === 1) {
        if (previous !== undefined && numeric.value > previous && maxHp === 1000) {
          console.log("Numeric timer broadcast:", {
            unitId,
            previousHp: previous,
            currentHp: numeric.value,
            serverTick: body.serverTick,
          });
          return;
        }
        previous = numeric.value;
      } else if (numeric.numericType === 2) {
        maxHp = numeric.value;
      }
    }
  }
  throw new Error(`timed out waiting for Numeric CurrentHp growth: unit ${unitId}`);
}

async function verifyAuthoritativeMovement(
  gate: TcpRpcConnection,
  player: { unitId: number; x: number; y: number },
): Promise<void> {
  await gate.send(buildMovePacket({ inputX: 1, inputY: 0, sequence: 1 }));
  const first = await waitForMovementSequence(gate, player.unitId, 1);
  if (
    first.unitId !== player.unitId ||
    first.acknowledgedSequence !== 1 ||
    !first.moving ||
    first.toCellX !== first.fromCellX + 1 ||
    first.toCellY !== first.fromCellY
  ) {
    throw new Error(`unexpected first authoritative move: ${JSON.stringify(first)}`);
  }

  await sleep(60);
  await gate.send(buildMovePacket({ inputX: 1, inputY: 0, sequence: 2 }));
  const second = await waitForMovementSequence(gate, player.unitId, 2);
  if (
    second.acknowledgedSequence !== 2 ||
    !second.moving ||
    second.toCellX !== second.fromCellX + 1 ||
    second.toCellY !== second.fromCellY ||
    second.fromCellX < first.fromCellX
  ) {
    throw new Error(`unexpected second authoritative move: ${JSON.stringify(second)}`);
  }

  await gate.send(buildMovePacket({ inputX: 0, inputY: 0, sequence: 3 }));
  const stopped = await waitForMovementSequence(gate, player.unitId, 3);
  if (
    stopped.acknowledgedSequence !== 3 ||
    (stopped.moving && stopped.toCellX !== stopped.fromCellX + 1)
  ) {
    throw new Error(`unexpected authoritative stop: ${JSON.stringify(stopped)}`);
  }

  // 重复序号不会改变输入；移动中的周期快照仍可能正常到达，不能用“无下行包”判断。
  await gate.send(buildMovePacket({ inputX: 0, inputY: 0, sequence: 3 }));
  console.log("Authoritative Cell movement:", { first, second, stopped });
}

async function waitForMovementSequence(
  gate: TcpRpcConnection,
  unitId: number,
  sequence: number,
): Promise<TimedMovementState> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const body = decodeEntityMoveFrame(
      await gate.waitForMessage(MsgCode.G2C_EntityMove, remaining),
    ).body;
    const movement = body.movements.find((candidate) => candidate.unitId === unitId);
    if (!movement) continue;
    // 移动中会夹杂周期权威快照，测试应等待目标输入被确认，而不是假定下一包必然对应它。
    if (movement.acknowledgedSequence === sequence) {
      return { ...movement, serverTick: body.serverTick };
    }
    if (movement.acknowledgedSequence > sequence) {
      throw new Error(
        `movement sequence skipped ${sequence}: ${JSON.stringify(movement)}`,
      );
    }
  }
  throw new Error(`timed out waiting for movement sequence ${sequence}`);
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
    const moverState = moverPush.body.movements.find(
      (movement) => movement.unitId === mover.enterMap.unitId,
    );
    const observerState = observerPush.body.movements.find(
      (movement) => movement.unitId === mover.enterMap.unitId,
    );
    if (
      !moverState ||
      !observerState ||
      JSON.stringify(moverState) !== JSON.stringify(observerState)
    ) {
      throw new Error(
        `shared map broadcast mismatch: ${JSON.stringify({ moverPush, observerPush })}`,
      );
    }
    console.log("Shared map movement broadcast:", {
      moverUnitId: mover.enterMap.unitId,
      observerUnitId: observer.enterMap.unitId,
      movement: observerState,
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
  captureInitialNumeric = false,
): Promise<{
  gate: TcpRpcConnection;
  enterMap: ReturnType<typeof decodeEnterMapFrame>["body"];
  initialNumericFrame?: Uint8Array;
}> {
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
    const initialNumeric = captureInitialNumeric
      ? gate.waitForMessage(MsgCode.G2C_EntityNumeric)
      : Promise.resolve(undefined);
    const [enterMapFrame, mapReadyFrame, initialNumericFrame] = await Promise.all([
      gate.request(buildEnterMapPacket(enterMapRpcId, { mapId: request.mapId })),
      gate.waitForMessage(MsgCode.G2C_MapReady),
      initialNumeric,
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
    return {
      gate,
      enterMap: enterMap.body,
      ...(initialNumericFrame ? { initialNumericFrame } : {}),
    };
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
