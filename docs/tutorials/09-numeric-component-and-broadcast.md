# NumericComponent、定时器与状态广播

本章用玩家生命值演示一条完整的业务开发链路：Rust 保存权威数据，TypeScript 组织 Component 和业务规则，生成协议负责把最新状态同步到客户端。

## 最终业务写法

创建玩家时挂载组件：

```ts
player.AddComponent(NumericComponent);
```

业务逻辑中读取和修改数值：

```ts
const numeric = player.GetComponent(NumericComponent);
const hp = numeric[NumericType.CurrentHp];
numeric[NumericType.CurrentHp] += 1;
```

这与 ET 的使用方式接近。TypeScript 没有 C# 自定义索引器，`NumericComponent` 在 `Awake` 中为生成的数值类型安装属性访问器，所以业务侧仍可使用 `numeric[type]`。

## 定义 Rust 权威数据

数值原型位于 `native_data/demo/Numeric.native`：

```text
namespace demo;

@typeId(3)
entity Numeric extends Entity {
  currentHp: i32 = 100;
  maxHp: i32 = 1000;
}
```

执行 `npm run codegen:native-data` 后，生成器会更新：

- Rust 实体结构、字段编号和通用读写分发；
- `NativeNumericRef` 句柄；
- `NativeNumericField.CurrentHp`、`NativeNumericField.MaxHp` 字段常量。

业务层的 `NumericType` 直接复用这些生成常量，不需要再手工维护一套编号。

## Component 生命周期

`NumericComponent.Awake` 创建 Rust Numeric 实体，并注册每 100ms 执行一次的重复定时器：

```ts
this.NewRepeatedTimer(100, (self) => {
  self[NumericType.CurrentHp] += 1;
});
```

因为组件挂在 `PlayerUnit` Actor 上，定时器回调会进入该 Actor 的 ordered mailbox，不会与这个玩家的其他消息重入。Unit 销毁时，框架自动移除组件定时器，`NumericComponent.OnDestroy` 同时释放 Rust 句柄。

## 修改后如何同步

索引写入按以下顺序执行：

1. 通过 fast op 修改 Rust 中的权威值；
2. 将 `NumericComponent` 标记为 dirty；
3. Map 的 20Hz `Update` 收集所有 dirty Numeric；
4. 一次编码 `G2C_EntityNumeric`，广播给当前地图全部玩家。

setter 不直接发送网络消息。否则一段业务连续修改多个数值时，会产生多个异步发送和中间状态；帧末收集可以把同一逻辑帧内的修改合并成最终状态。

## 可覆盖广播

协议通过注释声明 latest 广播：

```proto
// @ets.broadcast mode=latest item=UnitNumericSnapshot items=numerics key=unit_id tick=server_tick
message G2C_EntityNumeric // IMessage
{
  uint32 server_tick = 1;
  repeated UnitNumericSnapshot numerics = 2;
}
```

生成器会创建 `ClientBroadcasts.EntityNumeric`。当上一批仍在发送时，新批次按 `unit_id` 覆盖等待队列中的旧状态。因此客户端可能跳过中间 HP，但最终会收到最新 HP，适合位置、血量、蓝量等“状态”。

技能释放、获得道具、伤害飘字等不可丢失的“事件”应使用 `mode=event`，不能使用 latest。

## 客户端接收

Cocos 使用独立 Handler 接收生成的消息描述：

```ts
@clientMessageHandler(MapMessageScope, ClientMessages.EntityNumeric)
export class G2C_EntityNumericHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_EntityNumeric
> {
  handle(entities: MapEntityManager, message: G2C_EntityNumeric): void {
    entities.applyNumerics(message.numerics);
  }
}
```

客户端不依赖服务端的 `NumericComponent`，只依赖 SDK Core 和 generated 协议代码。Handler 由 codegen 自动导入，`MapEntityManager` 不负责网络注册。当前演示把 Numeric 广播给地图内所有玩家；接入 AOI 后，只需替换 Map 生成 `BroadcastAudience` 的方式，数值业务代码不变。

## 验证

```powershell
npm run test:native-data
npm run test:runtime
```

`test:native-data` 验证 Component 索引读写和 Rust 实体字段；`test:runtime` 验证玩家进入地图后，客户端能连续收到递增的 `CurrentHp`。
