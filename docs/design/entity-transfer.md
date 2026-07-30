# Entity地图迁移

本文冻结TiangZ地图迁移的数据所有权和失败语义。业务开发者只调用`player.TransferToMap(mapInstanceId)`，不应在Handler中查找MapHost、手工删除、重建或扫描玩家。

`MapConfigId`只表示地图模板，`MapInstanceId`才是运行时寻址身份。静态地图实例号等于配置号；同一配置可以创建多个具有不同实例号的动态副本。地图内部Rust热路径使用不可见的Process本地Scene句柄做索引，不能把它保存或当作跨进程实例号。

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

## 源端协调与 Location

Gate先同步打开该连接的Actor迁移屏障，再通过源PlayerUnit mailbox发起事务。源MapHost按以下顺序执行：

1. 用MapInstance目录解析目标MapHost和配置，再用Location revision、源Actor InstanceId和唯一operationId执行`Lock(moving)`。
2. 同MapHost创建目标候选并以本地玩家目录CAS发布；跨MapHost执行目标`Prepare`与幂等`Commit`。
3. 用同一operationId把Location原子切换到目标MapHost与新Actor InstanceId，revision递增。
4. 延迟到源Handler退出后销毁源Actor，再广播源地图离开。
5. Gate改绑连接路由并释放屏障；排队消息只投递目标Actor。

步骤2提交前失败会Abort候选、Unlock Location并保留源Unit。Location提交后不得恢复旧Actor；AOI通知失败只能记录并由后续全量快照修复。跨进程目标已经Commit、但Location Commit因网络故障结果不确定时，系统保留`moving`诊断态、拒绝缓冲消息并断开连接，不会伪装回滚。该少见分支仍需Phase 5的持久事务日志和自动恢复器。

Location是全局运行时目录，`PlayerDirectoryComponent`仍只是一个MapHost内的账号重连和迁移CAS索引。普通客户端Actor消息使用Gate缓存，不逐条访问Location。详细路由、恢复和消息策略见[Location与玩家Actor路由](location-routing.md)。

## 开发约束

- 新增可迁移Component时，先决定它是否真的跨地图保留；默认不迁移。
- 静态/动态、同V8/跨V8/跨Process不得定义不同传送API；统一使用MapInstanceId。
- 同进程状态实现`@transferable() + ITransfer`，跨进程DTO还要增加稳定protobuf投影。
- `RestoreTransfer`只恢复数据，Timer和派生索引由`Deserialize`重建。
- 协议schema变化属于Model变化，需要完整部署和重启，不是Hotfix。
- `npm run test:entity-transfer`验证提交前回滚、重复Prepare/Commit/Abort和超时回收。
- `npm run test:location`验证revision、operation幂等、恢复批次和迁移策略。
- `npm run test:runtime`验证同进程与跨进程真实传送，以及屏障内RPC只执行一次。
