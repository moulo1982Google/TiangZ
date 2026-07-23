import { Application } from "pixi.js";

import "./Generated/SDK/Core/Net/BrowserWebSocketTransport";
import { ClientMessageDispatcher } from "./Generated/SDK/Core/Net/ClientMessageDispatcher";
import { LoginFlow } from "./Generated/SDK/Demo/LoginFlow";
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
    world = new MapWorld(app, result.gateSocket, result.enterMap.unitId, result.enterMap);
    messages = new ClientMessageDispatcher(result.gateSocket, MapMessageScope, world);
    loginPanel.style.display = "none";
    hud.style.display = "block";
    hud.textContent = `${result.login.account} | Map ${result.enterMap.mapId} | Unit ${result.enterMap.unitId}`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.style.color = "#ff8e8e";
    enter.disabled = false;
  }
}
