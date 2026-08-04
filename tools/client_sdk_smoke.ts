import type { ClientTransportKind } from "../client_sdk/typescript/Core/Net/ClientTransport";
import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { GateClient } from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";
import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";

async function main(): Promise<void> {
  const transport = (process.argv[2] ?? "websocket") as ClientTransportKind;
  const flow = new LoginFlow({
    transport,
    host: process.argv[3] ?? "127.0.0.1",
    port: Number(process.argv[4] ?? 7000),
  });
  const mapId = Number(process.argv[5] ?? 1);
  const updateTimer = setInterval(() => flow.update(), 5);

  try {
    const result = await flow.enterGame(`sdk_smoke_${Date.now()}`, mapId);
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

void main();
