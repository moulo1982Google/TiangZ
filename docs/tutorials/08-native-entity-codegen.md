# Rust Entity 与 TS Handle 代码生成

## 数据边界

Native Entity 用于把跨帧权威状态放在 Rust。TS 只保存 generation handle，并通过生成属性调用 fast op：

```text
TS NativeItemRef.count
  -> generated NativeOps.EntityGetNumber(handle, fieldId)
  -> Rust NativeEntityStore
  -> NativeEntityData::Item(ItemData)
```

Rust 不回调 TS 获取字段，TS 也不缓存 Rust 字段。`item.count += 1` 是一次 getter 加一次 setter，框架允许开发人员自行决定调用频率；指标只观测，不限流。

## 新增 Item

在 `native_data/<game>/` 中创建一个 `.native` 文件：

```text
namespace demo;

@typeId(2)
entity Item extends Entity {
  readonly configId: u32;
  count: u32 = 1;
  quality: u32 = 0;
  level: u32 = 1;
}
```

- `@typeId` 是稳定实体类型号，必须在全部 concrete entity 中唯一，范围为 1 到 65535。
- `Entity` 是框架约定的抽象基类，提供只读 `id` 与 `instanceId`。
- `readonly` 只禁止 setter，不限制 getter 频率。
- 有默认值的字段在 TS CreateArgs 中是可选字段。
- 当前 schema 支持 `u32/i32/i8/f32`；字符串、数组、引用和父子销毁关系尚未开放。

运行生成器：

```powershell
npm run codegen:native-data
```

它会扫描 `native_data/**/*.native` 并生成：

```text
src/generated/native_data.rs
src/generated/native_ops.rs
src/generated/native_ops_bootstrap.js
app/generated/model/native/NativeOps.ts
app/generated/model/native/NativeItemRef.ts
```

扫描到的源码先交给 `@tiangz/native-language-core` 解析和校验，再由 `@tiangz/native-language-core/codegen` 生成内存中的 Rust/TS 文件。语法错误会包含文件、行号、列号和稳定的诊断编号；TiangZ 内的脚本只负责输出路径校验、落盘和 `rustfmt`。对应的 VS Code 扩展、语言核心与生成核心位于 [tiangz-native-language](https://gitee.com/eblard_admin/tiangz-native-language)。

不要手工编辑 Generated 文件。

生成器与 VS Code Hover 共用 Entity API 投影，因此继承字段顺序、字段编号以及 `@component` 的生命周期说明应始终一致。升级依赖 Tag 后，应先运行 codegen，并确认已有 Generated 文件没有非预期变化。

## 使用普通 Handle

没有 `@component` 的实体生成普通 handle 类，同一个 Bag 可以持有任意多个 Item：

```typescript
const item = NativeItemRef.Create({
  id: itemId,
  instanceId,
  configId: 3001,
  count: 2,
});

item.count += 1;
console.log(item.configId, item.count);

item.Dispose();
```

当前 Item 没有 Rust 父子关系，拥有这些 handle 的 `BagComponent` 必须在删除物品或销毁背包时调用 `Dispose()`。重复 Dispose 是安全的；Dispose 后访问会抛出 handle 已失效错误。

Item 通常不需要 Actor/mailbox。客户端请求仍发给 PlayerUnit，Handler 从 BagComponent 取得 Item handle 后修改 Rust 数据。

## 生成 Component Handle

如果一个 Native Entity 与一个 TS Entity 是一对一关系，可以添加 `@component`：

```text
@typeId(1)
@component
entity Unit extends Entity {
  readonly mapId: u32;
  x: f32 = 0;
  y: f32 = 0;
}
```

生成类继承 Core `Component`，使用方式是：

```typescript
const native = player.AddComponent(NativeUnitRef, {
  id: player.UnitId,
  instanceId: player.InstanceId,
  mapId,
});
```

PlayerUnit 销毁时 Component 自动释放 Rust handle。不要给 Bag Item 使用 `@component`，因为同一个 owner 只能挂一个同类型 Component。

## 通用与业务专用能力

所有实体共用以下 Host op，新增 Item 不需要修改 `host.rs`：

```text
native_entity_create
native_entity_destroy
native_entity_get_number
native_entity_set_number
```

Unit 的 `NativeData.SetMovementInput/UpdateMapMovement/protobuf snapshot` 是地图业务的批处理投影，不属于通用 Entity CRUD。新增 Item 不会自动获得移动能力；需要高性能批量背包操作时，应另外设计 `UseItems/LoadBagSnapshot` 这样的粗粒度 Rust API。

## 新增粗粒度 Native op

框架通用 Entity ABI 声明在 `native_data/core/EntityOps.native`；业务专用的粗粒度 ABI 放在对应游戏目录，例如 Demo 的 `native_data/demo/MapOps.native`：

```text
op UnitSetMovementInput(handle: u32, inputX: i8, inputY: i8, sequence: u32): bool;
op MapUpdateMovement(mapId: u32, serverTick: u32, fixedUpdateMs: u32, messageCode: u32): bytes;
```

新增 op 的流程是：

1. 在 `native_data/<game>/XxxOps.native` 声明参数和返回类型；不要修改 Core Entity op。
2. 在 Rust 实现约定名称，例如 `MapUpdateMovement` 对应 `op_native_map_update_movement`。
3. 执行 `npm run codegen:native-data`。
4. TS 通过生成的 `NativeOps.MapUpdateMovement(...)` 调用。

生成器负责 Rust Extension 注册、Host bootstrap、`u32/i32/i8` 范围校验、buffer 类型校验和 TS facade。不要在 `host.rs` 手写 `globalThis.__demoXxx`，也不要用 `value >>> 0` 把无效参数静默截断成 uint32。

## 验证

```powershell
npm run codegen:native-data
npm run typecheck
cargo test --bin TiangZ native_data::tests
npm run test:actor
npm run check
cargo test --all-targets
```

运行时观察：

```text
[native-data-metrics] ... live_entities=... live_units=...
```

`live_entities` 是 Arena 中全部实体数，`live_units` 只统计地图 Unit。场景退出后数量没有回落，通常表示 owner 没有释放 handle。
