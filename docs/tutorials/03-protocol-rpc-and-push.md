# protobuf、RPC、Message 与 Push

## 学习目标

能定义 RPC、单向消息和服务端 Push，并理解生成文件与业务 Handler 的关系。

## Proto 分类

```text
*_C_<start>.proto   客户端可见，生成 client + server
*_S_<start>.proto   服务端内部，只生成 server
*_CS_<start>.proto  两端共用的数据结构，生成 client + server
```

普通结构体只有字段和 Codec，不分配 MsgCode。带 `IRequest/IResponse/IMessage` 等框架基类的消息才参与通信。`rpcId` 位于 protobuf payload 的字段 90，不在帧头中。

## 定义 RPC

```proto
//ResponseType S2C_QueryTime
// @ets.msg protocol=Clock method=QueryTime
message C2S_QueryTime // IRequest
{
}

message S2C_QueryTime // IResponse
{
  uint32 unix_seconds = 1;
}
```

执行 `npm run codegen` 后，使用生成的 `ClockProtocol.QueryTime`：

```ts
@rpc(ClockProtocol.QueryTime)
private queryTime(_request: C2S_QueryTime): S2C_QueryTime {
  return { unixSeconds: Math.floor(Date.now() / 1000) };
}
```

同步 Handler 返回对象；需要 IO 时可以返回 `Promise<S2C_QueryTime>`。框架负责解码、绑定 Handler、复制 `rpcId`、编码 Response 和转换 `RpcError`。

## 单向 Message

```proto
// @ets.msg protocol=Gate method=Heartbeat
message C2G_Heartbeat // IMessage
{
  uint32 sequence = 1;
}
```

服务端：

```ts
@message(GateMessages.Heartbeat)
private heartbeat(message: C2G_Heartbeat): void {
  console.log(message.sequence);
}
```

Message 没有 Response。Handler 不存在或抛错时只能记录日志，不能凭空向客户端返回一个它没有订阅的 ErrorResponse。

## Server Push

`RpcSocket.on` 是 SDK 提供的底层订阅能力，适合一次性等待、工具代码或非常小的功能：

```ts
const unsubscribe = socket.on(ClientMessages.EntityMove, (message) => {
  console.log(message.unitId, message.x, message.y);
});

unsubscribe();
```

正式游戏业务不要把大量 `socket.on` 堆在 View、Manager 或 Component 的构造函数中。客户端使用与服务端一致的独立 Handler：

```ts
@clientMessageHandler(MapMessageScope, ClientMessages.EntityMove)
export class G2C_EntityMoveHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_EntityMove
> {
  handle(entities: MapEntityManager, message: G2C_EntityMove): void {
    entities.applyMovement(message);
  }
}
```

Handler 文件放在客户端 `Demo/**/Handlers` 下。执行 `npm run codegen` 后，`Generated/Hotfix/handlers.ts` 自动导入这些模块，不维护手写总表。进入地图时创建作用域 Dispatcher：

```ts
const messages = new ClientMessageDispatcher(
  gateSocket,
  MapMessageScope,
  entities,
);
```

退出地图调用 `messages.dispose()`，这一作用域的订阅会一次性释放。SDK Core 不依赖 Cocos，因此同一套 Handler 注册和分发机制可供 PixiJS/H5 使用；具体 Context 和表现实现仍属于各客户端业务。

## Codec 为什么存在

TypeScript `interface` 编译为 JavaScript 后会消失，因此运行时不知道字段号和 wire type。生成的 `XxxCodec` 是专用序列化器，业务代码不应直接调用；RPC/Message Descriptor 会替业务选择 Codec。

## 常见错误与练习

- 修改生成文件：下次 codegen 会覆盖，应修改 proto。
- 手填 MsgCode：消息号由文件起点和定义顺序生成。
- RPC Response 不匹配：检查 `ResponseType`。
- 练习：新增一个 S2C `ServerNotice` Push，创建独立客户端 Handler，并确认退出对应作用域后不再处理消息。
