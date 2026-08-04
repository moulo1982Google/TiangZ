# cocos_client2D

这是 TiangZ 的 Cocos 2D 客户端演示工程，也是 TypeScript Client SDK 的 Cocos Web 与 Cocos Native Windows 验收端。

## 启动服务器

在 `ets_runtime/` 目录执行：

```bash
npm run build
cargo run -- configs/local/all-in-one.json
```

同一个 Service 端口同时支持：

- 供 Node/服务端工具使用的 Raw TCP length-prefix 消息帧。
- 供 Cocos/浏览器预览使用的 WebSocket 二进制消息帧。

WebSocket 客户端的二进制消息格式为：

```text
[msgcode:u16 big-endian][protobuf payload]
```

WebSocket 本身已经保留消息边界，所以消息内部不再包含 length-prefix。

## 启动 Cocos

使用 Cocos Creator 3.8.x 打开本目录。

工程已经包含场景：

```text
assets/scene/main.scene
```

`Demo/GameBootstrap.ts` 已经挂载到场景的 `Canvas` 节点。

1. 打开 `assets/scene/main.scene`。
2. 点击 Preview。

组件会在运行时创建界面并执行以下流程：

```text
LoginMgr -> LoginService -> GateService -> MapService -> 地图视图
```

登录响应会返回 GateService 地址。客户端随后连接 GateService，依次发送 `C2G_LoginGate` 和 `C2G_EnterMap`，最后根据 `G2C_EnterMap` 渲染地图。

`RpcSocket` 使用 protobuf payload 中的 `rpcId` 关联请求和响应，支持多个并发 RPC；无法匹配到 pending RPC 的服务端推送会交给对应的 `msgcode` 通知 Handler。

## 代码目录

```text
../client_sdk/typescript/              SDK 唯一源码
assets/scripts/Generated/SDK/          codegen 分发的完整 SDK，禁止手工修改
assets/scripts/Generated/Hotfix/       客户端 Handler 自动导入入口
assets/scripts/Demo/                   Cocos 地图、输入和界面演示业务
```

在项目根目录执行 `npm run codegen`，会根据 `proto/` 更新公共 SDK，再生成 Cocos 使用的完整副本。客户端不维护私有协议 Core，也不手写 `DemoProtocol.ts`。

进入地图时，客户端会同时等待 EnterMap RPC 响应和服务端主动推送的 `MapReady` Message。进入后可使用 `WASD` 或方向键发送方向输入。客户端不会直接修改权威坐标，MapHost 会把消息按 InstanceId 直达 PlayerUnit mailbox，由 PlayerUnit 按服务端时间计算位置，并经 Gate 推送 `G2C_EntityMove`；本地玩家方块对收到的权威坐标做平滑插值。

`EnterMap` 响应携带当前地图实体快照。客户端通过 `MapEntityManager` 创建本地和远端 Unit，并继续消费 `EntityEnter`、`EntityMove` 和 `EntityLeave`。本地 Unit 显示为黄色，远端 Unit 显示为蓝色；两个浏览器页面进入同一地图后可以看到彼此移动和离开。

命令行构建 Web Desktop：

```powershell
$env:ELECTRON_RUN_AS_NODE=$null
& "E:\cocos_editer\Creator\3.8.6\CocosCreator.exe" --project "$PWD\client_demo\cocos_client2D_3.8.6" --build "platform=web-desktop;debug=true"
```

构建产物位于 `build/web-desktop/`。

默认 LoginMgr 地址：

```text
ws://127.0.0.1:7000
```

如果服务器运行在其他地址，可以在 `GameBootstrap` 组件属性中修改该 URL。
