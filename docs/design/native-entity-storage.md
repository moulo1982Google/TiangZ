# Rust 权威实体数据

## 当前模型

跨帧的 Entity/Component 数值状态以 Rust Arena 为权威，TypeScript 只保存 generation handle。Handler、Actor mailbox、Scene、组件组合和业务流程仍在 TypeScript：

```text
C2M_MoveHandler
  -> PlayerUnit.Move()
  -> NativeData.SetMovementInput(handle)
  -> Rust UnitData

MapComponent.Update() / 20Hz
  -> NativeData.UpdateMapMovement(mapId)
  -> Rust 更新地图内 Unit
  -> Rust 直接编码 G2C_EntityMove protobuf frame
  -> TS 选择 Audience，并由 BroadcastHub 负责覆盖、背压和 Gate 路由
```

运行时只有这一条正式路径，不再提供 TypeScript 数据镜像、数据后端切换或全量快照 A/B 开关。

## 原型与生成边界

- 原型：`native_data/**/*.native`
- 生成器：`tools/codegen_native_data.mjs`
- 语言与生成核心：`@tiangz/native-language-core` 及其 `/codegen` 子路径，固定到独立仓库的版本 Tag
- Rust 输出：`src/generated/native_data.rs`
- Native op 输出：`src/generated/native_ops.rs`、`src/generated/native_ops_bootstrap.js`
- TS 输出：`app/generated/model/native/NativeOps.ts`、`Native*Ref.ts`

执行 `npm run codegen:native-data` 重新生成。Generated 文件不要手改。

`.native` 的 Lexer、Parser、AST、语义校验和 Rust/TS 模板不再由主工程维护。它们来自独立的 [tiangz-native-language](https://gitee.com/eblard_admin/tiangz-native-language) 仓库。主工程生成器只扫描源码、校验输出路径、写文件并执行 `rustfmt`。升级语言版本时必须显式修改 `package.json` 中的 Tag，并重新执行完整 codegen 回归。

字段继承顺序、字段编号、生成名称与 Component 生命周期来自共享 Entity API 投影。VS Code Hover 和 codegen-core 共用这份投影，禁止在主工程生成器或插件中重新实现规则。

生成器认识 Entity、继承、字段、`@typeId`、`@component` 和 Native op 签名。`NativeUnitRef` 与 `NativeItemRef` 都通过生成的 `NativeOps` 创建、销毁和访问数值字段。移动输入、地图批处理与 protobuf 投影算法仍属于业务，放在 `app/demo/native/NativeData.ts` 和 Rust `native_data.rs`；但它们的 Extension 注册、Host bootstrap 和 TS facade 由 `native_data/NativeOps.native` 生成。

新增粗粒度 op 时，只声明 ABI 并实现 Rust 函数。`host.rs` 不维护 Native op 列表，也不安装 `__demoXxx` 全局函数。生成 bootstrap 对数值范围和 buffer 类型做显式检查，不使用 `>>> 0` 静默改变错误输入。

Rust 没有类继承，生成结果通过组合让 `UnitData/ItemData` 持有 `EntityData`。所有实体共用 generation Arena；实体销毁后旧 handle 会明确报错。

## 标量与批量访问

业务可以直接写：

```typescript
const native = unit.GetComponent(NativeUnitRef);
native.x += 1;
```

这会跨 V8/Rust 边界执行一次 getter 和一次 setter。框架不禁止、限流或偷偷缓存标量访问，开发人员负责判断调用频率。已知热循环应优先设计粗粒度 API，例如地图 Tick 使用一次 `UpdateMapMovement`，背包批处理可设计 `UseItems` 或 `LoadBagSnapshot`。

调用方向固定为 TS handle -> Host op -> Rust Arena。Rust 不回调 TS 获取实体字段，也不维护第二份 TS 权威状态。

## 配置与观测

`process.nativeData` 只包含可选的诊断配置：

```json
{
  "debugScalarAccess": true,
  "scalarAccessWarnThreshold": 10000
}
```

每 5 秒输出的 `native-data-metrics` 包含：

- `scalar_gets/scalar_sets`：点状 fast op 次数。
- `batch_calls`：地图批处理次数。
- `live_entities/live_units`：Arena 存活实体数。
- `encoded_frames/encoded_items/encoded_bytes`：Rust protobuf 投影工作量。

提醒阈值只产生日志，不改变业务行为。

## 验证

```powershell
npm run test:native-data
npm run perf:map-capacity -- --gates 16 --players 3500 --rounds 3
```

移动状态机回归数据位于 `native_data/movement_regression.json`。地图容量报告会同时记录 NativeData 边界指标。

## 历史决策

2026-07-22 的迁移 A/B 已完成并封存：3500 玩家、16 Gate 下，Rust 权威 Unit 使 Map CPU 中位数下降约 6.8%；Rust 直接 protobuf 广播轮次下降约 12.8%，p95 下降约 17.7%。历史报告保留在 `perf/results/native_data_ab_latest.md`，A/B runner 和旧 TypeScript 后端已从正式工程删除。

这组数据支持当前方向，但不是“所有对象都必须下沉”的承诺。适合批处理的密集跨帧状态优先放 Rust；网络 DTO、Handler 局部变量、不可变配置和低频业务对象仍可自然留在 TypeScript。
