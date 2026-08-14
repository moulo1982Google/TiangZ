# 5分钟跑通 TiangZ

这条路径只验证“能启动、能登录、能看到一个正式 RPC Handler”。它不要求先读完整架构文档，也不要求修改 Rust Runtime。

## 1. 启动 Starter

在仓库根目录执行：

```powershell
npm install
npm run hello
```

`hello` 会依次完成 Debug 产物构建、启动 `configs/local/all-in-one.json`，并等待 `LoginMgr` 的 `127.0.0.1:7000` 监听成功。看到下面这类输出后再打开客户端：

```text
[hello] Starter 已就绪。
[hello] 登录入口：ws://127.0.0.1:7000
```

按 `Ctrl+C` 会停止本次命令启动的进程。

## 2. 先看一个完整 Handler

打开 [C2G_PingHandler.ts](../../app/hotfix/mmorpg/gate/handlers/C2G_PingHandler.ts)。它是一个 Gate Session RPC：

```ts
@sessionRpcHandler(GateScene, GateProtocol.Ping)
export class C2G_PingHandler implements SessionRpcHandler<
  GateScene,
  GateSession,
  C2G_Ping,
  G2C_Ping
> {
  handle(scene: GateScene, session: GateSession): G2C_Ping {
    return scene.Ping(session);
  }
}
```

这里的职责很窄：装饰器把协议绑定到 Handler，Handler 从 `Session` 取得当前连接，把业务调用交给 `GateScene`。不要在 Handler 中遍历地图、保存模块级状态或直接操作 Rust 内部对象。

## 3. 客户端发起同一个 RPC

协议生成后，客户端使用类型化 Client，不自己填写 `msgcode` 或 `rpcId`：

```ts
// GateClient 来自 client_sdk/typescript/Generated 的生成 SDK；socket 已按 SDK README 建立。
const gateClient = new GateClient(socket);
const response = await gateClient.ping({});
console.log(response.serverTime);
```

`GateClient` 和 `gateClient.ping` 来自 [生成的 clients.ts](../../client_sdk/typescript/Generated/Model/demo/protocol/clients.ts)，连接建立方式见 [TypeScript SDK 说明](../../client_sdk/typescript/README.md)。生成文件禁止手改；协议或 Handler 变化后使用：

```powershell
npm run codegen
npm run typecheck
```

## 4. 新增自己的 RPC 时改哪里

以现有 Demo 作为模板，按这个顺序：

1. 在 `proto/` 的业务协议源文件中增加请求、响应和 RPC 描述。
2. 执行 `npm run codegen`，让服务端、TypeScript SDK 和各客户端副本一起更新。
3. 在 `app/hotfix/<domain>/.../handlers/` 新增 Handler，只依赖 `#tiangz/model` 的稳定入口。
4. 把真正的状态变化放到 Model 的 Scene、Actor 或 Component 方法中，Handler 只做参数入口和业务胶水。
5. 用 `npm run verify:fast` 做日常快速检查；合并前再运行完整 `npm run verify:quick`。

如果只是修改现有 Hotfix Handler，通常不需要重新设计 Model；如果要新增稳定字段、协议类型或 Component 状态，先按 [业务开发手册](../ai/business-development-manual.md) 判断它是否属于不可热更的 Model。

## 5. 下一步阅读

- [架构与快速启动](01-architecture-and-quickstart.md)：Process、Scene、Actor、Component 的边界。
- [业务开发手册](../ai/business-development-manual.md)：状态归属、Handler 规则和生成命令。
- [能力归属表](../design/capability-ownership.md)：MMORPG 特化与可复用领域能力的放置位置。
