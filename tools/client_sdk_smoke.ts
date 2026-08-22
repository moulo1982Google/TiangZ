import type { ClientTransportKind } from "../client_sdk/typescript/Core/Net/ClientTransport";
import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { GateClient } from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";
import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";
import { RpcError } from "../client_sdk/typescript/Core/Protocol/RpcError";

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
