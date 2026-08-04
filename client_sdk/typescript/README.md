# TypeScript Client SDK

这个目录是 TypeScript 客户端 SDK 的唯一源码。Cocos Web、PixiJS/H5 与 Cocos Native 都消费它的生成副本，不在各客户端工程内维护另一套网络框架。

## 目录职责

```text
Core/                 引擎无关的帧、RPC、Push、队列、错误和 Transport 接口
Demo/                 可复用的 Demo 登录到进图流程
Generated/Model/      根据 proto 自动生成的消息、描述符和强类型 Client
Generated/ProtocolFingerprint.ts
                      当前协议模型指纹
index.ts              SDK 公共入口
```

`Core` 不得依赖 `cc`、`pixi.js` 或 DOM。平台能力通过 Transport Adapter 注册：

- 浏览器入口导入 `Core/Net/BrowserWebSocketTransport`；
- Cocos Native 入口导入 `Core/Net/NativeTransport`；
- 平台不支持所选协议时立即抛出 `UnsupportedTransportError`，不会静默降级。

## 生成与使用

修改 `proto/` 后，在项目根目录执行：

```powershell
npm run codegen
```

生成器会更新协议代码和指纹，再把完整 SDK 分发到：

```text
client_demo/cocos_client2D_3.8.6/assets/scripts/Generated/SDK/
client_demo/pixi_client_8.19.0/src/Generated/SDK/
```

业务 RPC 使用生成的强类型 Client，不手写 msgcode、编解码或 rpcId：

```ts
const gate = new GateClient(socket);
const response = await gate.enterMap({ mapId: 1 });
```

服务端 Push 使用 `@clientMessageHandler` 定义独立 Handler，并由生成的 `Generated/Hotfix/handlers.ts` 自动导入。游戏主循环每帧调用 `LoginFlow.update()` 或 `RpcSocket.update()`，网络回调只入队，不直接重入游戏业务。

## 验收

```powershell
npm run test:client-sdk
npm run test:client-sdk-distribution
npm run typecheck:cocos-demo
npm run typecheck:pixi
```
