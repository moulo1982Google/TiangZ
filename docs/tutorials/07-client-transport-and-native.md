# 客户端传输协议与 Cocos Native

## 一套 RPC，三种传输

客户端 RPC 与 protobuf 不直接依赖 WebSocket、TCP 或 KCP。`RpcSocket` 只依赖 `ClientTransport`，创建连接时通过 `ClientEndpoint.transport` 选择协议：

```ts
const endpoint = {
  transport: "kcp" as const,
  host: "127.0.0.1",
  port: 7000,
};
```

登录链路切换 LoginMgr、Login、Gate 地址时会保留 `transport`，只替换 host 和 port。因此业务代码不需要为三种协议各写一套 Handler。

| 平台 | WebSocket | TCP | KCP |
|---|---:|---:|---:|
| Cocos Web / H5 | 支持 | 不支持 | 不支持 |
| Cocos Native Windows | 支持 | 支持 | 支持 |
| Node SDK smoke | 支持 | 未注册 Adapter | 未注册 Adapter |

平台没有注册对应 Adapter 时，`createClientTransport()` 会立即抛出 `UnsupportedTransportError`，不会尝试降级到其他协议。例如 Cocos Web 选择 KCP 会在创建连接时直接报错。

## 服务端 KCP

KCP 由 Cargo feature 控制，外网示例配置为 `configs/experiments/all.kcp-native.json`：

```powershell
cargo run --features kcp --bin TiangZ -- configs/experiments/all.kcp-native.json
```

当前 LoginMgr、Login 和 Gate 使用 Outer KCP 参数：MTU 470、收发窗口 256、`nodelay(1,10,2,1)`、最小 RTO 30ms。MapHost 和 Log 仍走内部 TCP。Inner KCP 尚未接入内部身份认证，因此配置 `protocol=kcp,audience=inner` 会明确启动失败。

## Gate 心跳与掉线清理

Gate会话建立后，客户端SDK每5秒向当前Gate调用一次`C2G_Ping -> G2C_Ping`。`G2C_Ping.serverTime`是Gate生成响应时的Unix毫秒，可用于观测服务器时间，但SDK不会把它当成本地游戏Tick。Gate收到任意客户端帧都会刷新`GatePlayerRoute.lastReceiveTime`，因此活跃玩家不依赖Ping续期；出站排队只更新`lastSendTime`，不能让已经失联的客户端继续存活。Gate用一个1秒合并扫描器检查全部Route，不为每名玩家创建Timer。

客户端主动关闭或网络层断开时，只销毁当前`GateSession`并让Route进入30秒重连宽限。新连接仍进入同一个Gate，通过账号找到Route并替换connectionId，然后调用原PlayerUnit的`SecondEnterMap`恢复全量视图。旧连接迟到的close事件不会影响新连接。

只有宽限期结束或连续30秒没有任何入站消息，Gate才发起最终下线：

```text
GateScene.SweepClientTimeouts
  -> MapProtocol.PlayerOffline
  -> Map保存玩家、删除Unit并广播G2C_EntityLeave
  -> Gate删除GatePlayerRoute
```

退出按钮属于正常操作入口，但不能代替这条兜底链路。Map不维护连接超时，不保存GateSessionId；它只执行Gate确认后的最终下线业务。

## Cocos Native Windows

Native Adapter 位于：

- `assets/scripts/Core/Net/NativeTransport.ts`：TypeScript Transport Adapter；
- `native/engine/common/Classes/NativeTransport.cpp`：WinSock TCP、UDP/KCP 与 JSB Bridge；
- `native/engine/common/Classes/NativeTransport.h`：注册与退出接口。

`GameBootstrap.transport` 在 Native 默认使用 `kcp`，在 Web 默认使用 `websocket`。可在 Cocos Inspector 或代码中改成 `tcp`、`websocket`、`kcp`。

使用 Cocos Creator 3.8.6 构建 Windows Debug 包后，编译 Native 工程：

```powershell
E:\cocos_editer\Creator\3.8.6\resources\tools\cmake\bin\cmake.exe `
  --build cocos_client2D\build\tiangz-kcp-native\proj `
  --config Debug --parallel 8
```

Cocos 3.8.6 自带的 Windows Debug CRT 可能是 MSVC 14.29，而本机编译器是 14.44。混用后会在 `BaseGame::init()` 内以 `0xC0000005` 崩溃。项目的 Windows CMake 已在链接后从当前 MSVC Toolset 自动复制匹配的 Debug CRT，不需要手工替换 DLL。

## 验收

Transport 选择和不支持平台测试：

```powershell
npm run test:client-transport
```

通用 WebSocket SDK 全链路测试，需要先启动 `configs/local/all-in-one.json`：

```powershell
npm run smoke:client-sdk -- websocket 127.0.0.1 7000
```

Rust KCP 内核、重传和真实 UDP RPC：

```powershell
cargo test --features kcp --lib --bin TiangZ --bin kcp_smoke
```

Cocos Native 验收需要依次确认 LoginMgr、Login、Gate、MapReady，并在进入地图后保持 Gate 会话。只看到 Native 窗口启动不算 KCP 链路通过。
