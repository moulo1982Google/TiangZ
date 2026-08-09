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

`.native` 的 Lexer、Parser、AST、语义校验和 Rust/TS 模板不再由主工程维护。它们来自独立的 [tiangz-native-language](https://github.com/moulo1982Google/tiangz-native-language) 仓库。主工程生成器只扫描源码、校验输出路径、写文件并执行 `rustfmt`。升级语言版本时必须显式修改 `package.json` 中的 Tag，并重新执行完整 codegen 回归。

字段继承顺序、字段编号、生成名称与 Component 生命周期来自共享 Entity API 投影。VS Code Hover 和 codegen-core 共用这份投影，禁止在主工程生成器或插件中重新实现规则。

生成器认识 Entity、继承、字段、`@typeId`、`@component` 和 Native op 签名。`NativeUnitRef` 与 `NativeItemRef` 都通过生成的 `NativeOps` 创建、销毁和访问数值字段。框架通用 Entity ABI 位于 `native_data/core/EntityOps.native`；移动输入、地图批处理与 protobuf 投影属于 Demo，ABI 位于 `native_data/demo/MapOps.native`，TS facade 和 Rust Extension 仍由 codegen 聚合生成。业务不得把自定义 op 塞回 Core 原型。

字段可以使用`@hot`或`@cold`声明访问温度。codegen生成`NativeEntityPools`、每种具体Entity的独立Pool，以及存在冷热标记时的`XxxHotData`、`XxxColdData`与访问器。未标记字段按冷数据处理。冷热标记属于Native schema和Model，不能热更；修改后必须完整生成、构建并重启Process。

新增粗粒度 op 时，只声明 ABI 并实现 Rust 函数。`host.rs` 不维护 Native op 列表，也不安装 `__demoXxx` 全局函数。生成 bootstrap 对数值范围和 buffer 类型做显式检查，不使用 `>>> 0` 静默改变错误输入。

游戏专用Rust实现统一位于`src/game/<domain>`。生成Extension为了保持稳定ABI，当前仍从`crate::native_data`导入op符号；`native_data`只能对`src/game`中的实现做兼容re-export，不能因此把业务代码重新写回Store模块。Runtime公共存储只向游戏模块提供窄访问函数，不公开`NativeEntityStore`、Pool槽位或世代目录。

Numeric动态字典不使用生成Entity字段布局，但仍遵循同一Store边界。值统一保存为`i64`，TS op和protobuf映射为`bigint/int64`；派生属性由`src/game/numeric.rs`按稳定编号约定计算，Store只负责原子写入、逐字段revision和编码。

Rust 没有类继承，生成入口结构通过组合让 `UnitData/ItemData` 持有 `EntityData`。运行时的generation handle目录只保存“世代 + 类型池位置”，Unit、Item等权威数据进入生成的独立Pool；Unit热字段与冷字段分开存放。实体销毁后池槽可复用，但旧handle仍会明确报错。

## 标量与批量访问

业务可以直接写：

```typescript
const native = unit.GetComponent(NativeUnitRef);
native.x += 1;
```

这会跨 V8/Rust 边界执行一次 getter 和一次 setter。框架不禁止、限流或偷偷缓存标量访问，开发人员负责判断调用频率。已知热循环应优先设计粗粒度 API，例如地图 Tick 使用一次 `UpdateMapMovement`，背包批处理可设计 `UseItems` 或 `LoadBagSnapshot`。

调用方向固定为 TS handle -> Host op -> Rust typed pool。Rust 不回调 TS 获取实体字段，也不维护第二份 TS 权威状态。

## 配置与观测

`process.observability.nativeData` 只包含由Rust Core校验的可选诊断配置：

```json
{
  "observability": {
    "nativeData": {
      "debugScalarAccess": true,
      "scalarAccessWarnThreshold": 10000
    }
  }
}
```

每 5 秒输出的 `native-data-metrics` 包含：

- `scalar_gets/scalar_sets`：点状 fast op 次数。
- `batch_calls`：地图批处理次数。
- `live_entities/live_units/live_items`：Rust类型池存活实体数。
- `pool_capacity_bytes`：Rust类型池已保留容量；它不是RSS，但可用于发现Pool只增不降或异常扩容。
- `native_refs{entity_type}`：TS侧当前存活的生成句柄对象数，用于发现脚本引用积压。
- `scratch_capacity_bytes/scratch_growths`：帧尾可复用临时容器的保留容量与累计扩容次数。
- `encoded_frames/encoded_items/encoded_bytes`：Rust protobuf 投影工作量。

提醒阈值只产生日志，不改变业务行为。

## 验证

```powershell
npm run test:native-data
npm run perf:map-capacity -- --gates 16 --players 3500 --rounds 3
```

移动状态机回归夹具位于 `tests/fixtures/native_data/movement_regression.json`。它固定每个 Tick 的输入与期望状态，不是 Native Entity 原型。地图容量报告会同时记录 NativeData 边界指标。

## 历史决策

2026-07-22 的迁移 A/B 已完成并封存：3500 玩家、16 Gate 下，Rust 权威 Unit 使 Map CPU 中位数下降约 6.8%；Rust 直接 protobuf 广播轮次下降约 12.8%，p95 下降约 17.7%。历史报告保留在 `perf/results/native_data_ab_latest.md`，A/B runner 和旧 TypeScript 后端已从正式工程删除。

这组数据支持当前方向，但不是“所有对象都必须下沉”的承诺。适合批处理的密集跨帧状态优先放 Rust；网络 DTO、Handler 局部变量、不可变配置和低频业务对象仍可自然留在 TypeScript。

## AOI前数据布局基准

2026-07-27增加了不包含AOI、网络、protobuf、V8和Handler的纯Rust布局基准：

```powershell
npm run perf:native-storage
```

基准比较当前异构Handle Arena、Unit/Item类型分池，以及Unit冷热分池。50,000 Unit、每Unit 10 Item的混合工作集中，类型分池相对Arena吞吐提升约109%，冷热分池再提升约244%；不创建Item的控制组中，类型分池只提升约6.5%，冷热分池仍再提升约276%。这说明类型分池的主要收益来自避免异构大enum槽位破坏缓存工作集，而冷热分离能稳定缩小每Tick扫描范围。

正式Runtime已迁移到生成的Unit/Item类型池和Unit冷热布局，并保留generation handle、通用标量op、销毁校验、Numeric挂载和现有移动回归。本轮仍未实现AOI；纯布局基准只证明数据访问与内存工作集改善，地图容量结论必须等待高负载A/B。

帧尾路径复用玩家handle与records容器，并直接编码到最终交给V8的输出buffer，避免先生成frame再复制以及逐玩家临时`Vec`。最终输出buffer必须转移所有权，不能跨帧复用。当前没有足够的帧生命周期临时对象图支撑在生产Runtime引入Bump allocator；只有分配Profile证明仍存在大量“同帧创建、帧末整体释放”的对象后，才允许用隔离A/B候选重新评估。
