import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("Pixi 浏览器 smoke 当前使用 Windows Edge；其他平台请设置等价的浏览器验收命令");
}

const pageUrl = process.argv[2] ?? "http://127.0.0.1:7460/";
const debugPort = Number(process.argv[3] ?? 9333);
const edge = process.env.TIANGZ_BROWSER ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = await mkdtemp(path.join(os.tmpdir(), "tiangz-pixi-smoke-"));
const browser = spawn(edge, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--window-size=1280,720",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  pageUrl,
], { stdio: "ignore", windowsHide: true });

try {
  const target = await waitForTarget(debugPort, pageUrl, 10_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await waitForLoginButton(cdp, 10_000);
    await cdp.send("Runtime.evaluate", {
      expression: "document.querySelector('#enter')?.click()",
    });
    const state = await waitForPageState(cdp, 15_000);
    console.log("Pixi browser smoke passed", state);
  } finally {
    void cdp.send("Browser.close").catch(() => undefined);
    await delay(200);
    cdp.close();
  }
} finally {
  browser.kill();
  await Promise.race([
    new Promise((resolve) => browser.once("exit", resolve)),
    delay(2_000),
  ]);
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    .catch((error) => console.warn(`临时 Edge profile 稍后由系统清理：${error.message}`));
}

async function waitForTarget(port, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((candidate) => candidate.type === "page" && candidate.url === expectedUrl);
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Edge may not have opened its debugging endpoint yet.
    }
    await delay(100);
  }
  throw new Error(`等待 Edge 页面超时：${expectedUrl}`);
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("连接 Edge DevTools 失败")), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
      for (const request of pending.values()) request.reject(new Error("Edge DevTools 连接已关闭"));
      pending.clear();
    },
  };
}

async function waitForPageState(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const hud = document.querySelector('#hud');
        const status = document.querySelector('#status');
        const canvas = document.querySelector('canvas');
        return {
          ready: hud instanceof HTMLElement && hud.style.display === 'block' && hud.textContent.includes('Map'),
          hud: hud?.textContent ?? '',
          status: status?.textContent ?? '',
          canvasWidth: canvas?.width ?? 0,
          canvasHeight: canvas?.height ?? 0,
        };
      })()`,
      returnByValue: true,
    });
    const state = result.result.value;
    if (state?.ready && state.canvasWidth > 0 && state.canvasHeight > 0) return state;
    if (state?.status && /失败|超时|error/i.test(state.status)) {
      throw new Error(`Pixi 登录失败：${state.status}`);
    }
    await delay(100);
  }
  throw new Error("等待 Pixi 进入地图超时");
}

async function waitForLoginButton(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "Boolean(document.querySelector('#enter') && document.querySelector('canvas'))",
      returnByValue: true,
    });
    if (result.result.value === true) return;
    await delay(100);
  }
  throw new Error("等待 Pixi 页面初始化超时");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
