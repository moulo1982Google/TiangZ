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

Gate 会话建立后，客户端 SDK 每 5 秒向当前 Gate 发送一次单向 `C2G_Ping`。Gate 只在成功处理该消息后刷新 Session 的存活时间；连续 30 秒没有 Ping 时，Gate 会请求 Rust Transport 主动关闭该 `connectionId`。

无论连接由客户端主动关闭、网络层断开，还是 Gate 心跳超时关闭，最终都统一进入：

```text
GateScene.onDisconnect
  -> G2M_PlayerDisconnect
  -> MapComponent.PlayerDisconnect
  -> 删除玩家 Unit 并广播 G2C_EntityLeave
```

退出按钮属于正常操作入口，但不能代替这条兜底链路。进程被强杀或网络中断时客户端无法发送关闭包，仍由 Gate 的 30 秒心跳超时完成清理。

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

通用 WebSocket SDK 全链路测试，需要先启动 `configs/local/all.json`：

```powershell
npm run smoke:client-sdk -- websocket 127.0.0.1 7000
```

Rust KCP 内核、重传和真实 UDP RPC：

```powershell
cargo test --features kcp --lib --bin TiangZ --bin kcp_smoke
```

Cocos Native 验收需要依次确认 LoginMgr、Login、Gate、MapReady，并在进入地图后保持 Gate 会话。只看到 Native 窗口启动不算 KCP 链路通过。
