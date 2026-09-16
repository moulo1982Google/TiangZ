import assert from "node:assert/strict";
import "../modules/starter/generated/typescript/Core/Net/BrowserWebSocketTransport";
import { RpcSocket } from "../modules/starter/generated/typescript/Core/Net/RpcSocket";
import { StarterClient } from "../modules/starter/generated/typescript/starter/protocol/clients";

/** 对全新测试进程发出两个真实 RPC；测试不连接既有服务。 / Send two real RPCs to a fresh test process, never to an existing service. */
export async function verify(port: number, signal?: AbortSignal): Promise<void> {
  await withClient(port, signal, async client => {
    const first = await client.increment({});
    const second = await client.increment({});
    assert.equal(first.count, 1);
    assert.equal(second.count, 2);
    console.log("[入门验收] 两次真实 RPC 返回 count=1、count=2；Handler → Component → System 已贯通。");
  });
}

/** 向已启动的教学服务发送一次递增请求；会修改临时计数状态。 / Send one increment to a running teaching service; this changes transient counter state. */
export async function request(port: number, signal?: AbortSignal): Promise<number> {
  return withClient(port, signal, async client => (await client.increment({})).count);
}

async function withClient<T>(port: number, signal: AbortSignal | undefined, action: (client: StarterClient) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new Error("教学请求已取消");
  const socket = new RpcSocket({ transport: "websocket", host: "127.0.0.1", port });
  const client = new StarterClient(socket);
  const pump = setInterval(() => socket.update(), 10);
  const cancel = () => { clearInterval(pump); socket.close(); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await socket.connect();
    if (signal?.aborted) throw new Error("教学请求已取消");
    return await action(client);
  } finally {
    signal?.removeEventListener("abort", cancel);
    clearInterval(pump);
    socket.close();
  }
}
