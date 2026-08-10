import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 7000);
const account = `takeover_ws_${Date.now()}`;
const password = "takeover_ws_password";

async function main(): Promise<void> {
  const first = new LoginFlow({ transport: "websocket", host, port });
  const second = new LoginFlow({ transport: "websocket", host, port });
  const updateTimer = setInterval(() => {
    first.update();
    second.update();
  }, 5);

  try {
    const registered = await first.register(account, password);
    if (!registered.character) throw new Error("WebSocket注册没有返回初始角色");

    const replacement = new Promise<{ reasonCode: number; reason: string }>((resolve) => {
      first.onSessionReplaced((message) => resolve(message));
    });
    const firstGame = await first.enterGame(
      account,
      password,
      1,
      undefined,
      registered.character.characterId,
    );
    const secondGame = await second.enterGame(
      account,
      password,
      1,
      undefined,
      registered.character.characterId,
    );
    const notice = await replacement;

    if (notice.reasonCode !== 10040 || notice.reason !== "账号已在其他设备登录") {
      throw new Error(`WebSocket顶号通知不匹配：${JSON.stringify(notice)}`);
    }
    if (firstGame.enterMap.unitId !== secondGame.enterMap.unitId) {
      throw new Error(
        `WebSocket顶号没有复用Unit：${firstGame.enterMap.unitId} -> ${secondGame.enterMap.unitId}`,
      );
    }
    console.log("WebSocket session takeover passed", {
      oldUnitId: firstGame.enterMap.unitId,
      newUnitId: secondGame.enterMap.unitId,
      reasonCode: notice.reasonCode,
      reason: notice.reason,
    });
  } finally {
    clearInterval(updateTimer);
    first.close();
    second.close();
  }
}

void main();
