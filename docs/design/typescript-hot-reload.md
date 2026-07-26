# Process 级 TypeScript 热更设计

## 决策

TiangZ 保持“一 Process 一 V8、多 EntryScene”。Process 是线程、V8、部署版本和热更的原子边界；EntryScene 是业务边界，不拥有独立 V8。

需要独立扩缩容、故障隔离或发布节奏的 EntryScene，应通过配置拆到独立 Process，而不是在同一 Process 内增加 isolate。业务调用继续只面向 Scene 路由，本地和远程部署不改变调用代码。

## 为什么不采用一 EntryScene 一 V8

一个 V8 isolate 不能直接共享普通 JS 对象。改为一 EntryScene 一 V8 后，即使两个 Scene 位于同一 OS Process，也必须在 isolate 之间编码、复制和调度消息：

- 本地 Scene 调用失去同一 TS 世界内的低成本 mailbox 路径；
- 每个 isolate 重复持有 Heap、GC、Bundle、Singleton、Timer 和 Inspector；
- isolate 若共用线程，只增加复杂度而没有 CPU 并行；若各自使用线程，则改变单线程业务模型；
- Unit、Component 和跨 Scene 生命周期更难表达，调试时还要面对多个 Inspector；
- 热更虽然可以缩小到单个 Scene，却会让正常运行的每一次交互永久付费。

TiangZ 选择用部署边界解决独立发布，用 generation 注册表解决同一 Process 内的原子热更，不让热更需求反向破坏运行时模型。

## 热更对象

每次构建产生一个 Hotfix Bundle 和一份 manifest：

```text
HotfixManifest
  bundleVersion
  protocolFingerprint
  stableCoreApiHash
  nativeSchemaHash
  hotfixTypes[typeId -> shape]
  handlers[descriptor -> targetTypeId/method]
```

Bundle 模块加载阶段只允许声明类型、方法和 Handler 绑定，不允许启动 Timer、发 RPC、读写数据库或修改权威 Entity。副作用只能发生在显式生命周期或 Handler 中。

## 稳定类型与 prototype 补丁

可热更类拥有 codegen 分配的稳定 `typeId`。首次启动时，`HotfixTypeRegistry` 保存规范构造器；加载后续 Bundle 时，装饰器不直接替换现有实例，而是登记候选 prototype 描述符。

提交新 generation 时：

1. 校验不得删除仍被 manifest 使用的方法；
2. 保存当前 prototype 描述符供回滚；
3. 把候选方法描述符安装到规范构造器 prototype；
4. 原子替换 Handler generation；
5. 新消息和新 Timer 调度只解析新 generation。

现有 Entity、Scene 和 Component 实例仍引用同一个规范 prototype，因此下一次方法调用自然进入新实现，不需要重建 TS 对象，也不需要重新绑定 Rust handle。

TS `private` 编译后仍是普通属性，可以配合显式迁移；ECMAScript `#private` 带有 class brand，不允许用于可热更状态。新增、删除或改变实例字段必须提供 migration，不能假定旧实例自动执行新字段初始化器。

## Handler 与异步调用

Handler 注册表按 generation 分组。切换时先停止从宿主队列领取新业务帧，再完成一次原子注册表交换：

- 切换前已经进入 Handler 的 Promise 继续使用旧函数对象运行，并计入旧 generation 在途数；
- 切换后的新消息只解析新 Handler；
- 旧调用完成后释放 generation 引用；
- 超过排空时限的 generation 保留到调用完成，但不能重新接收消息；
- RPC response 仍按原 rpcId 完成，不因代码 generation 改变路由。

热更不得同时改变网络协议。协议 fingerprint、Stable Core API 或 Native schema 不兼容时拒绝在线切换，改走 Process 滚动重启和版本迁移。

## Timer 与 Update

当前直接保存任意闭包的 Timer 容易把旧 Bundle 长期保活。热更闭环需要增加所有权规则：

- Entity、Component、Scene Timer 必须记录 owner InstanceId、methodId 和 generation，不以匿名旧闭包作为长期身份；
- Timer 触发时重新解析规范 prototype 上的当前方法；
- 已销毁 owner 的 Timer 自动取消；
- 明确要求“继续执行旧逻辑”的一次性任务必须登记旧 generation 引用，并在排空指标中可见；
- Update target 使用稳定 typeId/InstanceId 调度，切换后调用新 prototype 方法。

业务代码优先使用 Entity/Component/Scene 提供的有所有者 Timer API，不直接使用进程级 `TimerSystem` 保存业务闭包。

## 加载、提交与回滚

一次热更分为四步：

1. **离线构建**：codegen、typecheck、协议/API/schema 锁和测试全部通过。
2. **隔离预检**：候选 Bundle 在临时 V8 中执行无副作用注册，验证入口和 manifest。
3. **在线暂存**：在当前 V8 中执行 Bundle，但装饰器只写入 staging registry；任何模块加载副作用都使安装失败。
4. **原子提交**：短暂停止领取新帧，安装 prototype 补丁、执行 migration、替换 Handler 表，然后恢复消息领取。

提交失败时按保存的 prototype 描述符、Handler 表和 migration undo 恢复旧 generation。对不可逆 migration 禁止在线热更，只允许滚动重启。

## 内存与滚动重启

JavaScript 没有可靠的模块卸载能力。即使旧 generation 在途数归零，V8 也不保证立即回收所有编译代码。因此热更不是无限次免重启机制：

- 记录活跃/排空 generation 数、旧 generation 存活时间、V8 code/heap 增量；
- 限制一个 Process 连续保留的 generation 数；
- 达到阈值后由 Watcher 执行有序 Process 滚动重启；
- Rust 权威状态和外部持久化决定重启后的恢复，不依赖旧 V8 Heap 永久存在。

## 最小验收矩阵

- 同步与异步 Scene/Session/Unit Handler 热更。
- 现存 Component 实例调用新 prototype 方法。
- 字段 migration 成功、失败和 undo。
- 重复 Timer、Update target 和正在等待远程 RPC 的旧 generation 排空。
- Handler 切换期间消息不丢失、不重复、rpcId 不错配。
- 不兼容 protocol/Core API/Native schema 被拒绝。
- 提交失败恢复旧版本并继续处理消息。
- 连续 100 次方法热更后，generation、Timer、pending operation 和 Heap 增长符合门槛。

## 开发者心智模型

普通业务开发者只需要知道：

1. 状态属于 Entity/Component 或 Rust NativeData，不属于模块全局变量；
2. 业务 Timer 使用 owner API；
3. 可热更类不使用 `#private`，字段形状变化需要 migration；
4. Handler 和领域方法照常编写，typeId、manifest、staging 和 prototype 安装由 codegen/Core 完成；
5. 需要独立发布的业务边界拆 Process，不增加 V8 配置项。
