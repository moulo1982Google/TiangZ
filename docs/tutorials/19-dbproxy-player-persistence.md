# DBProxy玩家快照持久化

本教程演示TiangZ如何通过独立DBProxy保存玩家快照、在TiangZ重启后恢复，并以任务道具奖励验证第一条关键经济事务。当前实现仍是Phase 4.5基础：它不等于Wallet、Trade、UseItem和故障接管都已生产化。

## 固定边界

```text
MapHostScene
  -> PlayerRepository                 业务接口与Payload归TiangZ
      -> DbProxyClient                通用TypeScript SDK
          -> HostDbProxyTransport     V8到Rust Host的薄适配
              -> Rust连接池           Tokio多线程执行网络I/O
                  -> 独立DBProxy
                      -> PostgreSQL   权威快照与Revision
                      -> Redis        已提交缓存与普通快照backlog
```

- DBProxy不认识Scene、Entity、Component、Item、Buff或Quest，只保存带Schema与Revision的不透明字节。
- TiangZ不导入`dbproxy-storage`，也不直接连接Redis/PostgreSQL。
- TypeScript业务V8不打开Socket；Rust Host Runtime驱动连接、握手、超时和重连。
- 普通`configs/local/all-in-one.json`继续使用内存Repository，不要求数据库。
- 只有显式配置`process.persistence.dbProxy`的Process才连接DBProxy。

## 本地启动

先启动独立仓库中的PostgreSQL、Redis和DBProxy：

```powershell
cd E:\gitee\TiangZ\tools-projects\TiangZ-DBProxy
docker compose --env-file deploy/local/.env -f deploy/local/docker-compose.yml up -d
powershell -ExecutionPolicy Bypass -File tools/run_local.ps1
```

`run_local.ps1`会读取`deploy/local/.env`。另开终端启动TiangZ，令牌值必须与其中的`DBPROXY_AUTH_TOKEN`一致：

```powershell
cd E:\gitee\TiangZ
$env:TIANGZ_DBPROXY_AUTH_TOKEN = "tiangz-dbproxy-local-token-2026"
npm run build
cargo run --locked --bin TiangZ -- configs/local/all-in-one-dbproxy.json
```

本机演示账号只绑定`127.0.0.1`，不能复制到生产环境。令牌只进入环境变量，禁止写入Runtime JSON、日志或业务Payload。

## Process配置

```json
{
  "process": {
    "name": "all",
    "persistence": {
      "dbProxy": {
        "endpoint": "127.0.0.1:7800",
        "authTokenEnv": "TIANGZ_DBPROXY_AUTH_TOKEN",
        "clientPoolSize": 4,
        "connectTimeoutMs": 5000,
        "requestTimeoutMs": 5000,
        "maxFrameBytes": 8388608
      }
    }
  }
}
```

TiangZ Developer Tools `v0.15.1`会为这些字段提供补全和范围检查。配置属于Process启动模型，修改后必须重启；它不是Hotfix或热配置。

## 加载顺序

玩家首次进入MapHost时：

```text
MapHostComponent.EnterMap
  -> repository.Load(account)
  -> MapComponent.CreatePlayer(..., loaded)
  -> 添加全部业务Component
  -> 恢复Numeric、Item、Buff、Skill和Quest
  -> CompleteDeserialize重建Timer与运行时索引
  -> 发布PlayerDirectory、Location和AOI
```

恢复必须在Unit对外可见前完成。禁止先创建默认玩家并广播，再异步把数据库字段覆盖进去；那会让Handler、AOI和客户端短暂观察到错误状态。

只有保存的`mapId + mapInstanceId`仍与本次目标一致时才恢复坐标。副本已经销毁或业务选择了其他地图时，目标地图出生点保持权威；“副本不存在后回到哪里”由业务决定，不由DBProxy猜测。

## 保存顺序

断线宽限结束、踢下线或Process停机最终都会调用玩家内部的：

```ts
await player.Offline(reason);
```

`PlayerPersistenceComponent.SaveOnOffline`只创建一个保存Promise：重复清理者等待同一个结果，不会绕过玩家生命周期重复提交。它采集业务快照并以当前Revision调用`PlayerRepository.Save`；成功后才更新本地Revision，然后才能继续Location清理、AOI Leave和Actor销毁。

DBProxy保存使用一个固定`requestId`。如果PostgreSQL已经提交、但Redis同步失败导致结果不确定，Repository会使用完全相同的请求重试；不得换ID，否则可能把一次逻辑保存变成两次提交。

## 任务奖励关键事务

当前第一条关键事务是不可重复任务领取`GrantItem`奖励：

```text
C2M_CompleteQuest（PlayerUnit ordered mailbox）
  -> ItemComponent.PlanGrantItems()       只计算base/next/affected快照
  -> PlayerPersistenceComponent.Capture() 用next items和next quests组合操作后记录
  -> PlayerRepository.ApplyTransaction()
      -> DBProxy/PostgreSQL原子保存Payload、revision和原始响应
  -> ItemComponent.CommitGrantPlan()      无await修改Item Entity
  -> QuestComponent.RestoreTransfer()     写完成集合并移除活动Quest
  -> Handler发布奖励道具变化并响应客户端
```

DBProxy确认前，Item和Quest Entity都保持原状。operationId使用`quest-reward:<account>:<questConfigId>`；当前任务不可重复，因此该键稳定。以后支持可重复任务时必须改用稳定Quest实例ID，不能继续只用配置ID。

如果PostgreSQL已经提交但ACK丢失，`PlayerPersistenceComponent`会标记该操作结果不确定。下一次相同请求先调用`LoadTransaction`读取首次回执；Inventory只接受“已经相同”或“恰好推进一个Item version”的恢复，其他本地漂移拒绝自动覆盖并要求重新加载完整玩家数据。

当前事务Planner只支持`GrantItem`。把Heal、Buff或跨玩家奖励写进Quest配置会被明确拒绝；新增事务Action前必须实现纯数据Planner、持久Payload和回执恢复规则，不能先改Entity再补一次Save。

## 当前快照内容

| 数据 | 当前行为 |
|---|---|
| 玩家地图、位置、朝向和存活状态 | 保存；同一地图实例才恢复坐标 |
| Numeric动态值 | 保存为`numericType -> i64`，TS使用`bigint` |
| Item | 保存稳定ItemId、配置、数量和版本 |
| Buff | 保存剩余时间、Tick、Action和护盾状态；自身来源映射到新UnitId |
| Skill | 保存GCD、技能CD和道具CD；活动Cast不保存 |
| Quest | 保存活动任务、目标进度与已完成配置ID；运行时目标索引重建 |
| Gate、Session、UnitId、Actor InstanceId | 不保存，重新进入时创建 |
| TimerId、Promise、闭包、AOI关系、移动意图 | 不保存，恢复时重建或重置 |

快照Schema为`tiangz.demo.player@1`。`PlayerPersistenceCodec.ts`使用带显式标签的UTF-8 JSON保存`bigint`，解码后完整校验再交给Entity恢复；DBProxy只看到`Uint8Array`。

## 增加持久字段

开发新Component时按这个顺序接入：

1. 先判断字段属于`runtime`、普通`snapshot`还是关键`transactional`域。
2. 在TiangZ的`PlayerSaveData`中增加纯数据DTO，不把Entity、Component、Timer或Native句柄放进去。
3. 在`PlayerPersistenceCodec`增加编码后的完整校验；破坏兼容时升级Schema并提供迁移策略。
4. 在`SaveOnOffline`采集数据，在`MapComponent.RestorePersistedPlayer`恢复数据。
5. 需要Timer或索引的Component通过`Deserialize`做二次重建，不在Codec中启动业务。
6. 增加Repository自测和真实重启恢复冒烟。

业务Component不能直接创建数据库客户端。更换存储实现时只实现`PlayerRepository`并修改`CreatePlayerRepository`这个唯一工厂点，Handler与领域逻辑保持不变。

## 重启恢复验收

先构建客户端工具，然后使用一个全新的账号写入：

```powershell
npm run build:client
node dist/smoke_client.cjs --dbproxy-persistence-write dbproxy_smoke_001
```

该命令进入地图、把1001道具从50个消耗到49个，立即断开，并等待Gate的30秒重连宽限结束后保存。看到写入完成后，只停止并重新启动TiangZ，保持DBProxy、PostgreSQL和Redis运行，再执行：

```powershell
node dist/smoke_client.cjs --dbproxy-persistence-read dbproxy_smoke_001
```

通过标准是重新进入后同一Item仍为`count=49, version=2`，而不是再次发放默认50个。快速纯逻辑回归使用：

```powershell
npm run test:player-persistence
```

## 当前限制

- 当前只在最终下线和停机保存，没有周期快照；TiangZ在保存前崩溃仍可能丢失最近运行状态。
- 任务`GrantItem`奖励已接入`ApplyTransaction`，但UseItem消耗、Wallet、Trade和跨玩家事务尚未接入；普通道具操作仍可能依赖稍后快照，不能把单条任务链路描述为全部经济数据生产级不丢。
- 尚无批量Load/Save、Prometheus DBProxy指标、TLS、令牌轮换、Redis高可用和自动节点接管。
- 玩家账号暂时就是快照RecordKey；正式账号/角色拆分后需要稳定CharacterId和明确的数据域Revision。

下一步应扩展UseItem/Wallet等关键经济边界并拆分领域revision，再做周期快照、批量登录恢复和故障接管，不能继续扩大一个巨型Player Snapshot来替代领域一致性设计。
