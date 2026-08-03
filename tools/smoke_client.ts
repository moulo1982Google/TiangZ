import net from "node:net";
import {
  buildEnterMapPacket,
  buildAttackMonsterPacket,
  buildFindPathPacket,
  buildNavigateToPacket,
  buildNavigateInputPacket,
  buildToggleDemoDoorPacket,
  buildGetLoginServiceAddrPacket,
  buildLoginGatePacket,
  buildLoginPacket,
  buildMapSnapshotReadyPacket,
  buildMovePacket,
  buildUseItemPacket,
  decodeAoiDeltaFrame,
  decodeAttackMonsterFrame,
  decodeEntityMoveFrame,
  decodeEntityNavigateFrame,
  decodeEnterMapFrame,
  decodeFindPathFrame,
  decodeNavigateToFrame,
  decodeNavigateInputFrame,
  decodeToggleDemoDoorFrame,
  decodeEntityNumericFrame,
  decodeItemChangedFrame,
  decodeUseItemFrame,
  decodeGetLoginServiceAddrFrame,
  decodeLoginGateFrame,
  decodeLoginFrame,
  decodeMapReadyFrame,
  decodeMapSnapshotReadyFrame,
  decodePingFrame,
  buildPingPacket,
} from "./support/DemoClientProtocol";
import { BinaryReader, readU16BE } from "../app/core/protocol/binary";
import { LengthPrefixedFrameDecoder } from "../app/core/protocol/frame";
import { MsgCode } from "../client_sdk/typescript/Generated/Model/demo/protocol/msgcodes";
import type { CellMovementState } from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import { GameConfigs, SpatialMode } from "../client_sdk/typescript/Generated/Config";
import { encodePacket } from "../app/core/public";
import {
  M2S_CreateDynamicMapCodec,
  M2S_DisposeDynamicMapCodec,
  S2M_CreateDynamicMapCodec,
  S2M_DisposeDynamicMapCodec,
  type MapInstanceSnapshot,
} from "../app/generated/model/server/demo/protocol/messages";
import { MsgCode as ServerMsgCode } from "../app/generated/model/server/demo/protocol/msgcodes";

type TimedMovementState = CellMovementState & { serverTick: number };

async function main() {
  const loginAddr = await requestLoginServiceAddr("127.0.0.1", 7000);
  console.log("LoginMgr selected:", loginAddr);
  // Process Ready不代表跨进程MapHost注册已经完成；等待一个5秒续租周期覆盖并发启动顺序。
  // Process Ready does not imply cross-process MapHost registration; wait one renewal cycle.
  await sleep(5_500);
  const dynamicMap = await verifyDynamicMapLifecycle();
  if (process.argv.includes("--gate-timeout-only")) {
    await verifyGateFinalTimeout(loginAddr.ip, loginAddr.port);
    return;
  }

  const [login1, login2] = await Promise.all([
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_user"),
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_user"),
  ]);
  const counts = [login1.loginCount, login2.loginCount].sort((a, b) => a - b);
  if (counts[0] !== 1 || counts[1] !== 2) {
    throw new Error(`expected actor login counts 1,2; got ${counts.join(",")}`);
  }
  console.log("Login responses:", login1, login2);

  const enterMap = await verifyGateSessionLifecycle(
    login1.gateIp,
    login1.gatePort,
    {
      account: login1.account,
      token: login1.token,
      mapId: 1,
    },
    dynamicMap,
  );
  console.log("EnterMap response:", enterMap);

  const [mover, peer] = await Promise.all([
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_mover"),
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_peer"),
  ]);
  await verifySharedMapBroadcast(
    mover.gateIp,
    mover.gatePort,
    { account: mover.account, token: mover.token, mapId: 1 },
    { account: peer.account, token: peer.token, mapId: 1 },
  );
}

/** 通过正式Inner握手验证动态副本创建和空地图销毁。 / Verifies dynamic-map creation and empty-map disposal through the real Inner handshake. */
async function verifyDynamicMapLifecycle(): Promise<MapInstanceSnapshot> {
  const requestId = `runtime-smoke:${Date.now()}`;
  const createRpcId = nextRpcId++;
  const createFrame = await requestOneInternal(
    "127.0.0.1",
    7100,
    encodePacket(
      ServerMsgCode.S2M_CreateDynamicMap,
      S2M_CreateDynamicMapCodec.encode({ rpcId: createRpcId, mapConfigId: 1, requestId }),
    ),
  );
  if (readU16BE(createFrame, 0) !== ServerMsgCode.M2S_CreateDynamicMap) {
    throw new Error("dynamic map create returned an unexpected msgcode");
  }
  const created = M2S_CreateDynamicMapCodec.decode(createFrame.subarray(2));
  if (created.error || created.instance.mapInstanceId === 1n) {
    throw new Error(`dynamic map create failed: ${created.error} ${created.message}`);
  }

  const retriedFrame = await requestOneInternal(
    "127.0.0.1",
    7100,
    encodePacket(
      ServerMsgCode.S2M_CreateDynamicMap,
      S2M_CreateDynamicMapCodec.encode({
        rpcId: nextRpcId++,
        mapConfigId: 1,
        requestId,
      }),
    ),
  );
  const retried = M2S_CreateDynamicMapCodec.decode(retriedFrame.subarray(2));
  if (retried.instance.mapInstanceId !== created.instance.mapInstanceId) {
    throw new Error("dynamic map idempotent retry returned another instance");
  }

  const secondFrame = await requestOneInternal(
    "127.0.0.1",
    7100,
    encodePacket(
      ServerMsgCode.S2M_CreateDynamicMap,
      S2M_CreateDynamicMapCodec.encode({
        rpcId: nextRpcId++,
        mapConfigId: 1,
        requestId: `${requestId}:second`,
      }),
    ),
  );
  const second = M2S_CreateDynamicMapCodec.decode(secondFrame.subarray(2));
  if (second.error || second.instance.mapHostName === created.instance.mapHostName) {
    throw new Error("dynamic map placement did not spread two instances across idle MapHosts");
  }

  const disposed = await disposeDynamicMap(second.instance.mapHost.port, second.instance.mapInstanceId);
  console.log("Dynamic map lifecycle:", {
    mapConfigId: created.instance.mapConfigId,
    mapInstanceId: created.instance.mapInstanceId,
    mapHostName: created.instance.mapHostName,
    secondDisposed: disposed.disposed,
  });
  return created.instance;
}

async function disposeDynamicMap(mapHostPort: number, mapInstanceId: bigint) {
  const frame = await requestOneInternal(
    "127.0.0.1",
    mapHostPort,
    encodePacket(
      ServerMsgCode.S2M_DisposeDynamicMap,
      S2M_DisposeDynamicMapCodec.encode({ rpcId: nextRpcId++, mapInstanceId }),
    ),
  );
  if (readU16BE(frame, 0) !== ServerMsgCode.M2S_DisposeDynamicMap) {
    throw new Error("dynamic map dispose returned an unexpected msgcode");
  }
  const disposed = M2S_DisposeDynamicMapCodec.decode(frame.subarray(2));
  if (disposed.error || !disposed.disposed) {
    throw new Error(`dynamic map dispose failed: ${disposed.error} ${disposed.message}`);
  }
  return disposed;
}

/** 等待真实30秒宽限结束，验证Gate驱动Map最终下线并让下次进入创建新Unit。 / Waits for the real grace deadline and verifies Gate-driven Map offline causes the next entry to create a new Unit. */
async function verifyGateFinalTimeout(loginIp: string, loginPort: number): Promise<void> {
  const account = `smoke_timeout_${Date.now()}`;
  const firstLogin = await requestLogin(loginIp, loginPort, account);
  const first = await openGateAndEnterMap(firstLogin.gateIp, firstLogin.gatePort, {
    account,
    token: firstLogin.token,
    mapId: 1,
  });
  const firstUnitId = first.enterMap.unitId;
  await first.gate.close();

  // 30秒宽限加两个1秒扫描周期，避免把调度边界误判为业务失败。
  await sleep(32_000);
  const secondLogin = await requestLogin(loginIp, loginPort, account);
  const second = await openGateAndEnterMap(secondLogin.gateIp, secondLogin.gatePort, {
    account,
    token: secondLogin.token,
    mapId: 1,
  });
  try {
    if (second.enterMap.unitId === firstUnitId) {
      throw new Error(`Gate timeout retained expired Unit ${firstUnitId}`);
    }
    console.log("Gate final timeout:", {
      account,
      removedUnitId: firstUnitId,
      recreatedUnitId: second.enterMap.unitId,
    });
  } finally {
    await second.gate.close();
  }
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
  dynamicMap: MapInstanceSnapshot,
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
    if (afterDisconnect.enterMap.unitId !== first.enterMap.unitId) {
      throw new Error("reconnect grace did not preserve the existing map unit");
    }
    console.log("GateSession lifecycle:", {
      reboundUnitId: first.enterMap.unitId,
      resumedUnitId: afterDisconnect.enterMap.unitId,
    });
    const currentHp = await verifyNumericTimer(
      afterDisconnect.gate,
      afterDisconnect.enterMap.unitId,
      afterDisconnect.enterMap.entities.find(
        (entity) => entity.unitId === afterDisconnect.enterMap.unitId,
      )?.numerics ?? [],
      afterDisconnect.initialNumericFrame,
    );
    const currentState = await verifyItemChange(
      afterDisconnect.gate,
      afterDisconnect.enterMap,
      currentHp,
    );
    await verifyAuthoritativeMovement(afterDisconnect.gate, afterDisconnect.enterMap);
    return await verifyMapTransfer(
      afterDisconnect.gate,
      afterDisconnect.enterMap,
      currentState.item,
      currentState.currentHp,
      dynamicMap,
    );
  } finally {
    await afterDisconnect.gate.close();
  }
}

/** 验证同一 Gate Session 跨图后保持 UnitId 与业务状态，并使用目标地图出生点。 / Verifies that a map transfer preserves UnitId and gameplay state while applying the target-map spawn. */
async function verifyMapTransfer(
  gate: TcpRpcConnection,
  previous: ReturnType<typeof decodeEnterMapFrame>["body"],
  expectedItem: { itemId: bigint; count: number; version: number },
  expectedMinimumHp: bigint,
  dynamicMap: MapInstanceSnapshot,
): Promise<ReturnType<typeof decodeEnterMapFrame>["body"]> {
  const rpcId = nextRpcId++;
  const readyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
  const responsePromise = gate.request(buildEnterMapPacket(rpcId, { mapId: 2, mapInstanceId: 0n }));
  const queuedItemRpcId = nextRpcId++;
  const queuedItemEvent = gate.waitForMessage(MsgCode.G2C_ItemChanged);
  const queuedItemResponse = gate.request(
    buildUseItemPacket(queuedItemRpcId, { itemId: expectedItem.itemId }),
  );
  const responseFrame = await responsePromise;
  const response = decodeEnterMapFrame(responseFrame);
  const ready = decodeMapReadyFrame(await readyFrame);
  if (response.rpcId !== rpcId || response.body.error) {
    throw new Error(`Map transfer failed: ${stringifyForError(response.body)}`);
  }
  const transferred = response.body;
  const mapConfig = GameConfigs.MapConfig.Get(2);
  const itemAfter = transferred.items.find((item) => item.itemId === expectedItem.itemId);
  if (
    transferred.mapId !== 2 ||
    transferred.unitId !== previous.unitId ||
    ready.body.mapId !== 2 ||
    ready.body.unitId !== previous.unitId ||
    transferred.x !== mapConfig.spawnX ||
    transferred.y !== mapConfig.spawnY ||
    transferred.z !== mapConfig.spawnZ ||
    itemAfter?.count !== expectedItem.count ||
    itemAfter?.version !== expectedItem.version
  ) {
    throw new Error(`map transfer did not preserve player state: ${stringifyForError({ previous, transferred, ready: ready.body })}`);
  }

  const afterHp = transferred.entities
    .find((entity) => entity.unitId === transferred.unitId)
    ?.numerics.find((numeric) => numeric.numericType === 1)?.value;
  if (afterHp === undefined || afterHp < expectedMinimumHp) {
    throw new Error(
      `map transfer lost Numeric state: expected>=${expectedMinimumHp}, after=${afterHp}`,
    );
  }
  const itemResponse = decodeUseItemFrame(await queuedItemResponse);
  const itemEvent = decodeItemChangedFrame(await queuedItemEvent);
  if (
    itemResponse.rpcId !== queuedItemRpcId ||
    itemResponse.body.error ||
    itemResponse.body.item.count !== expectedItem.count - 1 ||
    itemEvent.body.item.version !== itemResponse.body.item.version
  ) {
    throw new Error("queued transfer-time UseItem was not executed exactly once on the target Unit");
  }
  console.log("Map transfer:", {
    unitId: transferred.unitId,
    fromMapId: previous.mapId,
    toMapId: transferred.mapId,
    x: transferred.x,
    y: transferred.y,
    z: transferred.z,
    itemCount: itemAfter?.count,
    queuedItemCount: itemResponse.body.item.count,
  });
  await verifyMonsterLifecycle(gate, transferred);
  const navigation = await verifyNavMeshTransfer(gate, transferred);
  return await verifyDynamicMapTransfer(gate, navigation, dynamicMap);
}

/** 验证固定刷点怪物的攻击、死亡、尸体移除和重生完整闭环。 / Verifies the full fixed-slot monster loop: attack, death, corpse removal, and respawn. */
async function verifyMonsterLifecycle(
  gate: TcpRpcConnection,
  enterMap: ReturnType<typeof decodeEnterMapFrame>["body"],
): Promise<void> {
  const monster = enterMap.entities.find(
    (entity) => entity.entityType === 2 && entity.configId === 1,
  );
  if (!monster) {
    throw new Error(`map2 snapshot did not include the training dummy: ${stringifyForError(enterMap.entities)}`);
  }
  const initialHp = monster.numerics.find((numeric) => numeric.numericType === 1)?.value;
  if (initialHp !== 300n) {
    throw new Error(`training dummy has unexpected initial HP: ${initialHp}`);
  }

  const expectedHits = 12;
  let last: ReturnType<typeof decodeAttackMonsterFrame>["body"] | undefined;
  for (let hit = 1; hit <= expectedHits; hit += 1) {
    const response = decodeAttackMonsterFrame(await gate.request(
      buildAttackMonsterPacket(nextRpcId++, { monsterId: monster.unitId }),
    ));
    if (
      response.body.error ||
      response.body.monsterId !== monster.unitId ||
      response.body.damage !== 25 ||
      response.body.remainingHp !== BigInt((expectedHits - hit) * 25) ||
      response.body.killed !== (hit === expectedHits)
    ) {
      throw new Error(`monster attack result mismatch: ${stringifyForError(response.body)}`);
    }
    last = response.body;
  }

  let observedLeave = false;
  let respawned: typeof monster | undefined;
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline && !respawned) {
    const delta = decodeAoiDeltaFrame(await gate.waitForMessage(
      MsgCode.G2C_AoiDelta,
      Math.max(1, deadline - Date.now()),
    )).body;
    observedLeave ||= delta.leaves.includes(monster.unitId);
    respawned = delta.enters.find(
      (entity) => entity.entityType === 2 && entity.configId === 1,
    );
  }
  const respawnHp = respawned?.numerics.find((numeric) => numeric.numericType === 1)?.value;
  if (!observedLeave || !respawned || respawnHp !== 300n) {
    throw new Error(`monster corpse/respawn lifecycle failed: ${stringifyForError({ observedLeave, respawned, respawnHp })}`);
  }
  console.log("Monster lifecycle:", {
    initialMonsterId: monster.unitId,
    killedMonsterId: last?.monsterId,
    respawnedMonsterId: respawned.unitId,
    respawnHp,
  });
}

/** 验证真实玩家可进入NavMesh3D地图，并收到与冷配置一致的空间资源契约。 / Verifies that a real player can enter a NavMesh3D map with the cold-configured spatial asset contract. */
async function verifyNavMeshTransfer(
  gate: TcpRpcConnection,
  previous: ReturnType<typeof decodeEnterMapFrame>["body"],
): Promise<ReturnType<typeof decodeEnterMapFrame>["body"]> {
  const mapConfig = GameConfigs.MapConfig.Get(100);
  const rpcId = nextRpcId++;
  const readyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
  const responseFrame = await gate.request(
    buildEnterMapPacket(rpcId, { mapId: mapConfig.id, mapInstanceId: 0n }),
  );
  const response = decodeEnterMapFrame(responseFrame);
  const ready = decodeMapReadyFrame(await readyFrame);
  const transferred = response.body;
  const finitePosition = [transferred.x, transferred.y, transferred.z].every(Number.isFinite);
  const nearConfiguredSpawn =
    Math.abs(transferred.x - mapConfig.spawnX) <= 0.5 &&
    Math.abs(transferred.z - mapConfig.spawnZ) <= 0.5;
  const insideGrayboxObstacle =
    Math.abs(transferred.x) <= 3 &&
    Math.abs(transferred.z) <= 5 &&
    transferred.y < 3;
  if (
    response.rpcId !== rpcId ||
    transferred.error ||
    transferred.mapId !== mapConfig.id ||
    transferred.unitId !== previous.unitId ||
    transferred.spatialMode !== SpatialMode.NavMesh3D ||
    transferred.navigationVersion !== mapConfig.navigationVersion ||
    transferred.navigationHash !== mapConfig.navigationHash ||
    ready.body.mapId !== mapConfig.id ||
    ready.body.unitId !== previous.unitId ||
    !finitePosition ||
    !nearConfiguredSpawn ||
    insideGrayboxObstacle
  ) {
    throw new Error(
      `NavMesh3D transfer contract mismatch: ${stringifyForError({ transferred, ready: ready.body, mapConfig })}`,
    );
  }
  const pathRpcId = nextRpcId++;
  const pathResponse = decodeFindPathFrame(await gate.request(buildFindPathPacket(pathRpcId, {
    startX: transferred.x,
    startY: transferred.y,
    startZ: transferred.z,
    targetX: 10,
    targetY: 0,
    targetZ: 10,
  })));
  if (
    pathResponse.rpcId !== pathRpcId ||
    pathResponse.body.error ||
    pathResponse.body.points.length < 2 ||
    pathResponse.body.points.some((point) => ![point.x, point.y, point.z].every(Number.isFinite))
  ) {
    throw new Error(`NavMesh3D path query failed: ${stringifyForError(pathResponse.body)}`);
  }
  await verifyDynamicNavigationDoor(gate);
  const navigationPush = waitForNavigationProgress(
    gate,
    transferred.unitId,
    1,
    transferred.x,
    transferred.z,
  );
  const navigateRpcId = nextRpcId++;
  const navigateResponse = decodeNavigateToFrame(await gate.request(buildNavigateToPacket(
    navigateRpcId,
    { targetX: 10, targetY: 0, targetZ: 10, sequence: 1 },
  )));
  const movement = await navigationPush;
  if (
    navigateResponse.rpcId !== navigateRpcId ||
    navigateResponse.body.error ||
    navigateResponse.body.acknowledgedSequence !== 1 ||
    navigateResponse.body.points.length < 2 ||
    movement.acknowledgedSequence !== 1 ||
    !movement.moving ||
    (movement.x === transferred.x && movement.z === transferred.z)
  ) {
    throw new Error(`NavMesh3D authoritative movement failed: ${stringifyForError({
      navigate: navigateResponse.body,
      movement,
    })}`);
  }
  const directionRpcId = nextRpcId++;
  const directionPush = waitForNavigationState(gate, transferred.unitId, 2, true);
  const direction = decodeNavigateInputFrame(await gate.request(buildNavigateInputPacket(
    directionRpcId,
    { forward: 1, strafe: 0, yaw: Math.PI / 2, sequence: 2 },
  )));
  const directionMovement = await directionPush;
  const stopRpcId = nextRpcId++;
  const stopPush = waitForNavigationState(gate, transferred.unitId, 3, false);
  const stop = decodeNavigateInputFrame(await gate.request(buildNavigateInputPacket(
    stopRpcId,
    { forward: 0, strafe: 0, yaw: Math.PI / 2, sequence: 3 },
  )));
  const stoppedMovement = await stopPush;
  if (
    direction.rpcId !== directionRpcId ||
    direction.body.error ||
    direction.body.acknowledgedSequence !== 2 ||
    direction.body.points.length !== 0 ||
    directionMovement.x <= movement.x ||
    Math.abs(directionMovement.yaw - Math.PI / 2) > 0.001 ||
    stop.rpcId !== stopRpcId ||
    stop.body.error ||
    stop.body.acknowledgedSequence !== 3 ||
    stoppedMovement.x < directionMovement.x
  ) {
    throw new Error(`NavMesh3D direction input failed: ${stringifyForError({
      direction: direction.body,
      directionMovement,
      stop: stop.body,
      stoppedMovement,
    })}`);
  }
  console.log("NavMesh3D transfer:", {
    unitId: transferred.unitId,
    mapId: transferred.mapId,
    position: [transferred.x, transferred.y, transferred.z],
    navigationVersion: transferred.navigationVersion,
    navigationHash: transferred.navigationHash,
    pathPoints: pathResponse.body.points.length,
    authoritativePosition: [movement.x, movement.y, movement.z],
  });
  return transferred;
}

/** 通过正式Map Actor RPC验证开关门会改变Rust TileCache路径，并在开门后恢复。 / Verifies through the real Map Actor RPC that a door changes and then restores the Rust TileCache path. */
async function verifyDynamicNavigationDoor(gate: TcpRpcConnection): Promise<void> {
  const queryDoorPath = async () => {
    const rpcId = nextRpcId++;
    return decodeFindPathFrame(await gate.request(buildFindPathPacket(rpcId, {
      startX: -12,
      startY: 0,
      startZ: -12,
      targetX: -12,
      targetY: 0,
      targetZ: 12,
    }))).body.points;
  };
  const openPath = await queryDoorPath();
  const closeRpcId = nextRpcId++;
  const closed = decodeToggleDemoDoorFrame(await gate.request(
    buildToggleDemoDoorPacket(closeRpcId, { closed: true }),
  ));
  if (closed.body.error || !closed.body.closed) {
    throw new Error(`dynamic door close failed: ${stringifyForError(closed.body)}`);
  }
  let closedPath = openPath;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(50);
    closedPath = await queryDoorPath();
    if (closedPath.some((point) => Math.abs(point.x + 12) > 4)) break;
  }
  if (!closedPath.some((point) => Math.abs(point.x + 12) > 4)) {
    throw new Error(`dynamic door did not force a detour: ${stringifyForError(closedPath)}`);
  }

  const openRpcId = nextRpcId++;
  const opened = decodeToggleDemoDoorFrame(await gate.request(
    buildToggleDemoDoorPacket(openRpcId, { closed: false }),
  ));
  if (opened.body.error || opened.body.closed) {
    throw new Error(`dynamic door open failed: ${stringifyForError(opened.body)}`);
  }
  let restoredPath = closedPath;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(50);
    restoredPath = await queryDoorPath();
    if (!restoredPath.some((point) => Math.abs(point.x + 12) > 4)) break;
  }
  if (restoredPath.some((point) => Math.abs(point.x + 12) > 4)) {
    throw new Error(`dynamic door did not restore the open path: ${stringifyForError(restoredPath)}`);
  }
  console.log("NavMesh3D dynamic door:", {
    openPoints: openPath.length,
    closedPoints: closedPath.length,
    restoredPoints: restoredPath.length,
  });
}

/** 跳过刚接受路径时仍位于起点的合法Push，等待权威位置真正沿路径推进。 / Skips the valid path-start push and waits for authoritative position progress. */
async function waitForNavigationProgress(
  gate: TcpRpcConnection,
  unitId: number,
  sequence: number,
  startX: number,
  startZ: number,
): Promise<ReturnType<typeof decodeEntityNavigateFrame>["body"]["movements"][number]> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const message = decodeEntityNavigateFrame(await gate.waitForMessage(MsgCode.G2C_EntityNavigate));
    const movement = message.body.movements.find((candidate) =>
      candidate.unitId === unitId &&
      candidate.acknowledgedSequence >= sequence &&
      candidate.moving &&
      (Math.abs(candidate.x - startX) > 0.001 || Math.abs(candidate.z - startZ) > 0.001)
    );
    if (movement) return movement;
  }
  throw new Error(`navigation progress not observed: unit=${unitId} sequence=${sequence}`);
}

async function waitForNavigationState(
  gate: TcpRpcConnection,
  unitId: number,
  sequence: number,
  moving: boolean,
): Promise<ReturnType<typeof decodeEntityNavigateFrame>["body"]["movements"][number]> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const message = decodeEntityNavigateFrame(await gate.waitForMessage(MsgCode.G2C_EntityNavigate));
    const movement = message.body.movements.find((candidate) =>
      candidate.unitId === unitId &&
      candidate.acknowledgedSequence >= sequence &&
      candidate.moving === moving
    );
    if (movement) return movement;
  }
  throw new Error(`navigation state not observed: unit=${unitId} sequence=${sequence} moving=${moving}`);
}

/** 仅供测试错误输出安全显示bigint协议字段。 / Safely renders bigint protocol fields for test failures only. */
function stringifyForError(value: unknown): string {
  return JSON.stringify(value, (_key, field) =>
    typeof field === "bigint" ? field.toString() : field
  );
}

/** 验证目标MapHost完全不在Gate静态目录时，仍可通过Location携带的Endpoint完成传送。 / Verifies transfer through a Location endpoint when the target MapHost is absent from Gate's static directory. */
async function verifyDynamicMapTransfer(
  gate: TcpRpcConnection,
  previous: ReturnType<typeof decodeEnterMapFrame>["body"],
  dynamicMap: MapInstanceSnapshot,
): Promise<ReturnType<typeof decodeEnterMapFrame>["body"]> {
  const rpcId = nextRpcId++;
  const readyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
  const responseFrame = await gate.request(buildEnterMapPacket(rpcId, {
    mapId: 0,
    mapInstanceId: dynamicMap.mapInstanceId,
  }));
  const response = decodeEnterMapFrame(responseFrame);
  const ready = decodeMapReadyFrame(await readyFrame);
  if (
    response.rpcId !== rpcId ||
    response.body.error ||
    response.body.mapInstanceId !== dynamicMap.mapInstanceId ||
    response.body.mapId !== dynamicMap.mapConfigId ||
    response.body.unitId !== previous.unitId ||
    ready.body.unitId !== previous.unitId
  ) {
    throw new Error(`dynamic MapHost transfer failed: ${JSON.stringify(response.body)}`);
  }
  console.log("Dynamic MapHost transfer:", {
    unitId: response.body.unitId,
    mapInstanceId: response.body.mapInstanceId,
    mapHostName: dynamicMap.mapHostName,
    mapHostPort: dynamicMap.mapHost.port,
  });
  return response.body;
}

async function verifyItemChange(
  gate: TcpRpcConnection,
  enterMap: {
    unitId: number;
    items: readonly { itemId: bigint; configId: number; count: number; version: number }[];
  },
  previousHp: bigint,
) {
  const initial = enterMap.items[0];
  if (!initial || initial.count !== 3) {
    throw new Error("enter-map snapshot did not include the initial item state");
  }
  const itemConfig = GameConfigs.ItemConfig.Get(initial.configId);
  const maxHp = BigInt(GameConfigs.PlayerConfig.Get(1).maxHp);
  const restoredHp = previousHp + BigInt(itemConfig.restoreHp);
  const expectedHp = restoredHp < maxHp ? restoredHp : maxHp;
  const pushed = gate.waitForMessage(MsgCode.G2C_ItemChanged);
  let numericPushed = gate.waitForMessage(MsgCode.G2C_EntityNumeric);
  const responseFrame = await gate.request(
    buildUseItemPacket(nextRpcId++, { itemId: initial.itemId }),
  );
  const response = decodeUseItemFrame(responseFrame).body.item;
  const event = decodeItemChangedFrame(await pushed).body.item;
  if (response.count !== 2 || event.count !== 2 || response.version !== event.version) {
    throw new Error("immediate item response and event are inconsistent");
  }

  const deadline = Date.now() + 2_000;
  let currentHp: bigint | undefined;
  while (Date.now() < deadline) {
    const frame = await numericPushed;
    currentHp = decodeEntityNumericFrame(frame).body.numerics.find(
      (numeric) => numeric.unitId === enterMap.unitId && numeric.numericType === 1,
    )?.value;
    if (currentHp !== undefined && currentHp >= expectedHp) break;
    numericPushed = gate.waitForMessage(
      MsgCode.G2C_EntityNumeric,
      Math.max(1, deadline - Date.now()),
    );
  }
  if (currentHp === undefined || currentHp < expectedHp || currentHp > maxHp) {
    throw new Error(
      `health potion did not produce the expected Numeric delta: expected>=${expectedHp}, actual=${currentHp}`,
    );
  }
  console.log("Immediate item event:", {
    itemId: event.itemId,
    count: event.count,
    version: event.version,
    currentHp,
  });
  return { item: response, currentHp };
}

async function verifyNumericTimer(
  gate: TcpRpcConnection,
  unitId: number,
  initialNumerics: readonly { numericType: number; value: bigint }[],
  initialFrame?: Uint8Array,
): Promise<bigint> {
  let previous = initialNumerics.find((numeric) => numeric.numericType === 1)?.value;
  const maxHp = initialNumerics.find((numeric) => numeric.numericType === 1_000)?.value;
  if (previous === undefined || maxHp !== 1000n) {
    throw new Error(
      `enter-map snapshot is missing Numeric defaults: unit ${unitId}, numerics=${initialNumerics.map((numeric) => `${numeric.numericType}=${numeric.value}`).join(",")}`,
    );
  }
  let frameCount = 0;
  const observed = new Map<number, Map<number, bigint>>();
  const frames: Uint8Array[] = initialFrame ? [initialFrame] : [];
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    let frame: Uint8Array;
    try {
      frame = frames.shift() ?? await gate.waitForMessage(
          MsgCode.G2C_EntityNumeric,
          Math.max(1, deadline - Date.now()),
        );
    } catch (error) {
      if (Date.now() >= deadline) break;
      throw error;
    }
    frameCount += 1;
    const body = decodeEntityNumericFrame(frame).body;
    for (const numeric of body.numerics) {
      const values = observed.get(numeric.unitId) ?? new Map<number, bigint>();
      values.set(numeric.numericType, numeric.value);
      observed.set(numeric.unitId, values);
      if (numeric.unitId !== unitId) continue;
      if (numeric.numericType === 1) {
        if (previous !== undefined && numeric.value > previous && maxHp === 1000n) {
          console.log("Numeric timer broadcast:", {
            unitId,
            previousHp: previous,
            currentHp: numeric.value,
            serverTick: body.serverTick,
          });
          return numeric.value;
        }
        previous = numeric.value;
      }
    }
  }
  throw new Error(
    `timed out waiting for Numeric CurrentHp growth: unit ${unitId}, frames=${frameCount}, observed=${JSON.stringify(
      [...observed].map(([observedUnitId, values]) => ({
        unitId: observedUnitId,
        values: Object.fromEntries([...values].map(([type, value]) => [type, value.toString()])),
      })),
    )}`,
  );
}

async function verifyAuthoritativeMovement(
  gate: TcpRpcConnection,
  player: { unitId: number; x: number; y: number; z: number },
): Promise<void> {
  await gate.send(buildMovePacket({ inputX: 1, inputZ: 0, sequence: 1 }));
  const first = await waitForMovementSequence(gate, player.unitId, 1);
  if (
    first.unitId !== player.unitId ||
    first.acknowledgedSequence !== 1 ||
    !first.moving ||
    first.toCellX !== first.fromCellX + 1 ||
    first.toCellZ !== first.fromCellZ
  ) {
    throw new Error(`unexpected first authoritative move: ${JSON.stringify(first)}`);
  }

  await sleep(60);
  await gate.send(buildMovePacket({ inputX: 1, inputZ: 0, sequence: 2 }));
  const second = await waitForMovementSequence(gate, player.unitId, 2);
  if (
    second.acknowledgedSequence !== 2 ||
    !second.moving ||
    second.toCellX !== second.fromCellX + 1 ||
    second.toCellZ !== second.fromCellZ ||
    second.fromCellX < first.fromCellX
  ) {
    throw new Error(`unexpected second authoritative move: ${JSON.stringify(second)}`);
  }

  await gate.send(buildMovePacket({ inputX: 0, inputZ: 0, sequence: 3 }));
  const stopped = await waitForMovementSequence(gate, player.unitId, 3);
  if (
    stopped.acknowledgedSequence !== 3 ||
    (stopped.moving && stopped.toCellX !== stopped.fromCellX + 1)
  ) {
    throw new Error(`unexpected authoritative stop: ${JSON.stringify(stopped)}`);
  }

  // 重复序号不会改变输入；移动中的周期快照仍可能正常到达，不能用“无下行包”判断。
  await gate.send(buildMovePacket({ inputX: 0, inputZ: 0, sequence: 3 }));
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
  const enterFrame = mover.gate.waitForMessage(MsgCode.G2C_AoiDelta);
  const observer = await openGateAndEnterMap(ip, port, observerRequest);
  let observerClosed = false;
  try {
    const entered = decodeAoiDeltaFrame(await enterFrame).body.enters.find(
      (entity) => entity.unitId === observer.enterMap.unitId,
    );
    const snapshotIds = observer.enterMap.entities
      .map((entity) => entity.unitId)
      .sort((left, right) => left - right);
    const monsterIds = mover.enterMap.entities
      .filter((entity) => entity.entityType === 2)
      .map((entity) => entity.unitId);
    const expectedIds = [mover.enterMap.unitId, observer.enterMap.unitId, ...monsterIds].sort(
      (left, right) => left - right,
    );
    if (
      !entered ||
      entered.account !== observerRequest.account ||
      snapshotIds.length !== expectedIds.length ||
      snapshotIds.some((unitId, index) => unitId !== expectedIds[index])
    ) {
      throw new Error(
        `entity enter/snapshot mismatch: ${stringifyForError({ entered, snapshotIds, expectedIds })}`,
      );
    }

    const moverFrame = mover.gate.waitForMessage(MsgCode.G2C_EntityMove);
    const observerFrame = observer.gate.waitForMessage(MsgCode.G2C_EntityMove);
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: 1, sequence: 1 }),
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

    // Demo使用15米AOI Grid和5x5 Detach；持续移动直到真正越过迟滞外圈。
    const leaveFrame = observer.gate.waitForMessage(MsgCode.G2C_AoiDelta, 8000);
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: 1, sequence: 2 }),
    );
    const left = decodeAoiDeltaFrame(await leaveFrame).body;
    if (!left.leaves.includes(mover.enterMap.unitId)) {
      throw new Error(`AOI leave contains the wrong Unit: ${JSON.stringify(left)}`);
    }
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: 0, sequence: 3 }),
    );
    await waitForMovementSequence(mover.gate, mover.enterMap.unitId, 3);
    await assertNoMovementSequenceAtLeast(
      observer.gate,
      mover.enterMap.unitId,
      3,
      500,
    );

    // 返回时只有进入3x3 Enter范围才重新建立关系，不能在Detach外圈提前Enter。
    const reenterFrame = observer.gate.waitForMessage(MsgCode.G2C_AoiDelta, 5000);
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: -1, sequence: 4 }),
    );
    const reentered = decodeAoiDeltaFrame(await reenterFrame).body.enters.find(
      (entity) => entity.unitId === mover.enterMap.unitId,
    );
    if (!reentered) {
      throw new Error(`AOI reenter contains the wrong Unit: ${JSON.stringify(reentered)}`);
    }
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: 0, sequence: 5 }),
    );
    console.log("Shared map AOI boundary:", {
      leftUnitId: mover.enterMap.unitId,
      reenteredUnitId: reentered.unitId,
    });

    const moverNav = await transferConnectedPlayer(mover.gate, 100);
    const observerNav = await transferConnectedPlayer(observer.gate, 100);
    const moverNavigationFrame = mover.gate.waitForMessage(MsgCode.G2C_EntityNavigate);
    const observerNavigationFrame = observer.gate.waitForMessage(MsgCode.G2C_EntityNavigate);
    const navigateRpcId = nextRpcId++;
    const navigate = decodeNavigateToFrame(await mover.gate.request(buildNavigateToPacket(
      navigateRpcId,
      { targetX: 10, targetY: 0, targetZ: 10, sequence: 1 },
    )));
    const [moverNavigation, observerNavigation] = await Promise.all([
      moverNavigationFrame.then(decodeEntityNavigateFrame),
      observerNavigationFrame.then(decodeEntityNavigateFrame),
    ]);
    const moverNavState = moverNavigation.body.movements.find(
      (movement) => movement.unitId === moverNav.unitId,
    );
    const observerNavState = observerNavigation.body.movements.find(
      (movement) => movement.unitId === moverNav.unitId,
    );
    if (
      navigate.body.error ||
      navigate.body.acknowledgedSequence !== 1 ||
      !moverNavState ||
      !observerNavState ||
      JSON.stringify(moverNavState) !== JSON.stringify(observerNavState)
    ) {
      throw new Error(`shared NavMesh movement mismatch: ${stringifyForError({
        navigate: navigate.body,
        moverNavState,
        observerNavState,
      })}`);
    }
    console.log("Shared NavMesh movement broadcast:", {
      moverUnitId: moverNav.unitId,
      observerUnitId: observerNav.unitId,
      movement: observerNavState,
    });

    await observer.gate.close();
    observerClosed = true;
    console.log("Shared map reconnect grace:", {
      snapshotIds,
      enteredUnitId: entered.unitId,
      retainedUnitId: observer.enterMap.unitId,
    });
  } finally {
    await Promise.all([
      mover.gate.close(),
      observerClosed ? Promise.resolve() : observer.gate.close(),
    ]);
  }
}

async function transferConnectedPlayer(
  gate: TcpRpcConnection,
  mapId: number,
): Promise<ReturnType<typeof decodeEnterMapFrame>["body"]> {
  const rpcId = nextRpcId++;
  const readyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
  const response = decodeEnterMapFrame(await gate.request(
    buildEnterMapPacket(rpcId, { mapId, mapInstanceId: 0n }),
  ));
  const ready = decodeMapReadyFrame(await readyFrame);
  if (
    response.body.error ||
    response.body.mapId !== mapId ||
    ready.body.mapId !== mapId ||
    ready.body.unitId !== response.body.unitId
  ) {
    throw new Error(`connected transfer failed: ${stringifyForError({ response, ready })}`);
  }
  const snapshotRpcId = nextRpcId++;
  const snapshot = decodeMapSnapshotReadyFrame(await gate.request(
    buildMapSnapshotReadyPacket(snapshotRpcId, { unitId: response.body.unitId }),
  ));
  if (snapshot.body.error) {
    throw new Error(`connected snapshot ready failed: ${stringifyForError(snapshot.body)}`);
  }
  return response.body;
}

async function assertNoMovementSequenceAtLeast(
  gate: TcpRpcConnection,
  unitId: number,
  minimumSequence: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const frame = await gate.waitForMessage(MsgCode.G2C_EntityMove, remaining);
      const movement = decodeEntityMoveFrame(frame).body.movements.find(
        (candidate) => candidate.unitId === unitId,
      );
      if (movement && movement.acknowledgedSequence >= minimumSequence) {
        throw new Error(
          `observer outside AOI received mover sequence ${movement.acknowledgedSequence}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && /timed out/i.test(error.message)) return;
      throw error;
    }
    if (Date.now() >= deadline) return;
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

    const pingRpcId = nextRpcId++;
    const pingStartedAt = Date.now();
    const ping = decodePingFrame(await gate.request(buildPingPacket(pingRpcId)));
    const pingFinishedAt = Date.now();
    const serverTime = Number(ping.body.serverTime);
    if (
      ping.rpcId !== pingRpcId ||
      ping.body.error ||
      serverTime < pingStartedAt - 1_000 ||
      serverTime > pingFinishedAt + 1_000
    ) {
      throw new Error(`Gate Ping returned an invalid server time: ${serverTime}`);
    }

    const enterMapRpcId = nextRpcId++;
    const initialNumeric = captureInitialNumeric
      ? gate.waitForMessage(MsgCode.G2C_EntityNumeric)
      : Promise.resolve(undefined);
    const [enterMapFrame, mapReadyFrame, initialNumericFrame] = await Promise.all([
      gate.request(buildEnterMapPacket(enterMapRpcId, { mapId: request.mapId, mapInstanceId: 0n })),
      gate.waitForMessage(MsgCode.G2C_MapReady),
      initialNumeric,
    ]);
    const enterMap = decodeEnterMapFrame(enterMapFrame);
    const mapReady = decodeMapReadyFrame(mapReadyFrame);
    if (enterMap.rpcId !== enterMapRpcId || enterMap.body.error) {
      throw new Error(`EnterMap failed: ${JSON.stringify(enterMap.body)}`);
    }
    if (enterMap.body.entities.length === 0) {
      const snapshotReadyRpcId = nextRpcId++;
      const snapshotFrame = gate.waitForMessage(MsgCode.G2C_AoiDelta);
      const snapshotReady = decodeMapSnapshotReadyFrame(
        await gate.request(buildMapSnapshotReadyPacket(snapshotReadyRpcId, {
          unitId: enterMap.body.unitId,
        })),
      );
      if (snapshotReady.rpcId !== snapshotReadyRpcId || snapshotReady.body.error) {
        throw new Error(`MapSnapshotReady failed: ${JSON.stringify(snapshotReady.body)}`);
      }
      const initialSnapshot = decodeAoiDeltaFrame(await snapshotFrame).body;
      enterMap.body = {
        ...enterMap.body,
        entities: initialSnapshot.enters,
      };
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
  return requestOneWithPreamble(ip, port, packet);
}

/** 发送Rust Inner Transport要求的ETSI+token握手，不把内部RPC伪装成外部客户端消息。 / Sends the ETSI plus token preamble required by Rust Inner Transport instead of disguising internal RPC as client traffic. */
function requestOneInternal(ip: string, port: number, packet: Uint8Array): Promise<Uint8Array> {
  const token = Buffer.from(process.env.ETS_INNER_TOKEN ?? "ets-local-inner-token", "utf8");
  const length = Buffer.allocUnsafe(2);
  length.writeUInt16BE(token.length);
  return requestOneWithPreamble(
    ip,
    port,
    packet,
    Buffer.concat([Buffer.from("ETSI", "ascii"), length, token]),
  );
}

function requestOneWithPreamble(
  ip: string,
  port: number,
  packet: Uint8Array,
  preamble?: Buffer,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    const decoder = new LengthPrefixedFrameDecoder();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`request ${ip}:${port} timed out`));
    }, 5_000);

    socket.on("connect", () => {
      if (preamble) socket.write(preamble);
      socket.write(Buffer.from(packet));
    });

    socket.on("data", (chunk: Buffer) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) {
          socket.end();
          settled = true;
          clearTimeout(timeout);
          resolve(frames[0]);
        }
      } catch (error) {
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      }
    });

    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      if (!settled) reject(new Error(`connection ${ip}:${port} closed before response`));
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
  }>();
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
          const rpcId = extractRpcId(frame);
          if (rpcId !== undefined) {
            const pending = this.pending.get(rpcId);
            this.pending.delete(rpcId);
            pending?.resolve(frame);
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
    // request()接收的是带4字节length-prefix的网络包，响应分帧后则不带前缀。
    // request() receives a four-byte length-prefixed packet, while decoded responses do not.
    const rpcId = extractRpcId(packet.subarray(4));
    if (rpcId === undefined) throw new Error("RPC request packet has no rpcId");
    if (this.pending.has(rpcId)) throw new Error(`duplicate pending rpcId: ${rpcId}`);
    return new Promise((resolve, reject) => {
      this.pending.set(rpcId, { resolve, reject });
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
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
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
