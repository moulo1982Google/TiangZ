# Location 与玩家 Actor 路由

本文冻结 TiangZ 的玩家运行时位置、普通消息热路径和地图迁移屏障。Location 只回答“某个 Unit 现在由哪个 Actor 持有”，不保存坐标、背包、数值、`connectionId`或业务快照。

## 权威记录

每条玩家位置包含：

- `unitId/account`：稳定业务身份。
- `gateName`：玩家长期绑定的 Gate 实例；普通断线重连不改变它。
- `mapHostName/mapId/mapInstanceId`：当前 MapHost 与地图实例。
- `actorInstanceId`：本次 PlayerUnit 实例，旧实例销毁后永久失效。
- `revision`：每次成功迁移递增，用于拒绝旧请求。
- `state`：`active`、`moving`或`removing`。

Location Scene 使用 ordered mailbox 串行修改目录。`Lock`同时校验 revision、Actor InstanceId 与 operationId；同一个 operationId 的重试幂等，不同操作不能抢占锁。

## 什么时候更新

1. PlayerUnit 完成 Factory、Component 组装和异步加载后，MapHost 才执行 `Register`。半初始化 Unit 不得发布。
2. 地图迁移先把记录锁为 `moving`，目标 Unit 准备并提交后切换 Location，最后清理源 Unit。
3. 最终下线先锁为 `removing`，玩家保存成功后删除 Location，再移除 Map Unit。保存失败会解锁并保留玩家。
4. 每个 MapHost 每 5 秒幂等重报自己实际持有的 Unit，用于 Location 内存进程重启后的目录恢复。

玩家Location目录之外还有独立的MapInstance目录，只保存`mapInstanceId -> mapConfigId + mapHostName + dynamic`。静态地图令`mapInstanceId == mapConfigId`，由所属MapHost按`staticMapIds`创建后注册；动态副本使用`GlobalIdSystem`产生的全局实例号。MapHost每5秒重报实际托管实例，因此Location重启后可恢复路由。业务传送只提供目标实例号，不能扫描全部MapHost，也不能把MapHost地址塞入玩家传送请求。

## 什么时候查询

- 客户端普通 `IActorLocation*` 消息：**不查询 Location**。Gate 在登录/进图时保存 `connectionId -> MapHost + actorInstanceId`，后续直接走本地 mailbox 或 Inner TCP。
- 服务器业务只知道 `unitId`：使用 `MessageHelper.CallUnit/SendUnit`，内部查询一次 Location 后直达 Actor。
- 公会等批量业务：使用 `ResolveUnits` 一次批量解析，再按 MapHost 或 Gate 分组；禁止逐成员查询后逐条发送。
- Gate 冷重启后账号重连：按 account 查询一次，重建本地 Route，再调用原 Unit 的 `SecondEnterMap`。
- 主动传送：打开屏障后查询一次，刷新 Location 重启后可能变化的 revision；查询不进入普通消息热路径。
- 已持有具体 Unit 或 Actor 地址：直接调用，不得反向查询 Location。

## 迁移期间的消息

Gate 必须在传送流程的第一个 `await` 之前同步打开连接屏障。Proto 的 `duringTransfer`声明行为，业务代码不写 msgcode 分支：

| 策略 | 用途 | 行为 |
| --- | --- | --- |
| `queue` | 使用道具等必须执行一次的 RPC | 有界排队，提交后投递新 Actor，回滚后投递旧 Actor |
| `reject` | 不能等待的查询 RPC | 立即返回系统错误 `ActorTransferring` |
| `drop` | 可被后续状态覆盖的单向消息 | 直接丢弃，例如旧移动输入 |
| `latest` | 只需要最终一次的单向状态 | 同 msgcode 只保留最新帧 |

每个连接最多缓存 64 帧、256 KiB、3 秒。超限或超时必须拒绝 RPC、丢弃单向消息，不能无限占用 Gate 内存。成功提交后新消息只进入新 Actor；提交前失败解锁 Location 并把保留消息恢复给旧 Actor。

Gate自定义指标`actor_transfer_barrier`暴露active、queued_frames、queued_bytes以及started/completed/cancelled/timed_out/enqueued/rejected/dropped/overloaded累计值；Location的`location_directory`暴露entries、moving、removing、resolve、mutation和conflict。两组指标都禁止账号、UnitId或connectionId高基数标签。

如果跨进程目标已提交，但 Location 提交结果因网络故障变得不确定，Gate 不会把消息重放给旧 Actor，而是拒绝缓冲请求、断开连接并保留 `moving` 诊断态。该分支需要后续高可用事务恢复，不能伪装成成功回滚。

## 重启恢复与边界

Location 本身只保存内存目录。Location 单进程重启后，存活 MapHost 的周期重报可以恢复 active 记录；Gate 在下一次传送前刷新 revision。恢复批次先整体校验再写入，不覆盖其他 MapHost 的冲突记录，也不强行解除现有 moving/removing 操作。

Location同时记录每个MapHost的所有权代次。Watcher确认本地子进程退出并拉起同名静态MapHost后，新代次会先整体校验恢复批次，再删除该Host旧代次遗留的Actor路由；旧代次后续重报会被拒绝。Gate只有在旧Actor调用失败且Location已删除或换代时才清理本地缓存，下一次进图从DBProxy恢复PlayerUnit。该流程不是普通消息热路径，也不逐消息查询Location。

当前尚未实现：跨机器租约仲裁、动态副本现场恢复、在途跨进程事务日志、etcd服务发现和Gate故障转移。因此现有接管只适用于Watcher确认旧进程已退出的显式静态MapHost策略，不等于生产级分布式高可用。

## 验证

- `npm run test:location`：revision CAS、operation 幂等、恢复批次原子性和生成的迁移策略。
- `npm run test:runtime`：单进程与拆分进程 Map1 -> Map2，迁移期间并发 `UseItem` 只在目标 Unit 执行一次。
- `npm run test:gate-reconnect`：连接代次、冷/热重连路由与旧连接隔离。
