import type { ClientTransportKind } from "../cocos_client2D/assets/scripts/Core/Net/ClientTransport";
import { LoginFlow } from "../cocos_client2D/assets/scripts/Demo/Login/LoginFlow";

async function main(): Promise<void> {
  const transport = (process.argv[2] ?? "websocket") as ClientTransportKind;
  const flow = new LoginFlow({
    transport,
    host: process.argv[3] ?? "127.0.0.1",
    port: Number(process.argv[4] ?? 7000),
  });

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
    flow.close();
  }
}

void main();
