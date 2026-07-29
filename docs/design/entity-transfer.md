# Entity地图迁移

本文冻结TiangZ地图迁移的数据所有权和失败语义。业务开发者仍从`MapHostComponent`发起传送，不应在Handler中手工删除、重建或扫描玩家。

## 同进程迁移

同一Process内的迁移按以下顺序执行：

1. 源Unit同步执行`CaptureTransfer()`，只捕获显式`@transferable()`组件。
2. 目标MapScene创建完整候选Unit，重建Native handle、Gate绑定和Persistence等非迁移组件。
3. 候选依次执行`RestoreTransfer()`，全部恢复后再执行`Deserialize()`。
4. `PlayerDirectoryComponent.Replace(source, target)`比较源InstanceId并原子替换目录，这是唯一提交点。
5. 提交后销毁源Unit，再广播源地图离开和目标地图进入。

步骤1至4任何位置失败，框架都会销毁尚未公开的候选Unit，源Unit和目录保持不变。Prepare内部如果尚未返回候选就抛错，Factory必须自行清理已创建的部分组件；Commit必须先完成所有可能失败的计算，最后一步才原子发布，发布成功后不得继续执行会抛错的工作。提交后的销毁或广播失败只记录错误，不允许把目录切回旧Actor；外部通知无法与内存状态一起回滚。

## 跨进程状态机

跨进程不能传输以TypeScript构造函数为键的`EntityTransferSnapshot`。Demo使用`PlayerTransferSnapshot` protobuf，只包含值数据，不包含Entity引用、Native handle、Timer、Promise或闭包。

目标MapHost提供三条内网RPC：

| RPC | 作用 | 重试语义 |
| --- | --- | --- |
| `MapTransfer.Prepare` | 校验schema并创建不可见候选Unit | 同一`transferId`和相同载荷返回同一候选；载荷变化直接拒绝 |
| `MapTransfer.Commit` | 把候选加入目标进程玩家目录 | 只执行一次；重试返回第一次的Actor位置与快照 |
| `MapTransfer.Abort` | 销毁未提交候选 | 只销毁一次；已经Commit后拒绝Abort |

目标暂存表有容量上限。Prepare超过30秒未完成会自动回滚；Commit和Abort结果保留60秒供丢包重试，随后清理。Process停机时会销毁全部未提交候选。Prometheus自定义指标`map_transfer_staging`暴露prepared、committed、aborted、total与capacity，便于发现源端宕机、提交停滞和容量逼近。

## 尚未完成的源端协调

当前已经具备目标端协议、可序列化DTO、幂等状态机与故障自测，但尚未实现跨Process全局Location/Directory。因此不能把本地`PlayerDirectoryComponent`当成全局玩家位置，也不能在生产业务中直接启用跨MapHost传送。

后续源端事务必须按以下顺序协调：目标Prepare成功，原子切换全局Location，目标Commit，源Unit下线。Location切换前失败时调用Abort并保留源Unit；切换后失败时必须重试Commit或进入人工可诊断状态，不能同时让源和目标都成为权威。

## 开发约束

- 新增可迁移Component时，先决定它是否真的跨地图保留；默认不迁移。
- 同进程状态实现`@transferable() + ITransfer`，跨进程DTO还要增加稳定protobuf投影。
- `RestoreTransfer`只恢复数据，Timer和派生索引由`Deserialize`重建。
- 协议schema变化属于Model变化，需要完整部署和重启，不是Hotfix。
- `npm run test:entity-transfer`验证提交前回滚、重复Prepare/Commit/Abort和超时回收。
