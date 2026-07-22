# TypeScript Client SDK 计划

## 目标

从 Cocos 工程中抽离与引擎无关的 TypeScript Client SDK。SDK 负责协议编解码、RPC 多路复用、单向消息、服务端 Push、超时、断线处理和消息队列；具体游戏引擎只负责生命周期和表现层接入。

生成器先建立语言无关的协议模型，再由 TypeScript emitter 输出 SDK。当前不实现 C#、C++ 和 Go，但保留增加其他语言 emitter 的结构边界。

## SDK v1 验收矩阵

| 客户端 | 运行环境 | 验收重点 |
| --- | --- | --- |
| Cocos Web | 浏览器 | 现有登录、进图、移动和 Push 链路全部改用 SDK |
| PixiJS/H5 | 浏览器 | 同一 SDK 在非 Cocos 引擎中完成相同多人地图链路 |
| Cocos Native Windows x64 | Windows 原生平台 | Windows x64 构建可运行，TCP/KCP、二进制帧、RPC 和 Push 可用 |

SDK Core 不得依赖 `cc`、`pixi.js`、DOM 或具体平台全局变量。Cocos Web 与 PixiJS/H5 共用 Browser Transport；Cocos Native Windows x64 如有运行时差异，通过独立 Transport Adapter 处理。

当前 SDK 通过 `ClientEndpoint.transport` 选择 `websocket`、`tcp` 或 `kcp`。协议能力由平台 Adapter 注册，不允许静默降级：Cocos Web/PixiJS 选择 TCP 或 KCP 会立即抛出 `UnsupportedTransportError`；Cocos Native Windows 注册 TCP/KCP JSB Adapter。登录过程中 LoginMgr 返回 Login、Login 返回 Gate 地址时只替换 host/port，transport 选择保持不变。

当前验收结果：

- Cocos Native Windows KCP：LoginMgr -> Login -> Gate -> MapReady 已通过；
- Cocos Native Windows TCP：同一业务链路已通过；
- 通用 WebSocket SDK：`npm run smoke:client-sdk -- websocket 127.0.0.1 7000` 已通过；
- 不支持协议：`npm run test:client-transport` 验证 TCP/KCP 在无 Native Adapter 环境立即失败。

Android、iOS、macOS 等 Native 平台以后分别作为独立验收项加入，不能用 Windows x64 的通过结果代替其他操作系统验收。

## SDK v2 候选验收矩阵

| 客户端 | 前置条件 | 验收重点 |
| --- | --- | --- |
| 微信小游戏 | 开发者账号、小游戏 AppID、开发者工具和真机 | 微信 Socket Adapter、前后台切换、弱网重连和真机 Push |
| 抖音小游戏 | 开发者账号、小游戏 AppID、开发者工具和真机 | 抖音 Socket Adapter、前后台切换、弱网重连和真机 Push |

小游戏可以先做静态构建和 Adapter 单元测试，但在没有平台账号、AppID 和真机验证时，不计为运行验收通过。

## 通用性规则

- Cocos、PixiJS 和后续小游戏必须消费同一版本、同一协议指纹的 SDK 产物。
- SDK 通过 Transport 接口隔离 `WebSocket`、`wx.connectSocket`、`tt.connectSocket` 等平台差异。
- SDK 通过手动 `update(maxMessages)` 模式把网络回调与游戏业务分开，游戏引擎负责在主循环调用。
- 平台登录、支付、广告、分享和存储不属于网络 SDK。
- 每个正式支持的平台必须具备构建测试、连接测试、RPC 测试、Push 测试、断线测试和未知消息测试。
