# NumericComponent、脏数据与帧尾同步

本章演示两种并列的状态同步模型：Numeric 动态字典和 `.native` 固定字段脏掩码。Rust 保存权威数据，TypeScript 组织 Component 与业务规则，客户端 SDK 只接收类型明确的 Delta。

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

开发者在 `app/demo/numeric/NumericType.ts` 维护稳定的整数类型。`NumericComponent` 只保存 Unit 的 Native handle；真正的 `NumericType -> i32` 值表和 dirty 表都在 Rust。

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

`MapComponent.FrameFlush()` 不再扫描每个玩家的 `NumericComponent`。它只调用一次批量 Native op，由 Rust 收集 dirty 数值并直接编码：

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

## 固定字段脏掩码

字段集合稳定的结构体使用 `.native`：

```native
@typeId(2)
@replicated
entity Item extends Entity {
  readonly configId: u32;
  @memberId(1)
  count: u32 = 1;
  @memberId(2)
  quality: u32 = 0;
  @memberId(3)
  level: u32 = 1;
}
```

执行 `npm run codegen:native-data` 后会生成：

- Rust 结构体中的 `u64` dirty mask；
- `ITEM_MEMBER_*` 与 TypeScript `NativeItemMember` 常量；
- 仅在值实际变化时置位的 setter；
- `item_dirty_mask` 和 `take_item_dirty_mask`。

`memberId` 是稳定的数据契约，范围为 1..63，不应因字段换序而改变。未标记字段不会进入脏掩码；需要立即通知的状态由业务显式发送普通 Message，需要保证顺序且不可覆盖的事实使用 Event。

## Snapshot、Delta、Event

- **Snapshot**：创建、进入、重连或主动全量同步时发送完整当前状态。
- **Delta**：帧尾发送 dirty 字典或 dirty mask 中的最终值，可以按稳定键覆盖。
- **Event**：技能释放、获得道具、伤害飘字等事实，必须有序保留，不能使用 latest。

三者不要共用一个 `value: unknown` 容器。Numeric Delta 使用 `i32 value`；固定结构由 codegen 生成 `ItemDelta` 之类的强类型 Rust 数据，协议适配层再明确选择对应 protobuf 字段。

## 验证

```powershell
npm run test:native-data
npm run test:map-broadcast
npm run test:runtime
npm run perf:dirty-replication
```

`perf:dirty-replication` 是本地数据结构微基准，只比较“5 个字段中修改 3 个”时动态 dirty map 与固定 dirty mask 的更新、收集和确认成本，不代表网络全链路吞吐。
