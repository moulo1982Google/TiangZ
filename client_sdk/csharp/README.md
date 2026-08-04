# TiangZ C# Client SDK

`client_sdk/csharp` 是 Unity 和普通 .NET 客户端共用的 C# SDK 源码。它只依赖 .NET/Unity 能力，不依赖 `UnityEngine`。

## 生成

```bash
npm run codegen:csharp-client-sdk
```

Proto 会生成：

- `Generated/Demo/Protocol.cs`：消息结构、Codec、msgcode、RPC/Push 描述符和类型化 Client。
- `Core`：二进制协议、帧、WebSocket RPC、主线程 `Update()` 分发。
- `Demo/LoginFlow.cs`：LoginMgr -> Login -> Gate -> Map 的演示流程。

生成结果会复制到 `client_demo/Unity2022.3.62f3c1_demo/Assets/TiangZClient/Runtime`。Unity 表现代码只能调用生成的 Client 和 `RpcSocket.Update()`，不能手工写 msgcode 或 Codec。

当前 Unity Adapter 只支持 WebSocket；选择 TCP/KCP 必须由上层明确报错，不能静默降级。

## 最小调用

```csharp
var flow = new LoginFlow(new ClientEndpoint("127.0.0.1", 7000));
var game = await flow.EnterGameAsync("unity-demo", 100, cancellationToken);

// Unity MonoBehaviour.Update 中每帧调用；登录阶段的 LoginMgr、Login 和 Gate
// Socket 都由 LoginFlow.Update 泵送，Push 与 RPC 完成在 Unity 主线程处理。
flow.Update(256);
await game.Map.NavigateToAsync(new C2M_NavigateTo
{
    TargetX = 4f,
    TargetY = 0f,
    TargetZ = 6f,
    Sequence = 1,
}, cancellationToken);
```

Unity表现层可以使用`Vector3`、Transform和Camera，但协议仍使用米制`x/y/z/yaw`。不要修改`Generated`文件，也不要从网络接收线程操作Unity对象。
