import { Application } from "pixi.js";

import "./Generated/SDK/Core/Net/BrowserWebSocketTransport";
import { ClientMessageDispatcher } from "./Generated/SDK/Core/Net/ClientMessageDispatcher";
import { LoginFlow } from "./Generated/SDK/Demo/LoginFlow";
import { ClientMessages } from "./Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import { GateClient } from "./Generated/SDK/Generated/Model/demo/protocol/clients";
import type { S2C_Login } from "./Generated/SDK/Generated/Model/demo/protocol/messages";
import type { RpcSocket } from "./Generated/SDK/Core/Net/RpcSocket";
import { GameConfigs } from "./Generated/SDK/Generated/Config";
import "./Generated/Hotfix/handlers";
import { MapMessageScope } from "./Map/MapMessageScope";
import { MapWorld } from "./Map/MapWorld";

const app = new Application();
await app.init({ resizeTo: window, background: "#11171a", antialias: true });
document.querySelector("#game")!.appendChild(app.canvas);

const account = document.querySelector<HTMLInputElement>("#account")!;
const enter = document.querySelector<HTMLButtonElement>("#enter")!;
const status = document.querySelector<HTMLElement>("#status")!;
const loginPanel = document.querySelector<HTMLElement>("#login")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
account.value = `pixi_${Math.floor(Math.random() * 100000)}`;

let flow: LoginFlow | undefined;
let world: MapWorld | undefined;
let messages: ClientMessageDispatcher<MapWorld> | undefined;
let gateSocket: RpcSocket | undefined;
let loginResult: S2C_Login | undefined;
let currentMapId = 0;
let switchingMap = false;

app.ticker.add((ticker) => {
  flow?.update();
  world?.update(ticker.deltaMS / 1000);
});

enter.addEventListener("click", () => void enterGame());

async function enterGame(): Promise<void> {
  enter.disabled = true;
  messages?.dispose();
  world?.dispose();
  flow?.close();
  flow = new LoginFlow({ transport: "websocket", host: location.hostname || "127.0.0.1", port: 7000 });
  try {
    const result = await flow.enterGame(account.value.trim() || `pixi_${Date.now()}`, 1, (text) => {
      status.textContent = text;
    });
    gateSocket = result.gateSocket;
    loginResult = result.login;
    showMap(result.enterMap);
    loginPanel.style.display = "none";
    hud.style.display = "block";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.style.color = "#ff8e8e";
    enter.disabled = false;
  }
}

async function switchMap(): Promise<void> {
  if (switchingMap || !gateSocket || !loginResult) return;
  switchingMap = true;
  try {
    const targetMapId = currentMapId === 1 ? 2 : 1;
    const gate = new GateClient(gateSocket);
    const [enterMap] = await Promise.all([
      gate.enterMap({ mapId: targetMapId }),
      gateSocket.waitForMessage(ClientMessages.MapReady),
    ]);
    showMap(enterMap);
  } catch (error) {
    status.textContent = `地图传送失败：${error instanceof Error ? error.message : String(error)}`;
    status.style.color = "#ff8e8e";
  } finally {
    switchingMap = false;
  }
}

function showMap(enterMap: Parameters<typeof createWorld>[0]): void {
  messages?.dispose();
  world?.dispose();
  world = createWorld(enterMap);
  messages = new ClientMessageDispatcher(gateSocket!, MapMessageScope, world);
  // 先注册地图消息处理器，再确认可以接收初始AOI快照。
  // Install map handlers before acknowledging readiness for the initial AOI snapshot.
  if (enterMap.entities.length === 0) {
    void new GateClient(gateSocket!)
      .mapSnapshotReady({ unitId: enterMap.unitId })
      .catch((error) => {
        status.textContent = `初始地图快照失败：${error instanceof Error ? error.message : String(error)}`;
        status.style.color = "#ff8e8e";
      });
  }
  currentMapId = enterMap.mapId;
  const mapName = GameConfigs.MapConfig.Get(enterMap.mapId).name;
  hud.textContent = `${loginResult!.account} | ${mapName} [Map ${enterMap.mapId}] | Unit ${enterMap.unitId} | T 切换地图`;
}

function createWorld(
  enterMap: import("./Generated/SDK/Generated/Model/demo/protocol/messages").G2C_EnterMap,
): MapWorld {
  return new MapWorld(app, gateSocket!, enterMap.unitId, enterMap, () => void switchMap());
}
