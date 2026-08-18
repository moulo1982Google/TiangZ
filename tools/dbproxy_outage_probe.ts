import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";
import { GateClient, MapClient } from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";

const HOST = process.env.TIANGZ_LOGIN_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TIANGZ_LOGIN_PORT ?? 7_000);
const ACCOUNT = requireEnvironment("TIANGZ_OUTAGE_ACCOUNT");
const PASSWORD = process.env.TIANGZ_OUTAGE_PASSWORD ?? "dbproxy_outage_password";
const MAP_ID = 100;
const SMALL_HEALTH_POTION = 1001;
const OPERATION_ID = "dbproxy-all-endpoints-down-use-1";
const READY_MARKER = "TIANGZ_DBPROXY_READY_FOR_OUTAGE";
const FAILURE_MARKER = "TIANGZ_DBPROXY_OUTAGE_FAILED";

async function main(): Promise<void> {
  const flow = new LoginFlow({ transport: "websocket", host: HOST, port: PORT });
  const updates = setInterval(() => flow.update(), 1);
  try {
    const registered = await flow.register(ACCOUNT, PASSWORD);
    if (!registered.character) throw new Error("DBProxy outage probe did not create a character");
    const entered = await flow.enterGame(
      ACCOUNT,
      PASSWORD,
      MAP_ID,
      undefined,
      registered.character.characterId,
    );
    for (const descriptor of Object.values(ClientMessages)) {
      entered.gateSocket.on(descriptor, () => {});
    }
    const item = entered.enterMap.items.find((value) => value.configId === SMALL_HEALTH_POTION);
    if (!item || item.count !== 3) {
      throw new Error(`DBProxy outage probe expected three starter small potions, got ${item?.count ?? 0}`);
    }
    await new GateClient(entered.gateSocket).mapSnapshotReady({ unitId: entered.enterMap.unitId });
    const map = new MapClient(entered.gateSocket);

    console.log(READY_MARKER);
    await waitForParentContinue();

    let failureObserved = false;
    try {
      const response = await map.useItem(
        { itemId: item.itemId, operationId: OPERATION_ID },
        { timeoutMs: 20_000 },
      );
      failureObserved = response.error !== undefined;
      if (failureObserved) {
        console.log(`DBProxy outage returned business error=${response.error}`);
      }
    } catch (error) {
      failureObserved = true;
      console.log(`DBProxy outage rejected request: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!failureObserved) throw new Error("UseItem unexpectedly succeeded while both DBProxy endpoints were down");
    console.log(FAILURE_MARKER);
    await waitForParentContinue();

    const recovered = await map.useItem(
      { itemId: item.itemId, operationId: OPERATION_ID },
      { timeoutMs: 20_000 },
    );
    if (recovered.error || recovered.item.itemId !== item.itemId || recovered.item.count !== 2) {
      throw new Error(`DBProxy outage retry did not commit exactly once: ${JSON.stringify({
        error: recovered.error,
        itemId: recovered.item.itemId.toString(),
        count: recovered.item.count,
      })}`);
    }
    console.log("DBProxy all-endpoints outage recovery passed", {
      account: ACCOUNT,
      itemId: item.itemId.toString(),
      count: recovered.item.count,
    });
  } finally {
    clearInterval(updates);
    flow.close();
  }
}

function waitForParentContinue(): Promise<void> {
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    const onData = () => {
      process.stdin.pause();
      resolve();
    };
    process.stdin.once("data", onData);
    process.stdin.once("error", reject);
  });
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
