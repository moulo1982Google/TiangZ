# NumericComponent、脏数据与帧尾同步

本章演示三种并列语义：Numeric 动态字典、Player 固定字段脏掩码，以及 Item 不可覆盖的即时事件。Rust 保存权威数据，TypeScript 组织 Component 与业务规则，客户端 SDK 只接收类型明确的 Snapshot、Delta 或 Event。

## Numeric 的业务写法

玩家创建时挂组件：

```ts
player.AddComponent(NumericComponent);
```

业务代码保持 ET 风格：

```ts
const numeric = player.GetComponent(NumericComponent);
const hp = numeric[NumericType.CurrentHp];
numeric[NumericType.CurrentHp] += 1;
```

开发者在`app/model/demo/numeric/NumericType.ts`维护稳定的整数类型。`NumericComponent`只保存Unit的Native handle；真正的`NumericType -> i32`值表和dirty表都在Rust。新增NumericType会改变Model，必须完整构建并重启Process。

当前演示每 100ms 增加一次生命值：

```ts
this.NewRepeatedTimer(100, (self) => {
  self[NumericType.CurrentHp] += 1;
});
```

Unit 销毁时，组件定时器自动取消，Native Numeric 也从该 Unit 解绑。

## 帧尾 Delta

一帧严格按以下顺序执行：

1. `Update()`：普通游戏逻辑和移动模拟；
2. `LateUpdate()`：依赖普通更新结果的后处理；
3. `FrameFlush()`：统一提取并发布可覆盖状态。

`MapComponent.FrameFlush()` 委托 Core `StateReplicationSystem`。每个复制来源只声明 `Peek()` 和成功后的 `Ack()`；Rust 收集 dirty 数值并直接编码：

```proto
message UnitNumericDelta
{
  uint32 unit_id = 1;
  uint32 numeric_type = 2;
  sint32 value = 3;
}

// @ets.broadcast mode=latest item=UnitNumericDelta items=numerics key=unit_id,numeric_type tick=server_tick
message G2C_EntityNumeric // IMessage
{
  uint32 server_tick = 1;
  repeated UnitNumericDelta numerics = 2;
}
```

可覆盖键是 `(unitId, numericType)`。同一玩家的 HP 新值可以覆盖旧 HP，但不会覆盖该玩家同帧的 MaxHp。

## Peek 与 Ack

提取脏数据不是立即清空：

1. Rust `PeekMapNumericDelta` 返回累计最新值、protobuf 帧和 revision；
2. `BroadcastHub` 保证同一广播通道 single-flight，并可替换尚未发送的旧状态；
3. 发送成功后调用 `AckMapNumericDelta(revision)`；
4. 发送失败时不确认，dirty 状态保留到下一帧重试。

这样既允许状态覆盖，也不会因为异步发送失败而永久丢失最后一次变更。

## 客户端使用

Cocos 与 Pixi 的 Handler 都只负责把 `message.numerics` 交给地图实体管理器。客户端按 Unit 保存 `numericType -> value` 表，每个 Delta 只更新一个键。新增 NumericType 不需要扩大 Handler，也不需要给协议增加一个固定字段。

## Player 固定字段脏掩码

字段集合稳定的 Player 状态使用 `.native`：

```native
@typeId(1)
@component
@replicated
entity Unit extends Entity {
  readonly mapId: u32;
  @memberId(1)
  x: f32 = 0;
  @memberId(2)
  y: f32 = 0;
  @memberId(3)
  speedCellsPerSecond: f32 = 10;
  @memberId(4)
  alive: u32 = 1;
}
```

执行 `npm run codegen:native-data` 后会生成：

- Rust 结构体中的 `u64` dirty mask；
- `UNIT_MEMBER_*` 与 TypeScript `NativeUnitMember` 常量；
- 仅在值实际变化时置位的 setter；
- 强类型 `UnitDelta`、`peek_unit_delta` 和 `ack_unit_delta`。

`memberId` 是稳定的数据契约，范围为 1..63，不应因字段换序而改变。每个字段记录最后修改 revision；旧 Delta 发送成功后的 Ack 不会清除发送期间产生的新修改。高频普通移动继续使用专用 Cell Movement Snapshot；显式传送、速度和存活状态等字段修改使用通用固定字段 Delta。

## Item 即时事件

库存变化不能使用 latest 合并。连续使用两次道具是两个有序事实，必须都被处理。演示链路为：

```text
C2M_UseItem
-> ItemComponent.UseItem()
-> 修改 Rust NativeItemRef
-> G2C_ItemChanged event
-> M2C_UseItem response
```

默认道具是速度药水。Cocos/Pixi 按 `U` 后，Item 数量通过可靠 Event 立即下发；速度字段自动置脏，在当前逻辑帧末通过 `G2C_EntityState` 合并广播。Item 的 `version` 让客户端忽略迟到的旧库存状态。

## Snapshot、Delta、Event

- **Snapshot**：进入、重连或主动全量同步时发送完整当前状态，不修改 Dirty。`G2C_EnterMap.entities/items` 是当前演示入口。
- **Delta**：帧尾发送 dirty 字典或 dirty mask 中的最终值，可以按稳定键覆盖。
- **Event**：技能释放、获得道具、伤害飘字等事实，必须有序保留，不能使用 latest。

三者不要共用一个 `value: unknown` 容器。Numeric Delta 使用 `i32 value`；固定结构由 codegen 生成强类型 `UnitDelta`；Item Event 使用强类型 `ItemSnapshot`。进入玩家不再通过 `MarkAllDirty` 伪造全量同步。

## 验证

```powershell
npm run test:native-data
npm run test:map-broadcast
npm run test:runtime
npm run perf:dirty-replication
```

也可以使用语义更明确的同义命令，并调整测试规模：

```bash
npm run perf:state-sync -- --entities 1000 --warmup-ms 500 --duration-ms 2000
```

该基准比较三条 Rust 本地热路径：Numeric 动态字典的修改、脏收集、批量 protobuf 编码与 Ack；Player 固定字段的 Dirty Mask、批量编码与字段级 Ack；Item 修改后立即独立编码 Event。输出包含 `changes/s`、`items/s`、`frames/s`、`MiB/s`、`B/item` 和 `ns/item`。

它不包含 V8 FastOp、`BroadcastHub`、Gate、Socket 和客户端解码，因此用于判断数据结构及编码方式的相对成本，不代表网络全链路吞吐。

## 全链路性能测试

完整链路使用 Rust 虚拟客户端，覆盖客户端 -> Gate -> MapHost Handler -> Rust NativeData -> protobuf -> Gate -> 客户端：

```bash
npm run perf:state-sync-full -- \
  --players 500,1000,2000 \
  --gates 12 \
  --warmup 10 \
  --duration 20
```

默认使用 `mixed` 模式，以每玩家 5Hz 轮流触发 Numeric、PlayerInfo 和 Item。也可以直接调用容量脚本分别测试：

```bash
node perf/map_capacity/run_map_capacity_perf.mjs \
  --client rust --skip-rust-build \
  --players 500,1000,2000 --gates 12 \
  --move-rate 0 --probe-rate 1 \
  --state-sync-mode player --state-sync-rate 5 \
  --warmup 10 --duration 20
```

`--state-sync-mode` 支持 `numeric`、`player`、`item` 和 `mixed`。Numeric 演示本身已有 100ms 定时器，单测定时同步时使用 `--state-sync-rate 0`，避免额外 RPC 修改数值。

报告中的状态下行同时给出三种口径：

- `frames/s`：所有虚拟客户端合计收到的协议帧数，反映拆包和 Socket 调度频率；
- `items/s`：解码前扫描 protobuf repeated 字段得到的状态项数，反映真实扇出量；
- `MiB/s`：所有虚拟客户端实际收到的消息体字节数，不包含 TCP length prefix。

全地图可见时，Numeric 和 PlayerInfo 的 `items/s` 会随玩家数近似 O(N²) 增长；这是当前无 AOI 的最坏同屏模型。ItemChanged 只发给所属玩家，所以 `frames/s = items/s = 触发 RPC/s`，近似 O(N)。
