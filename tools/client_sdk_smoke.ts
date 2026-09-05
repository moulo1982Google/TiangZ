import type { ClientTransportKind } from "../client_sdk/typescript/Core/Net/ClientTransport";
import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { GateClient } from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";
import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";
import { RpcError } from "../client_sdk/typescript/Core/Protocol/RpcError";
import assert from "node:assert/strict";
import { RpcSocket } from "../client_sdk/typescript/Core/Net/RpcSocket";
import { LoginClient, LoginMgrClient } from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";
import { type ClientEndpoint, endpointWithAddress } from "../client_sdk/typescript/Core/Net/ClientTransport";

const MAP_NOT_FOUND_ERROR = 10_006;
const STARTUP_RETRY_INTERVAL_MS = 100;

async function main(): Promise<void> {
  const transport = (process.argv[2] ?? "websocket") as ClientTransportKind;
  const flow = new LoginFlow({
    transport,
    host: process.argv[3] ?? "127.0.0.1",
    port: Number(process.argv[4] ?? 7000),
  });
  const mapId = Number(process.argv[5] ?? 1);
  const startupGraceMs = Number(process.argv[6] ?? 0);
  const account = `sdk_smoke_${Date.now()}`;
  const password = "sdk_smoke_password";
  const updateTimer = setInterval(() => flow.update(), 5);

  try {
    await verifyEmptyAccount({ transport, host: process.argv[3] ?? "127.0.0.1", port: Number(process.argv[4] ?? 7000) });
    const registered = await flow.register(account, password);
    if (!registered.character) {
      throw new Error("registration returned an incomplete character");
    }
    const result = await enterGameWithStartupGrace(
      flow,
      account,
      password,
      mapId,
      registered.character.characterId,
      startupGraceMs,
    );
    if (result.login.selectedCharacterId !== registered.character.characterId) {
      throw new Error("Login did not keep the explicitly selected character");
    }
    const snapshotPromise = result.gateSocket.waitForMessage(ClientMessages.AoiDelta);
    await new GateClient(result.gateSocket).mapSnapshotReady({ unitId: result.enterMap.unitId });
    const snapshot = await snapshotPromise;
    const owner = snapshot.enters.find((entity) => entity.unitId === result.enterMap.unitId);
    if (owner?.persistentId !== registered.character.characterId) {
      throw new Error("AOI owner snapshot did not preserve the selected CharacterId");
    }
    const gate = new GateClient(result.gateSocket);
    await assert.rejects(gate.logoutCharacter({ characterId: registered.character.characterId + 1n }));
    const released = await gate.logoutCharacter({ characterId: registered.character.characterId });
    assert.equal(released.released, true);
    assert.equal(released.characterId, registered.character.characterId);
    const second = await flow.createCharacter(account, "SecondPilot");
    const switched = await enterGameWithStartupGrace(flow, account, password, mapId, second.character.characterId, startupGraceMs);
    assert.equal(switched.login.selectedCharacterId, second.character.characterId);
    await new GateClient(switched.gateSocket).logoutCharacter({ characterId: second.character.characterId });
    console.log("explicit logout and immediate character switch passed");
    console.log("client SDK smoke passed", {
      transport,
      account: result.login.account,
      gate: result.login.gateName,
      map: result.enterMap.mapService,
      unitId: result.enterMap.unitId,
      mapReadyUnitId: result.mapReady.unitId,
      entityCount: snapshot.enters.length,
      monsters: snapshot.enters
        .filter((entity) => entity.entityType === 2)
        .map((entity) => ({ unitId: entity.unitId, configId: entity.configId })),
    });
  } finally {
    clearInterval(updateTimer);
    flow.close();
  }
}

/** 验证账号凭据与角色目录分离，不依赖任何游戏特定模板。 / Verifies independent credentials and character catalogs without game-specific templates. */
async function verifyEmptyAccount(endpoint: ClientEndpoint): Promise<void> {
  const account = `ACCOUNT42_${Date.now()}`;
  const password = "catalog_password";
  const sockets: RpcSocket[] = [];
  const timer = setInterval(() => sockets.forEach((socket) => socket.update()), 5);
  try {
    const manager = new RpcSocket(endpoint);
    sockets.push(manager);
    const address = await new LoginMgrClient(manager).getLoginServiceAddr({ account });
    const socket = new RpcSocket(endpointWithAddress(endpoint, address.ip, address.port));
    sockets.push(socket);
    const login = new LoginClient(socket);
    const registered = await login.register({ account, password, skipInitialCharacter: true });
    assert.equal(registered.character, undefined);
    const empty = await login.login({ account, password });
    assert.deepEqual(empty.characters, []);
    assert.equal(empty.selectedCharacterId, 0n);
    assert.equal(empty.token, "");
    await assert.rejects(login.login({ account, password: "wrong_password" }), /密码错误/);
    await assert.rejects(login.login({ account, password, characterId: 7n }), /character not found/);
    await assert.rejects(login.register({ account, password, skipInitialCharacter: true }), /用户已注册/);
    const created = await login.createCharacter({ account, name: "Pilot", playerConfigId: 1, extensions: [] });
    assert.equal(created.characters.length, 1);
    const selected = await login.login({ account, password, characterId: created.character.characterId });
    assert.equal(selected.selectedCharacterId, created.character.characterId);
    assert.ok(selected.token.length > 0);
    console.log("empty account catalog smoke passed");
  } finally {
    clearInterval(timer);
    sockets.forEach((socket) => socket.close());
  }
}

/**
 * Split-process CI会并行启动全部进程；MapHost要到第一个Runtime Timer才发布静态路由，
 * 因而可能比Socket ready晚几个调度轮次。只有Smoke显式启用这个有界重试，且只重试
 * MapNotFound；正式客户端与其他失败仍保持严格语义。
 *
 * Split-process CI starts every executable concurrently. A MapHost publishes its
 * static route on the first runtime timer, which can trail socket readiness by a
 * few scheduler turns. Only the smoke harness opts into this bounded retry and
 * only MapNotFound is retryable; clients and unrelated failures stay strict.
 */
async function enterGameWithStartupGrace(
  flow: LoginFlow,
  account: string,
  password: string,
  mapId: number,
  characterId: bigint,
  startupGraceMs: number,
) {
  const deadline = Date.now() + Math.max(0, startupGraceMs);
  while (true) {
    try {
      return await flow.enterGame(account, password, mapId, undefined, characterId);
    } catch (error) {
      if (
        !(error instanceof RpcError) ||
        error.code !== MAP_NOT_FOUND_ERROR ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, STARTUP_RETRY_INTERVAL_MS));
    }
  }
}

void main();
