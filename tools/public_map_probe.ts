import assert from "node:assert/strict";
import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { MapClient, GateClient } from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";
import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";

const flows: LoginFlow[] = [];
const clients: MapClient[] = [];
const gates: GateClient[] = [];
const accounts: string[] = [];
const characters: bigint[] = [];
const timer = setInterval(() => flows.forEach(flow => flow.update()), 5);
let operation = 0;

async function action(index: number, name: string, args: object = {}) {
  if (name === "travel") {
    const response = await gates[index].enterPublicMap({ mapConfigId: 2, preferredInstanceId: BigInt((args as { preferred?: string }).preferred ?? "0") });
    return JSON.parse(JSON.stringify({ transfer: { ...response.enterMap, mapHostName: response.enterMap.mapService }, channelId: response.channelId },
      (_key, value) => typeof value === "bigint" ? value.toString() : value));
  }
  const response = await clients[index].invokeUnitAction({ namespace: "fixture.publicmaps", action: name,
    version: 1, operationId: `public-test-${++operation}`, payload: new TextEncoder().encode(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(response.payload));
}

try {
  for (let i = 0; i < 5; i++) {
    const flow = new LoginFlow({ transport: "websocket", host: "127.0.0.1", port: Number(process.argv[2]) });
    flows.push(flow);
    const account = `public_map_${Date.now()}_${i}`; accounts.push(account);
    const registration = await flow.register(account, "public_map_test_password");
    characters.push(registration.character!.characterId);
    const entered = await flow.enterGame(account, "public_map_test_password", 1, undefined, registration.character!.characterId);
    for (const descriptor of Object.values(ClientMessages)) entered.gateSocket.on(descriptor.msgcode, () => undefined);
    await new GateClient(entered.gateSocket).mapSnapshotReady({ unitId: entered.enterMap.unitId });
    clients.push(new MapClient(entered.gateSocket));
    gates.push(new GateClient(entered.gateSocket));
  }
  const arrivals = [];
  for (let i = 0; i < 5; i++) arrivals.push(await action(i, "travel"));
  assert.deepEqual(arrivals.map(a => a.channelId), [1, 1, 2, 2, 3]);
  assert.deepEqual(arrivals.map(a => a.transfer.mapHostName), ["public_host_a", "public_host_a", "public_host_a", "public_host_a", "public_host_b"]);
  assert.equal((await action(0, "where")).instance, arrivals[0].transfer.mapInstanceId);
  await assert.rejects(action(0, "direct", { instance: arrivals[4].transfer.mapInstanceId }));
  const moved = await action(0, "travel", { preferred: arrivals[4].transfer.mapInstanceId });
  assert.equal(moved.channelId, 3);
  assert.equal((await action(0, "where")).instance, moved.transfer.mapInstanceId);
  const listed = await action(0, "list");
  assert.deepEqual(listed.channels.map((c: any) => c.playerCount), [1, 2, 2]);
  assert.ok(listed.channels.every((c: any) => c.reservedCount === 0));
  const fallback = await action(1, "travel", { preferred: moved.transfer.mapInstanceId });
  assert.equal(fallback.channelId, 1);
  assert.equal(fallback.transfer.unitId, arrivals[1].transfer.unitId);
  const publicList = await gates[0].listPublicMaps({ mapConfigId: 2 });
  assert.equal(publicList.channels.length, 3);
  assert.ok(publicList.channels.every(channel => !("mapHost" in channel) && !("instance" in channel)));
  flows[0].close();
  await new Promise(resolve => setTimeout(resolve, 150));
  const reconnect = await flows[0].enterGame(accounts[0], "public_map_test_password", 2, undefined, characters[0]);
  for (const descriptor of Object.values(ClientMessages)) reconnect.gateSocket.on(descriptor.msgcode, () => undefined);
  clients[0] = new MapClient(reconnect.gateSocket); gates[0] = new GateClient(reconnect.gateSocket);
  assert.equal(reconnect.enterMap.mapInstanceId.toString(), moved.transfer.mapInstanceId);
  assert.equal((await action(0, "where")).instance, moved.transfer.mapInstanceId);
  assert.equal((await action(0, "travel")).channelId, 3);
  console.log("PUBLIC_MAP_RUNTIME_PASSED", JSON.stringify({ channels: listed.channels.map((c: any) => ({
    channel: c.channelId, instance: c.instance.mapInstanceId, host: c.instance.mapHostName, players: c.playerCount })),
    sameHostTransfer: true, crossHostTransfer: true, directBypassRejected: true, fullPreferredFallback: true, reconnectSameChannel: true }));
} finally {
  clearInterval(timer); flows.forEach(flow => flow.close());
}
