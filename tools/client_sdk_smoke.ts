import type { ClientTransportKind } from "../client_sdk/typescript/Core/Net/ClientTransport";
import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";

async function main(): Promise<void> {
  const transport = (process.argv[2] ?? "websocket") as ClientTransportKind;
  const flow = new LoginFlow({
    transport,
    host: process.argv[3] ?? "127.0.0.1",
    port: Number(process.argv[4] ?? 7000),
  });
  const updateTimer = setInterval(() => flow.update(), 5);

  try {
    const result = await flow.enterGame(`sdk_smoke_${Date.now()}`, 1);
    console.log("client SDK smoke passed", {
      transport,
      account: result.login.account,
      gate: result.login.gateName,
      map: result.enterMap.mapService,
      unitId: result.enterMap.unitId,
      mapReadyUnitId: result.mapReady.unitId,
    });
  } finally {
    clearInterval(updateTimer);
    flow.close();
  }
}

void main();
