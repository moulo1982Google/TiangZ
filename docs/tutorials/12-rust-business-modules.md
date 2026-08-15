# Rust业务模块

## 什么时候使用

TiangZ默认使用TypeScript编写业务。只有领域规则相对稳定，并且存在批量计算、权威数据访问、直接编码或跨V8边界成本等明确收益时，才选择Rust实现。Rust业务随Process编译，修改后必须重新构建和重启，不能通过TS Hotfix发布。

适合Rust的候选包括Buff执行引擎、战斗结算、移动、碰撞、AOI和寻路。活动编排、任务流程、NPC对话及频繁调整的规则继续优先使用TS。

## 目录责任

```text
native_data/<game>/Xxx.native       Entity数据原型
native_data/<game>/XxxOps.native    TS/Rust边界契约
src/game/<domain>/                  开发者Rust业务实现
src/native_data.rs                  框架句柄、Pool、脏版本和受控Store访问
src/generated/                      codegen输出，禁止手改
```

每个领域使用独立模块：

```text
src/game/
  mod.rs
  movement.rs
  buff/
    mod.rs
    store.rs
    actions.rs
```

业务模块不得直接访问`NativeEntityStore`、世代槽位或类型Pool。如果现有能力不足，应在框架侧增加窄接口，例如“验证Unit句柄”“批量修改Numeric”，不能把整个Store设为`pub(crate)`交给业务任意修改。

## 新增Native op

1. 在`native_data/<game>/XxxOps.native`声明粗粒度op。
2. 在`src/game/<domain>`实现对应的`op_native_xxx`函数。
3. 从`src/game/mod.rs`导出该函数。
4. 在`src/native_data.rs`增加兼容re-export；这是当前生成Extension的稳定导入边界，不承载实现。
5. 执行生成、类型检查和Rust测试。

当前移动入口是最小op样例：[movement.rs](../../src/game/movement.rs)。[numeric.rs](../../src/game/numeric.rs)演示约定式派生属性、计算失败回滚以及向框架Store原子提交一组脏字段。`.native` op支持`i64`并生成TS `bigint` API；不要用`f64`或`number`承载可能超出安全整数范围的权威值。生成器负责Extension注册、参数范围校验、Host bootstrap和TS `NativeOps` facade，不要手工修改`src/generated/native_ops.rs`。

## Handler边界

普通Actor消息保持以下顺序：

```text
网络帧
  -> TS Scene/Session/ActorUnit路由
  -> Actor mailbox
  -> 生成或手写的薄Native适配器
  -> src/game领域模块
```

Rust算法不能绕过Location、地图传送屏障、RPC错误处理或mailbox。普通Unit没有这条Actor路由，由所属地图Component调用Rust批处理。未来Native Handler codegen可以消除手写TS适配器，但不能改变ActorUnit链路。只有Ping、握手等不访问业务Actor的基础设施控制帧可以在Rust网络入口直接消费。

## Buff建议形态

```text
TS BuffComponent代理
  -> NativeOps.BuffAdd/BuffRemove
  -> src/game/buff
      -> BuffStore
      -> Buff实例Pool
      -> 合并Tick/到期调度
      -> Action执行
```

不要为每个Buff跨一次V8边界，也不要从Rust逐Buff回调TS。地图每Tick最多调用一次粗粒度推进函数，Rust批量处理并产出Add/Remove事件或领域结果；Numeric和Movement变化继续复用各自同步路径。

## 验证

```powershell
npm run codegen:native-data
npm run typecheck
cargo fmt --check
cargo test native_data::tests
npm run verify:comments
```
