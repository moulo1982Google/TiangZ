import {
  ClientMessages,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";
import {
  G2C_BuffAdded,
  G2C_BuffRemoved,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import {
  GateClient,
  LoginClient,
  LoginMgrClient,
  MapClient,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { CreateOperationId } from "../client_sdk/typescript/Core/Protocol/OperationId";
import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";

const HOST = process.env.TIANGZ_LOGIN_HOST ?? "14.103.24.32";
const PORT = Number(process.env.TIANGZ_LOGIN_PORT ?? 17_000);
const SECURE = !["0", "false", "off"].includes(
  (process.env.TIANGZ_LOGIN_SECURE ?? "true").toLowerCase(),
);

async function main(): Promise<void> {
  const account = `buff_ws_probe_${Date.now()}`;
  const password = "buff_probe_password";
  const flow = new LoginFlow({ transport: "websocket", host: HOST, port: PORT, secure: SECURE });
  const updates = setInterval(() => flow.update(), 1);
  try {
    await flow.register(account, password);
    const result = await flow.enterGame(account, password, 100);
    const gate = result.gateSocket;
    if (result.enterMap.entities.length === 0) {
      const initial = gate.waitForMessage(ClientMessages.AoiDelta, { timeoutMs: 5_000 });
      await new GateClient(gate).mapSnapshotReady({ unitId: result.enterMap.unitId });
      await initial;
    }

    const item = result.enterMap.items.find((candidate) => candidate.configId === 1002 && candidate.count > 0);
    if (!item) throw new Error("EnterMap did not provide item 1002");

    let removed: G2C_BuffRemoved | undefined;
    const unsubscribeRemoved = gate.on<G2C_BuffRemoved>(ClientMessages.BuffRemoved, (message) => {
      removed = message;
    });
    const added = gate.waitForMessage<G2C_BuffAdded>(ClientMessages.BuffAdded, { timeoutMs: 5_000 });
    const response = await new MapClient(gate).useItem({
      itemId: item.itemId,
      operationId: CreateOperationId("buff-probe"),
    });
    const message = await added;
    if (!response.buff || response.buff.unitId !== result.enterMap.unitId || response.buff.buffConfigId !== 2001) {
      throw new Error("UseItem response did not echo the public Buff to the owner");
    }
    console.log("BuffAdded WebSocket probe:", {
      account,
      unitId: result.enterMap.unitId,
      responseBuffConfigId: response.buff.buffConfigId,
      buffUnitId: message.buff.unitId,
      buffConfigId: message.buff.buffConfigId,
      itemCount: response.item.count,
    });
    if (message.buff.unitId !== result.enterMap.unitId || message.buff.buffConfigId !== 2001) {
      throw new Error("WebSocket BuffAdded payload did not target the local player");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    unsubscribeRemoved();
    if (removed?.buffInstanceId === message.buff.buffInstanceId) {
      throw new Error("Buff 2001 was removed within one second after creation");
    }
  } finally {
    clearInterval(updates);
    flow.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
