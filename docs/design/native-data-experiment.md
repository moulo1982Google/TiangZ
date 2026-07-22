# Rust Unit 数据下沉实验

## 目标

这项实验只回答两个问题：把地图高频、规则稳定的数据放进 Rust 后，性能能提升多少；为此增加的生成代码、句柄和调试成本是否值得。它不是“把所有业务状态搬到 Rust”的架构承诺。

当前 A/B 路径保持同一个 `C2M_MoveHandler`、PlayerUnit mailbox 和广播协议：

```text
C2M_MoveHandler
  -> PlayerUnit.Move()
  -> MovementComponent.SetInput() / NativeUnitRef.SetMovementInput()
  -> typescript: TS 状态
  -> rust: NativeUnitRef(handle) -> fast op

MapComponent.Update() / 20Hz
  -> typescript: 逐 Unit 更新 TS PositionComponent
  -> rust: 每张地图一次 NativeData.FixedUpdateMap()
  -> 紧凑移动快照批次
  -> TS 做收件人分组和现有 protobuf 广播
```

因此目前测到的是“Unit 状态与固定帧计算下沉”的收益，尚未包含 Rust 直接 protobuf 编码和直接下行广播。后者要在这一阶段证明值得后再做。

## 原型与生成代码

- 原型：`native_data/demo/Unit.native`
- 生成器：`tools/codegen_native_data.mjs`
- Rust 输出：`src/generated/native_data.rs`
- TS 输出：`app/generated/model/native/NativeUnitRef.ts`

执行 `npm run codegen:native-data` 重新生成。`npm run codegen` 和正式构建已经包含这一步，Generated 文件不要手改。

Rust 没有类继承。生成的 `UnitData` 通过组合持有 `EntityData`；TS 的 `NativeUnitRef` 是绑定在 PlayerUnit 上的 Component，只持有一个带 generation 的 `u32` handle。组件销毁会释放槽位，旧 handle 再访问会明确报错。

## Bridge 约束

当前没有暴露 `GetX/GetY/SetPosition` 这类逐字段 API。低频调试读取使用一次 `UnitSnapshot`，地图固定帧使用一次 `FixedUpdateMap` 批量返回 `MovementFrame[]`。这样约束直接体现在 API 形状里，业务 Update 无法无意间写出逐玩家、逐字段跨 V8/Rust 的热路径。

NativeData、移动类型和配置解释都属于 Demo，不由 Core runtime 导出。Core 只负责运行进程、Scene、Entity/Component、mailbox 和传输，不认识 Unit 下沉实验。

Rust 每 5 秒输出：

```text
[native-data-metrics] process=map1 scalar_gets=... scalar_sets=... batch_calls=... live_units=...
```

- `scalar_gets/scalar_sets`：采样窗口内点状访问次数。
- `batch_calls`：地图批量固定帧调用次数。
- `live_units`：当前 Rust Arena 中存活 Unit 数，用于发现生命周期泄漏。

## 启动与 A/B

默认 TS：

```powershell
cargo run --bin TiangZ -- configs/local/all.json
```

Rust Unit 数据：

```powershell
cargo run --bin TiangZ -- configs/local/all.rust-data.json
```

容量测试支持同一参数只切换数据后端：

```powershell
npm run perf:map-capacity -- --players 150 --gates 4 --move-rate 5 --duration 30 --warmup 10 --rounds 3 --native-data-backend typescript
npm run perf:map-capacity -- --players 150 --gates 4 --move-rate 5 --duration 30 --warmup 10 --rounds 3 --native-data-backend rust
```

比较时应关注 Map CPU、移动 p95/p99、move/s、push/s、V8 GC、RSS 和 NativeData 标量访问数，不能只看单次峰值。

TS/Rust 状态机一致性由 `native_data/movement_parity.json` 约束。修改 Tick 或移动规则后，应同时运行：

```powershell
npm run test:movement-parity
```
