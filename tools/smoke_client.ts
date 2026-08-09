import net from "node:net";
import {
  buildEnterMapPacket,
  buildAttackMonsterPacket,
  buildToggleAutoAttackPacket,
  buildCastSkillPacket,
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
  decodeAutoAttackStateFrame,
  decodeEntityMoveFrame,
  decodeEntityNavigateFrame,
  decodeEntityStateFrame,
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
  decodeToggleAutoAttackFrame,
  decodeCastSkillFrame,
  decodeSkillCastStateFrame,
  decodeSkillImpactFrame,
  decodeSkillProjectileFrame,
  decodePingFrame,
  buildPingPacket,
} from "./support/DemoClientProtocol";
import { BinaryReader, readU16BE } from "../app/core/protocol/binary";
import { LengthPrefixedFrameDecoder } from "../app/core/protocol/frame";
import { MsgCode } from "../client_sdk/typescript/Generated/Model/demo/protocol/msgcodes";
import type { CellMovementState } from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import { GameConfigs, SpatialMode } from "../client_sdk/typescript/Generated/Config";
import { NumericType } from "../app/model/demo/numeric/NumericType";
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
  const persistenceWriteAccount = namedArgument("--dbproxy-persistence-write");
  if (persistenceWriteAccount) {
    await writeDbProxyPersistenceFixture(loginAddr, persistenceWriteAccount);
    return;
  }
  const persistenceReadAccount = namedArgument("--dbproxy-persistence-read");
  if (persistenceReadAccount) {
    await verifyDbProxyPersistenceFixture(loginAddr, persistenceReadAccount);
    return;
  }
  if (process.argv.includes("--map100-initial-only") || process.argv.includes("--skill-only")) {
    const login = await requestLogin(loginAddr.ip, loginAddr.port, `smoke_map100_${Date.now()}`);
    const client = await openGateAndEnterMap(
      login.gateIp,
      login.gatePort,
      { account: login.account, token: login.token, mapId: 100 },
    );
    try {
      const monsters = client.enterMap.entities.filter((entity) => entity.entityType === 2);
      console.log("Map100 initial snapshot:", {
        unitId: client.enterMap.unitId,
        entityCount: client.enterMap.entities.length,
        monsters: monsters.map((entity) => ({ unitId: entity.unitId, configId: entity.configId })),
      });
      if (monsters.length !== 2) {
        throw new Error(`Map100 initial snapshot expected 2 monsters, got ${monsters.length}`);
      }
      if (process.argv.includes("--skill-only")) {
        await verifyFiveSkillMechanics(client.gate, client.enterMap);
      }
    } finally {
      await client.gate.close();
    }
    return;
  }
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

/** 消耗一件道具后主动断开，并等待Gate宽限期完成可靠下线保存。 / Consumes one item, disconnects, and waits for the Gate grace period to complete a durable offline save. */
async function writeDbProxyPersistenceFixture(
  loginAddr: { ip: string; port: number },
  account: string,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  const initial = client.enterMap.items.find((item) => item.configId === 1001);
  if (!initial || initial.count !== 50) {
    throw new Error(`DBProxy write fixture expected 50 small potions, got ${initial?.count}`);
  }
  console.log("DBProxy persistence player entered:", {
    account,
    unitId: client.enterMap.unitId,
    initialCount: initial.count,
  });
  let changed: ReturnType<typeof decodeUseItemFrame>["body"];
  try {
    changed = decodeUseItemFrame(await client.gate.request(
      buildUseItemPacket(nextRpcId++, { itemId: initial.itemId }),
    )).body;
    if (changed.error || changed.item.count !== 49) {
      throw new Error(`DBProxy write fixture item use failed: ${stringifyForError(changed)}`);
    }
  } finally {
    await client.gate.disconnect();
  }
  console.log("DBProxy persistence write staged:", {
    account,
    itemId: initial.itemId.toString(),
    count: changed.item.count,
    waitingForGateOfflineMs: 32_000,
  });
  await sleep(32_000);
}

/** 服务重启后读取同账号，确认没有重新发放默认背包。 / Reads the same account after a server restart and verifies starter inventory was not seeded again. */
async function verifyDbProxyPersistenceFixture(
  loginAddr: { ip: string; port: number },
  account: string,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  try {
    const restored = client.enterMap.items.find((item) => item.configId === 1001);
    if (!restored || restored.count !== 49 || restored.version !== 2) {
      throw new Error(
        `DBProxy restore expected count=49/version=2, got ${stringifyForError(restored)}`,
      );
    }
    console.log("DBProxy persistence restored:", {
      account,
      unitId: client.enterMap.unitId,
      itemId: restored.itemId.toString(),
      count: restored.count,
      version: restored.version,
    });
  } finally {
    await client.gate.disconnect();
  }
}

function namedArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined) return undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/** 验证五技能共用状态机的关键路径；复杂Buff冲突矩阵由buff-action自测覆盖。 / Verifies key paths of the shared five-skill state machine; buff-action tests cover the detailed conflict matrix. */
async function verifyFiveSkillMechanics(
  gate: TcpRpcConnection,
  enterMap: ReturnType<typeof decodeEnterMapFrame>["body"],
): Promise<void> {
  const targets = enterMap.entities
    .filter((entity) => entity.entityType === 2)
    .sort((left, right) => {
      const leftDistance = Math.hypot(left.x - enterMap.x, left.y - enterMap.y, left.z - enterMap.z);
      const rightDistance = Math.hypot(right.x - enterMap.x, right.y - enterMap.y, right.z - enterMap.z);
      return leftDistance - rightDistance;
    });
  const target = targets[0];
  const smiteTarget = targets[1];
  if (!target || !smiteTarget) throw new Error("skill smoke requires two AOI-visible monsters");

  const shieldRpcId = nextRpcId++;
  const shield = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(shieldRpcId, {
    skillId: 3004,
    targetUnitId: enterMap.unitId,
  })));
  if (shield.rpcId !== shieldRpcId || shield.body.error || shield.body.skillId !== 3004) {
    throw new Error(`Power Word: Shield failed: ${stringifyForError(shield.body)}`);
  }
  // 盾自身8秒CD先于15秒虚弱灵魂；等技能CD结束后才能验证Buff否决兜底。
  // Shield's 8-second cooldown precedes the 15-second Weakened Soul veto.
  await sleep(8_100);
  const blocked = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3004,
    targetUnitId: enterMap.unitId,
  })));
  if (blocked.body.error !== 10022) {
    throw new Error(`Weakened Soul did not veto a second shield: ${stringifyForError(blocked.body)}`);
  }

  const fortitude = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3005,
    targetUnitId: enterMap.unitId,
  })));
  if (fortitude.body.error || fortitude.body.skillId !== 3005) {
    throw new Error(`Power Word: Fortitude failed: ${stringifyForError(fortitude.body)}`);
  }
  await sleep(1_100);

  const projectilePush = gate.waitForMessage(MsgCode.G2C_SkillProjectile, 4_000);
  const frostbolt = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3001,
    targetUnitId: target.unitId,
  })));
  if (frostbolt.body.error || frostbolt.body.phase !== 1) {
    throw new Error(`Frostbolt did not begin casting: ${stringifyForError(frostbolt.body)}`);
  }
  const projectile = decodeSkillProjectileFrame(await projectilePush).body;
  const impact = await waitForSkillImpact(gate, 3001, 4_000);
  if (projectile.skillId !== 3001 || impact.skillId !== 3001 || impact.damage !== 50n || impact.damageSchool !== 2) {
    throw new Error(`Frostbolt result mismatch: ${stringifyForError({ projectile, impact })}`);
  }

  const fireBlast = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3002,
    targetUnitId: target.unitId,
  })));
  if (fireBlast.body.error) {
    throw new Error(`Fire Blast failed: ${stringifyForError(fireBlast.body)}`);
  }
  const fireImpact = await waitForSkillImpact(gate, 3002, 3_000);
  if (fireImpact.damage !== 50n || fireImpact.damageSchool !== 3) {
    throw new Error(`Fire Blast result mismatch: ${stringifyForError(fireImpact)}`);
  }
  await sleep(1_100);

  const castStatePush = gate.waitForMessage(MsgCode.G2C_SkillCastState, 3_000);
  const smite = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3003,
    targetUnitId: smiteTarget.unitId,
  })));
  if (smite.body.error || smite.body.phase !== 1) {
    throw new Error(`Smite did not begin casting: ${stringifyForError(smite.body)}`);
  }
  await gate.request(buildNavigateInputPacket(nextRpcId++, {
    forward: 1,
    strafe: 0,
    yaw: 0,
    sequence: 99,
  }));
  let interrupted = decodeSkillCastStateFrame(await castStatePush).body;
  const interruptDeadline = Date.now() + 3_000;
  while (interrupted.interruptReason !== "movement" && Date.now() < interruptDeadline) {
    interrupted = decodeSkillCastStateFrame(await gate.waitForMessage(
      MsgCode.G2C_SkillCastState,
      Math.max(1, interruptDeadline - Date.now()),
    )).body;
  }
  if (interrupted.phase !== 0 || interrupted.interruptReason !== "movement") {
    throw new Error(`movement did not interrupt Smite: ${stringifyForError(interrupted)}`);
  }
  await gate.request(buildNavigateInputPacket(nextRpcId++, {
    forward: 0,
    strafe: 0,
    yaw: 0,
    sequence: 100,
  }));

  console.log("Five-skill mechanics:", {
    shield: "accepted",
    weakenedSoul: "vetoed",
    fortitude: "accepted",
    frostboltDamage: impact.damage,
    frostboltSchool: impact.damageSchool,
    fireBlastFinalDamage: fireImpact.damage,
    fireBlastSchool: fireImpact.damageSchool,
    smiteInterrupt: interrupted.interruptReason,
  });
}

async function waitForSkillImpact(
  gate: TcpRpcConnection,
  skillId: number,
  timeoutMs: number,
): Promise<ReturnType<typeof decodeSkillImpactFrame>["body"]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const impact = decodeSkillImpactFrame(await gate.waitForMessage(
      MsgCode.G2C_SkillImpact,
      Math.max(1, deadline - Date.now()),
    )).body;
    if (impact.skillId === skillId) return impact;
  }
  throw new Error(`skill ${skillId} impact timed out`);
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
  await waitForDisposedRequest(`${requestId}:second`);
  console.log("Dynamic map lifecycle:", {
    mapConfigId: created.instance.mapConfigId,
    mapInstanceId: created.instance.mapInstanceId,
    mapHostName: created.instance.mapHostName,
    secondDisposed: disposed.disposed,
  });
  return created.instance;
}

/** 销毁完成后重试旧requestId，确认MapManager已经收到最终通知并拒绝复用。 / Retries a disposed request ID to verify MapManager received the final notification and rejects reuse. */
async function waitForDisposedRequest(requestId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = await requestOneInternal(
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
    const response = M2S_CreateDynamicMapCodec.decode(frame.subarray(2));
    if (response.error) return;
    await sleep(100);
  }
  throw new Error(`MapManager did not acknowledge disposed dynamic map: ${requestId}`);
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

    const afterDisconnect = await openGateAndEnterMap(ip, port, request);
  try {
    if (afterDisconnect.enterMap.unitId !== first.enterMap.unitId) {
      throw new Error("reconnect grace did not preserve the existing map unit");
    }
    console.log("GateSession lifecycle:", {
      reboundUnitId: first.enterMap.unitId,
      resumedUnitId: afterDisconnect.enterMap.unitId,
    });
    const currentHp = verifyNumericDefaults(
      afterDisconnect.gate,
      afterDisconnect.enterMap.unitId,
      afterDisconnect.enterMap.entities.find(
        (entity) => entity.unitId === afterDisconnect.enterMap.unitId,
      )?.numerics ?? [],
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
  const queuedItem = previous.items.find((item) => item.configId === 1002);
  if (!queuedItem || queuedItem.count <= 0) {
    throw new Error("map transfer smoke requires the untouched large health potion stack");
  }
  // 前一步已经使用小红并提交共享GCD；等待GCD自然结束后改用未进入自身CD的大红。
  // The previous step committed the shared GCD with the small potion. Wait for
  // that GCD, then use the untouched large-potion cooldown domain during transfer.
  await sleep(1_100);
  const rpcId = nextRpcId++;
  const readyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
  const responsePromise = gate.request(buildEnterMapPacket(rpcId, { mapId: 2, mapInstanceId: 0n }));
  const queuedItemRpcId = nextRpcId++;
  const queuedItemEvent = gate.waitForMessage(MsgCode.G2C_ItemChanged);
  const queuedItemResponse = gate.request(
    buildUseItemPacket(queuedItemRpcId, { itemId: queuedItem.itemId }),
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
    !itemAfter ||
    itemAfter?.count !== expectedItem.count ||
    itemAfter?.version !== expectedItem.version
  ) {
    throw new Error(`map transfer did not preserve player state: ${stringifyForError({ previous, transferred, ready: ready.body })}`);
  }

  const afterHp = transferred.entities
    .find((entity) => entity.unitId === transferred.unitId)
    ?.numerics.find((numeric) => numeric.numericType === NumericType.CurrentHp)?.value;
  if (afterHp === undefined || afterHp < expectedMinimumHp) {
    throw new Error(
      `map transfer lost Numeric state: expected>=${expectedMinimumHp}, after=${afterHp}`,
    );
  }
  const itemResponse = decodeUseItemFrame(await queuedItemResponse);
  if (itemResponse.rpcId !== queuedItemRpcId || itemResponse.body.error) {
    throw new Error(`queued transfer-time UseItem failed: ${stringifyForError(itemResponse.body)}`);
  }
  const itemEvent = decodeItemChangedFrame(await queuedItemEvent);
  if (
    itemResponse.body.item.count !== queuedItem.count - 1 ||
    itemResponse.body.globalCooldownEndAtMs <= 0n ||
    itemResponse.body.itemCooldownEndAtMs <= itemResponse.body.globalCooldownEndAtMs ||
    itemEvent.body.item.version !== itemResponse.body.item.version
  ) {
    throw new Error("queued transfer-time UseItem was not executed exactly once on the target Unit");
  }
  // 背包事件和Numeric增量是两个独立Push；只有实际恢复了HP才等待Numeric，避免把满血不变
  // 的合法行为误判成超时。
  // Inventory and Numeric are independent pushes; wait for Numeric only when the heal can
  // actually change HP, so a valid full-health use is not treated as a timeout.
  const useConfig = GameConfigs.ItemConfig.Get(queuedItem.configId);
  const restoreHp = useConfig.useEffect === 2
    ? BigInt(useConfig.useParams[1] ?? 0)
    : 0n;
  const maxHp = BigInt(GameConfigs.PlayerConfig.Get(1).maxHp);
  const expectedQueuedHp = expectedMinimumHp + restoreHp < maxHp
    ? expectedMinimumHp + restoreHp
    : maxHp;
  const playerHpAfterQueuedItem = expectedMinimumHp >= maxHp || expectedQueuedHp === expectedMinimumHp
    ? expectedMinimumHp
    : await waitForPlayerHpAtLeast(
      gate,
      transferred.unitId,
      expectedQueuedHp,
      2_000,
    );
  console.log("Map transfer:", {
    unitId: transferred.unitId,
    fromMapId: previous.mapId,
    toMapId: transferred.mapId,
    x: transferred.x,
    y: transferred.y,
    z: transferred.z,
    itemCount: itemAfter?.count,
    queuedItemCount: itemResponse.body.item.count,
    currentHp: playerHpAfterQueuedItem,
  });
  const respawnedMonsterId = await verifyMonsterLifecycle(gate, transferred, playerHpAfterQueuedItem);
  await verifyAutoAttackTimer(gate, transferred.unitId, respawnedMonsterId);
  const navigation = await verifyNavMeshTransfer(gate, transferred);
  return await verifyDynamicMapTransfer(gate, navigation, dynamicMap);
}

/** 验证固定刷点怪物的攻击、尸体状态、AOI离开和新Unit复活闭环。 / Verifies attack, corpse state, AOI removal, and respawn as a new Unit. */
async function verifyMonsterLifecycle(
  gate: TcpRpcConnection,
  enterMap: ReturnType<typeof decodeEnterMapFrame>["body"],
  playerCurrentHp?: bigint,
): Promise<number> {
  const monster = enterMap.entities.find(
    (entity) => entity.entityType === 2 && entity.configId === 1,
  );
  if (!monster) {
    throw new Error(`map2 snapshot did not include the training dummy: ${stringifyForError(enterMap.entities)}`);
  }
  const initialHp = monster.numerics.find((numeric) => numeric.numericType === NumericType.CurrentHp)?.value;
  const initialAttack = monster.numerics.find((numeric) => numeric.numericType === NumericType.Attack)?.value;
  if (initialHp !== 100n || initialAttack !== 8n) {
    throw new Error(`training dummy has unexpected initial HP: ${initialHp}`);
  }

  const playerHpBeforeThreat = playerCurrentHp ?? enterMap.entities
    .find((entity) => entity.unitId === enterMap.unitId)
    ?.numerics.find((numeric) => numeric.numericType === NumericType.CurrentHp)?.value;
  if (playerHpBeforeThreat === undefined) {
    throw new Error("map2 snapshot did not include the player's CurrentHp");
  }
  // 被动怪在没有仇恨时必须保持待机；不能因为收到一次攻击事件就直接扣玩家血。
  // A passive monster must stay idle without threat; receiving an attack event alone
  // must not make it damage the player.
  await assertNoPlayerHpChange(gate, enterMap.unitId, playerHpBeforeThreat, 700);

  const expectedHits = 20;
  let deathStateFrame: Promise<Uint8Array> | undefined;
  let deathLeaveFrame: Promise<Uint8Array> | undefined;
  for (let hit = 1; hit <= expectedHits; hit += 1) {
    // 最后一击前同时监听死亡状态与最终Leave；尸体必须先以alive=false留在AOI，复活时才离场。
    // Arm both listeners before the final hit: the corpse must remain in AOI as alive=false and leave only at respawn.
    if (hit === expectedHits) {
      deathStateFrame = gate.waitForMessage(MsgCode.G2C_EntityState, 5_000);
      deathLeaveFrame = gate.waitForMessage(MsgCode.G2C_AoiDelta, 15_000);
    }
    const response = decodeAttackMonsterFrame(await gate.request(
      buildAttackMonsterPacket(nextRpcId++, { monsterId: monster.unitId }),
    ));
    if (
      response.body.error ||
      response.body.monsterId !== monster.unitId ||
      response.body.damage !== 5 ||
      response.body.remainingHp !== BigInt((expectedHits - hit) * 5) ||
      response.body.killed !== (hit === expectedHits)
    ) {
      throw new Error(`monster attack result mismatch: ${stringifyForError(response.body)}`);
    }
    if (hit === 1) {
      // 第一次实际伤害写入1:1仇恨后，被动怪才可以在5Hz桶攻击当前仇恨目标。
      // After the first resolved damage adds 1:1 threat, the passive monster may
      // attack its threat target on the 5Hz bucket.
      await waitForPlayerHpDecrease(gate, enterMap.unitId, playerHpBeforeThreat, 3_000);
    }
  }

  if (!deathStateFrame || !deathLeaveFrame) {
    throw new Error("monster death listeners were not armed");
  }

  let deathState = decodeEntityStateFrame(await deathStateFrame);
  const stateDeadline = Date.now() + 5_000;
  let corpseState = deathState.body.states.find((state) => state.unitId === monster.unitId);
  while ((!corpseState || corpseState.alive) && Date.now() < stateDeadline) {
    deathState = decodeEntityStateFrame(await gate.waitForMessage(
      MsgCode.G2C_EntityState,
      Math.max(1, stateDeadline - Date.now()),
    ));
    corpseState = deathState.body.states.find((state) => state.unitId === monster.unitId);
  }
  if (!corpseState || corpseState.alive) {
    throw new Error(`monster death did not retain an alive=false corpse: ${stringifyForError(deathState.body)}`);
  }

  let deathDelta = decodeAoiDeltaFrame(await deathLeaveFrame);
  const deathDeadline = Date.now() + 15_000;
  while (!deathDelta.body.leaves.includes(monster.unitId) && Date.now() < deathDeadline) {
    deathDelta = decodeAoiDeltaFrame(await gate.waitForMessage(
      MsgCode.G2C_AoiDelta,
      Math.max(1, deathDeadline - Date.now()),
    ));
  }
  if (!deathDelta.body.leaves.includes(monster.unitId)) {
    throw new Error(`monster death did not produce an AOI Leave: ${stringifyForError(deathDelta.body)}`);
  }

  // 死亡后等待配置的复活周期，并确认刷怪槽创建了新的UnitId。
  // Wait for the configured respawn period and confirm that the spawn slot created a new UnitId.
  let respawnedMonster: ReturnType<typeof decodeEnterMapFrame>["body"]["entities"][number] | undefined;
  const respawnDeadline = Date.now() + 15_000;
  while (!respawnedMonster && Date.now() < respawnDeadline) {
    const delta = decodeAoiDeltaFrame(await gate.waitForMessage(
      MsgCode.G2C_AoiDelta,
      Math.max(1, respawnDeadline - Date.now()),
    ));
    respawnedMonster = delta.body.enters.find((entity) =>
      entity.entityType === 2 &&
      entity.configId === monster.configId &&
      entity.unitId !== monster.unitId,
    );
  }
  const respawnHp = respawnedMonster?.numerics.find(
    (numeric) => numeric.numericType === NumericType.CurrentHp,
  )?.value;
  if (!respawnedMonster || respawnHp !== 100n || respawnedMonster.alive !== true) {
    throw new Error(`monster respawn did not create a fresh Unit: ${stringifyForError({
      initialUnitId: monster.unitId,
      respawnedUnitId: respawnedMonster?.unitId,
      respawnHp,
      respawnedAlive: respawnedMonster?.alive,
    })}`);
  }
  console.log("Monster lifecycle:", {
    initialMonsterId: monster.unitId,
    killedMonsterId: monster.unitId,
    corpseAlive: corpseState.alive,
    respawnedMonsterId: respawnedMonster.unitId,
    respawnHp,
  });
  return respawnedMonster.unitId;
}

/** 确认一段时间内指定玩家的HP没有被被动怪误扣。 / Confirms that a player's HP is not changed by a passive monster during a quiet window. */
async function assertNoPlayerHpChange(
  gate: TcpRpcConnection,
  playerUnitId: number,
  currentHp: bigint,
  durationMs: number,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    try {
      const frame = decodeEntityNumericFrame(await gate.waitForMessage(
        MsgCode.G2C_EntityNumeric,
        Math.max(1, deadline - Date.now()),
      ));
      const changed = frame.body.numerics.find(
        (numeric) => numeric.unitId === playerUnitId &&
          numeric.numericType === NumericType.CurrentHp &&
          numeric.value !== currentHp,
      );
      if (changed) {
        throw new Error(`passive monster changed player HP without threat: ${changed.value}`);
      }
    } catch (error) {
      if (error instanceof Error && /timed out/i.test(error.message)) return;
      throw error;
    }
  }
}

/** 等待实际仇恨产生后的玩家掉血；只接受服务端Numeric增量，不猜测AI内部状态。 / Waits for player damage after real threat is created, using only authoritative Numeric deltas. */
async function waitForPlayerHpDecrease(
  gate: TcpRpcConnection,
  playerUnitId: number,
  previousHp: bigint,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = decodeEntityNumericFrame(await gate.waitForMessage(
      MsgCode.G2C_EntityNumeric,
      Math.max(1, deadline - Date.now()),
    ));
    const changed = frame.body.numerics.find(
      (numeric) => numeric.unitId === playerUnitId &&
        numeric.numericType === NumericType.CurrentHp &&
        numeric.value < previousHp,
    );
    if (changed) return;
  }
  throw new Error("passive monster did not attack after threat was added");
}

/** 等待玩家收到至少目标HP的权威增量；用于先排空传送期间排队的恢复道具。 / Waits for an authoritative player HP delta at or above a target, draining queued transfer-time heals first. */
async function waitForPlayerHpAtLeast(
  gate: TcpRpcConnection,
  playerUnitId: number,
  minimumHp: bigint,
  timeoutMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = decodeEntityNumericFrame(await gate.waitForMessage(
      MsgCode.G2C_EntityNumeric,
      Math.max(1, deadline - Date.now()),
    ));
    const changed = frame.body.numerics.find(
      (numeric) => numeric.unitId === playerUnitId &&
        numeric.numericType === NumericType.CurrentHp &&
        numeric.value >= minimumHp,
    );
    if (changed) return changed.value;
  }
  throw new Error(`player HP update did not reach ${minimumHp}`);
}

/** 真实推进多轮平A；验证不是只收到一次状态，而是10Hz桶持续结算到Numeric。 / Advances several real auto-attack swings and verifies that the 10Hz bucket keeps resolving Numeric damage instead of stopping after one state. */
async function verifyAutoAttackTimer(
  gate: TcpRpcConnection,
  playerUnitId: number,
  monsterUnitId: number,
): Promise<void> {
  // Map 2的训练木桩在玩家出生点正东；先用Grid移动让权威Yaw转向+X，再停在1米距离。
  // The map-2 dummy is one cell east after one step; turn the authoritative yaw to +X first.
  await gate.send(buildMovePacket({ inputX: 1, inputZ: 0, sequence: 4 }));
  await waitForMovementSequence(gate, playerUnitId, 4);
  await gate.send(buildMovePacket({ inputX: 0, inputZ: 0, sequence: 5 }));
  await waitForMovementStopped(gate, playerUnitId, 5);

  const statePush = gate.waitForMessage(MsgCode.G2C_AutoAttackState, 5_000);
  const enabledRpcId = nextRpcId++;
  const enabled = decodeToggleAutoAttackFrame(await gate.request(
    buildToggleAutoAttackPacket(enabledRpcId, {
      enabled: true,
      targetUnitId: monsterUnitId,
    }),
  ));
  const pushedState = decodeAutoAttackStateFrame(await statePush);
  if (
    enabled.rpcId !== enabledRpcId ||
    enabled.body.error ||
    !enabled.body.enabled ||
    !pushedState.body.enabled ||
    pushedState.body.targetUnitId !== monsterUnitId
  ) {
    throw new Error(`auto attack did not activate: ${stringifyForError({ enabled: enabled.body, pushed: pushedState.body })}`);
  }

  const expectedSwings = 6;
  const hpValues: bigint[] = [];
  let previousHp = 100n;
  const deadline = Date.now() + 13_500;
  while (hpValues.length < expectedSwings && Date.now() < deadline) {
    const frame = decodeEntityNumericFrame(await gate.waitForMessage(
      MsgCode.G2C_EntityNumeric,
      Math.max(1, deadline - Date.now()),
    ));
    const hp = frame.body.numerics.find(
      (numeric) => numeric.unitId === monsterUnitId && numeric.numericType === NumericType.CurrentHp,
    )?.value;
    if (hp !== undefined && hp < previousHp) {
      hpValues.push(hp);
      previousHp = hp;
    }
  }

  const disabledState = gate.waitForMessage(MsgCode.G2C_AutoAttackState, 5_000);
  const disabledRpcId = nextRpcId++;
  const disabled = decodeToggleAutoAttackFrame(await gate.request(
    buildToggleAutoAttackPacket(disabledRpcId, {
      enabled: false,
      targetUnitId: monsterUnitId,
    }),
  ));
  await disabledState;
  if (hpValues.length < expectedSwings || disabled.rpcId !== disabledRpcId || disabled.body.error || disabled.body.enabled) {
    throw new Error(`auto attack timer stopped before ${expectedSwings} swings: ${stringifyForError({ hpValues, disabled: disabled.body })}`);
  }
  console.log("Auto-attack timer:", { playerUnitId, monsterUnitId, hpValues });
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
  const navMeshMonsters = transferred.entities
    .filter((entity) => entity.entityType === 2)
    .map((entity) => ({ unitId: entity.unitId, configId: entity.configId }));
  console.log("NavMesh3D monsters:", navMeshMonsters);
  if (
    navMeshMonsters.length !== 2 ||
    !navMeshMonsters.some((monster) => monster.configId === 1) ||
    !navMeshMonsters.some((monster) => monster.configId === 2)
  ) {
    throw new Error(`Map 100 monster snapshot mismatch: ${stringifyForError(navMeshMonsters)}`);
  }
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
  const initial = enterMap.items.find((item) => item.configId === 1001);
  if (!initial || initial.count !== 50) {
    throw new Error("enter-map snapshot did not include the initial item state");
  }
  const itemConfig = GameConfigs.ItemConfig.Get(initial.configId);
  const maxHp = BigInt(GameConfigs.PlayerConfig.Get(1).maxHp);
  const restoredHp = itemConfig.useEffect === 2
    ? previousHp + BigInt(itemConfig.useParams[1] ?? 0)
    : previousHp;
  const expectedHp = restoredHp < maxHp ? restoredHp : maxHp;
  const pushed = gate.waitForMessage(MsgCode.G2C_ItemChanged);
  const responseFrame = await gate.request(
    buildUseItemPacket(nextRpcId++, { itemId: initial.itemId }),
  );
  const useItemResponse = decodeUseItemFrame(responseFrame).body;
  const response = useItemResponse.item;
  const event = decodeItemChangedFrame(await pushed).body.item;
  if (response.count !== 49 || event.count !== 49 || response.version !== event.version) {
    throw new Error("immediate item response and event are inconsistent");
  }
  if (
    useItemResponse.globalCooldownEndAtMs <= 0n ||
    useItemResponse.itemCooldownEndAtMs <= useItemResponse.globalCooldownEndAtMs
  ) {
    throw new Error("item use response did not return authoritative GCD/CD deadlines");
  }

  // 满血使用恢复道具不会修改 Numeric，也就不会产生 G2C_EntityNumeric。
  // A full-health item use does not dirty Numeric, so no G2C_EntityNumeric is expected.
  if (previousHp >= maxHp) {
    console.log("Immediate item event:", {
      itemId: event.itemId,
      count: event.count,
      version: event.version,
      currentHp: previousHp,
      numericChanged: false,
    });
    return { item: response, currentHp: previousHp };
  }

  let numericPushed = gate.waitForMessage(MsgCode.G2C_EntityNumeric);
  const deadline = Date.now() + 2_000;
  let currentHp: bigint | undefined;
  while (Date.now() < deadline) {
    const frame = await numericPushed;
    currentHp = decodeEntityNumericFrame(frame).body.numerics.find(
      (numeric) => numeric.unitId === enterMap.unitId && numeric.numericType === NumericType.CurrentHp,
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

function verifyNumericDefaults(
  _gate: TcpRpcConnection,
  unitId: number,
  initialNumerics: readonly { numericType: number; value: bigint }[],
  _initialFrame?: Uint8Array,
): bigint {
  const playerConfig = GameConfigs.PlayerConfig.Get(1);
  const currentHp = initialNumerics.find((numeric) => numeric.numericType === NumericType.CurrentHp)?.value;
  const maxHp = initialNumerics.find((numeric) => numeric.numericType === NumericType.MaxHp)?.value;
  const currentMp = initialNumerics.find((numeric) => numeric.numericType === NumericType.CurrentMp)?.value;
  const maxMp = initialNumerics.find((numeric) => numeric.numericType === NumericType.MaxMp)?.value;
  const attack = initialNumerics.find((numeric) => numeric.numericType === NumericType.Attack)?.value;
  if (
    currentHp !== BigInt(playerConfig.initialHp) ||
    maxHp !== BigInt(playerConfig.maxHp) ||
    currentMp !== BigInt(playerConfig.initialMp) ||
    maxMp !== BigInt(playerConfig.maxMp) ||
    attack !== 5n
  ) {
    throw new Error(
      `enter-map snapshot is missing Numeric defaults: unit ${unitId}, numerics=${initialNumerics.map((numeric) => `${numeric.numericType}=${numeric.value}`).join(",")}`,
    );
  }
  console.log("Numeric defaults:", { unitId, currentHp, maxHp, currentMp, maxMp, attack });
  return currentHp;
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

/** 等待当前Cell移动完成；停止输入只阻止下一格，不会取消已经开始的这一格。 / Waits for the current Cell step to finish; a stop input prevents the next step but does not cancel the current one. */
async function waitForMovementStopped(
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
    if (!movement || movement.acknowledgedSequence < sequence) continue;
    if (!movement.moving) return { ...movement, serverTick: body.serverTick };
  }
  throw new Error(`timed out waiting for movement to stop at sequence ${sequence}`);
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
    // Map 100中的怪物也会广播导航状态，不能假设下一帧一定属于测试玩家。
    // Monsters on Map 100 also publish navigation, so select by player and sequence.
    const moverNavigationState = waitForNavigationState(
      mover.gate,
      moverNav.unitId,
      1,
      true,
    );
    const observerNavigationState = waitForNavigationState(
      observer.gate,
      moverNav.unitId,
      1,
      true,
    );
    const navigateRpcId = nextRpcId++;
    const navigate = decodeNavigateToFrame(await mover.gate.request(buildNavigateToPacket(
      navigateRpcId,
      { targetX: 10, targetY: 0, targetZ: 10, sequence: 1 },
    )));
    const [moverNavState, observerNavState] = await Promise.all([
      moverNavigationState,
      observerNavigationState,
    ]);
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
): Promise<{
  gate: TcpRpcConnection;
  enterMap: ReturnType<typeof decodeEnterMapFrame>["body"];
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
    const mapReadyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
    // 先注册推送监听，再立即检查RPC结果；否则Promise.all会用MapReady超时遮住真正的业务错误。
    // Subscribe first, then inspect the RPC immediately so a MapReady timeout cannot hide its error.
    void mapReadyFrame.catch(() => undefined);
    const enterMap = decodeEnterMapFrame(await gate.request(
      buildEnterMapPacket(enterMapRpcId, { mapId: request.mapId, mapInstanceId: 0n }),
    ));
    if (enterMap.rpcId !== enterMapRpcId || enterMap.body.error) {
      throw new Error(`EnterMap failed: ${JSON.stringify(enterMap.body)}`);
    }
    const mapReady = decodeMapReadyFrame(await mapReadyFrame);
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
    timer: ReturnType<typeof setTimeout>;
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
            if (pending) clearTimeout(pending.timer);
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

  async request(packet: Uint8Array, timeoutMs = 5000): Promise<Uint8Array> {
    await this.connected;
    // request()接收的是带4字节length-prefix的网络包，响应分帧后则不带前缀。
    // request() receives a four-byte length-prefixed packet, while decoded responses do not.
    const rpcId = extractRpcId(packet.subarray(4));
    if (rpcId === undefined) throw new Error("RPC request packet has no rpcId");
    if (this.pending.has(rpcId)) throw new Error(`duplicate pending rpcId: ${rpcId}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(rpcId)) return;
        reject(new Error(`RPC ${rpcId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(rpcId, { resolve, reject, timer });
      this.socket.write(Buffer.from(packet), (error) => {
        if (!error) return;
        const pending = this.pending.get(rpcId);
        if (!pending) return;
        this.pending.delete(rpcId);
        clearTimeout(pending.timer);
        reject(error);
      });
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

  /** 立即模拟客户端进程消失，供Gate断线宽限与恢复测试使用。 / Immediately simulates a vanished client process for Gate grace and recovery tests. */
  async disconnect(): Promise<void> {
    if (this.socket.destroyed) return;
    this.socket.destroy();
    await this.closed;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
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
