# DBProxy玩家快照持久化

本教程演示TiangZ如何通过独立DBProxy保存玩家的inventory、progression、quest、runtime和wallet五类记录，在TiangZ或MapHost崩溃后安全重启恢复，并以任务奖励、UseItem、NPC商店和玩家交易验证单记录、多领域及跨玩家事务。当前实现不等于邮件、拍卖行、跨地图交易或透明节点接管已经生产化。

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
- 登录注册使用同一个`character_catalog`快照：快照保存账号、密码盐值/摘要和同名初始角色；明文密码不进入快照、日志或Token。
- 未配置DBProxy时注册仍可用于界面和协议调试，但只存在当前Process内存；不能把这种模式当作“已落盘”。

## 玩家记录与Revision

聚合捕获值`PlayerSaveData`不是数据库中的单条记录。`DbProxyPlayerRepository`按角色拆成五个稳定RecordKey：

| RecordKey后缀 | 字段 | 一致性语义 |
|---|---|---|
| `inventory` | Item | 关键道具操作先提交后确认 |
| `wallet` | 金币 | 关键货币操作先提交后确认 |
| `progression` | Numeric | 周期快照；涉及HP/MP时可进入事务 |
| `quest` | Quest | 周期快照；涉及奖励时可进入事务 |
| `runtime` | 地图/位置/存活、Buff、GCD/CD | 周期快照，允许最多一个周期回退 |

实际Key为`player/<characterId>:<domain>`，五个领域各自维护Revision。业务操作必须只声明真实变化的领域：NPC商店=`inventory + wallet`；玩家交易=双方`inventory + wallet`；任务奖励和拾取=`inventory + quest`；UseItem因Inventory、CurrentHp/CurrentMp、Buff与CD可能同时变化，固定提交`inventory + progression + runtime`。禁止用某次操作顺便覆盖未参与的领域记录。

## 本地启动

先启动独立仓库中的PostgreSQL、Redis和DBProxy：

```powershell
# 在独立TiangZ-DBProxy仓库根目录执行
docker compose --env-file deploy/local/.env -f deploy/local/docker-compose.yml up -d
powershell -ExecutionPolicy Bypass -File tools/run_local.ps1
```

`run_local.ps1`会读取`deploy/local/.env`。另开终端启动TiangZ，令牌值必须与其中的`DBPROXY_AUTH_TOKEN`一致：

```powershell
# 回到TiangZ仓库根目录
$env:TIANGZ_DBPROXY_AUTH_TOKEN = "tiangz-dbproxy-local-token-2026"
npm run build
cargo run --bin TiangZ -- configs/local/all-in-one-dbproxy.json
```

启动后打开Cocos3D，在登录遮罩中点击“注册”。用户名会同时成为角色名；停止并重新启动TiangZ后，用同一用户名和密码点击“登录”，即可验证账号目录和角色ID仍由DBProxy恢复。若账号不存在，登录会明确返回“用户未注册”，不会再隐式创建游客账号。

本机演示账号只绑定`127.0.0.1`，不能复制到生产环境。令牌只进入环境变量，禁止写入Runtime JSON、日志或业务Payload。

## 外网2C2G部署

外网两Process配置已经包含`process.persistence.dbProxy`，默认访问同机的`127.0.0.1:7800`。如部署第二个共享存储的DBProxy实例，可在同一配置中增加有序的`failoverEndpoints`，例如`127.0.0.1:7801`；它不是业务层的主从切换。部署机先安装Docker：

```bash
apt-get update
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
```

然后将DBProxy仓库的`deploy/local/docker-compose.yml`复制到服务器，使用单独生成的强密码创建`/opt/tiangz-dbproxy/.env`，并启动Redis/PostgreSQL：

```bash
docker compose --env-file /opt/tiangz-dbproxy/.env \
  -f /opt/tiangz-dbproxy/docker-compose.yml up -d
```

数据库端口必须只绑定`127.0.0.1`。DBProxy本身作为独立systemd服务监听`127.0.0.1:7800`，`TIANGZ_DBPROXY_AUTH_TOKEN`通过systemd环境文件同时注入DBProxy和TiangZ两个Process。只启动数据库容器不等于TiangZ已经接入持久化；应检查DBProxy、Login/Gate、World三类服务都为active，并用同一账号重启后重新登录验收。

## Process配置

```json
{
  "process": {
    "name": "all",
    "persistence": {
      "dbProxy": {
        "endpoint": "127.0.0.1:7800",
        "failoverEndpoints": ["127.0.0.1:7801"],
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

TiangZ Developer Tools `v0.15.1`会为这些字段提供补全和范围检查。配置属于Process启动模型，修改后必须重启；它不是Hotfix或热配置。客户端按RecordKey稳定选择连接，只有连接不可用才按顺序尝试备用地址；Revision冲突、业务拒绝、鉴权错误和协议错误直接返回，不会误切节点。

## 多记录事务的使用边界

`v0.5.0`的多记录接口只应由领域Repository使用，不能让Handler直接拼接数据库写入。Repository先为所有记录准备稳定顺序的`RecordKey`、`expectedRevision`和完整Payload，再使用同一个`operationId`调用`applyMultiTransaction`；响应丢失时用同一个`operationId`调用`loadMultiTransaction`恢复首次回执。

当前开发分支加载玩家时使用`LoadMultiSnapshot`一次读取五个领域。响应必须与请求等长、保持顺序，并为不存在的领域保留空位；Repository仍逐条校验RecordKey、Schema和版本。这个接口只优化恢复读取，不改变每个领域独立Revision，也不把多个领域合并成一个Payload。

```text
领域操作
  -> Repository规划多个RecordKey与expectedRevision
  -> DbProxyClient.ApplyMultiTransaction(operationId, writes, result)
  -> HostDbProxyTransport.applyMultiTransaction
  -> Rust Host按RecordKey选择DBProxy Endpoint
  -> DBProxy一次性提交全部记录或全部拒绝
```

多记录事务用于跨玩家奖励、交易等确实需要原子提交的领域操作；单玩家快照和单记录关键操作继续使用对应的单记录接口。网络不可用可以按备用Endpoint重试，业务拒绝、Revision冲突、鉴权失败和协议不匹配必须直接返回，不能通过换节点掩盖业务错误。

当前第一个跨玩家消费者是同地图玩家交易：`PlayerTradeComponent`冻结双方报价，`PlayerTradeTransaction`只在纯快照上规划金币与Item交换，`PlayerPersistenceComponent.ApplyMultiTransaction`一次提交双方`inventory + wallet`四条记录。确认前不改Entity；提交后才无`await`替换双方金币和背包。数据库已提交但响应丢失时，通过同一`operationId`查询多记录回执恢复，不能顺序调用两次单记录事务。完整流程见[玩家交易设计](../design/player-trade.md)。

## 加载顺序

玩家首次进入MapHost时：

```text
MapHostComponent.EnterMap
  -> repository.Load(characterId)
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

`PlayerPersistenceComponent.SaveOnOffline`只创建一个保存Promise：重复清理者等待同一个结果，不会绕过玩家生命周期重复提交。它依次保存inventory、progression、quest、runtime和wallet，每条成功后立即推进对应Revision，因此后续领域失败时可以从已提交位置继续。成功后才能继续Location清理、AOI Leave和Actor销毁。

在线玩家默认每30秒到期一次。Map每秒扫描一次，每轮最多启动两个玩家、每图最多四个周期保存并发；实际Capture/Save进入对应PlayerUnit ordered mailbox，不为每个玩家创建Timer。停机最终Flush每图最多八个worker，并收集全部失败后统一上抛，不会因为一个玩家失败跳过其余玩家。

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

## UseItem关键事务

外部道具请求不再执行“先扣道具、稍后保存”。完整链路是：

```text
C2M_UseItem（PlayerUnit ordered mailbox）
  -> ItemComponent.UseItemTransactional(itemId, operationId)
  -> Item.BeforeUse同步Veto
  -> PlanConsumeItem + PlanItemCooldown + PlanHealing/Plan Buff
  -> PlayerPersistenceComponent.Capture(操作后纯数据)
  -> PlayerRepository.ApplyTransaction()
      -> DBProxy/PostgreSQL原子保存Payload、revision和原始M2C_UseItem回执
  -> CommitConsumePlan + CommitItemCooldownPlan + Commit效果
  -> 发布Quest UseItem事实和自己的ItemChanged
```

DBProxy确认前，背包、冷却、HP和Buff Entity全部不变。提交后应用阶段不再`await`，因此同一个ordered PlayerUnit mailbox内不会暴露半完成状态。PostgreSQL已经提交但响应丢失时，服务端用`LoadTransaction`取得首次回执，只补做尚未应用的状态；旧回执不能把后来发生的背包、HP或冷却变化回滚。

客户端必须为每次**新的逻辑使用**生成一次稳定ID：

```ts
import { CreateOperationId } from "../Generated/SDK";

const operationId = CreateOperationId("item");
await mapClient.useItem({ itemId, operationId });
// 网络超时重试同一次使用时复用operationId；下一次点击必须生成新ID。
```

不能按`itemId`或`ItemConfigId`生成固定operationId，否则后续正常使用会被DBProxy识别成第一次操作的重复请求。

当前事务Planner只支持`Heal`和“`Stack`策略且没有`AddAction`”的Buff；演示道具1001和1002覆盖这两条路径。新增事务Action时，必须同时提供纯数据Planner、操作后持久化Payload、业务回执编码和ACK丢失后的恢复规则，不能直接在`ActionExecutor`里产生副作用后再补保存。Quest的UseItem进度目前是事务成功后的领域投影，不与经济记录伪装成跨域原子提交。

任务奖励事务的Planner当前仍只支持`GrantItem`。把Heal、Buff或跨玩家奖励写进Quest配置会被明确拒绝；新增事务Action前必须实现纯数据Planner、持久Payload和回执恢复规则，不能先改Entity再补一次Save。

## 当前领域内容

| 数据 | 当前行为 |
|---|---|
| 玩家地图、位置、朝向和存活状态 | runtime；同一地图实例才恢复坐标 |
| Numeric动态值 | progression；保存为`numericType -> i64`，TS使用`bigint` |
| Item | inventory；保存稳定ItemId、配置、数量和版本 |
| 金币 | wallet；保存非负余额 |
| Buff | runtime；保存剩余时间、Tick、Action和护盾状态；自身来源映射到新UnitId |
| Skill | runtime；保存GCD、技能CD和道具CD；活动Cast不保存 |
| Quest | quest；保存活动任务、目标进度与已完成配置ID；运行时目标索引重建 |
| Gate、Session、UnitId、Actor InstanceId | 不保存，重新进入时创建 |
| TimerId、Promise、闭包、AOI关系、移动意图 | 不保存，恢复时重建或重置 |

五个Schema分别为`tiangz.demo.player.inventory@1`、`tiangz.demo.player.progression@1`、`tiangz.demo.player.quest@1`、`tiangz.demo.player.runtime@1`和`tiangz.demo.player.wallet@1`。`PlayerPersistenceCodec.ts`使用带显式标签的UTF-8 JSON保存`bigint`，解码后按领域完整校验再交给Entity恢复；DBProxy只看到`Uint8Array`。

登录恢复使用一次`LoadMultiSnapshot`保持五域顺序与缺失空位；周期快照和最终Flush使用一次`SaveMultiSnapshot`。后者不是事务：每个领域独立返回`Applied/Duplicate + revision`或错误。部分成功时组件先推进成功领域revision，再把失败显式抛给周期重试或停机Flush；整批重放复用原requestId，已经成功的领域返回Duplicate。货币、背包、奖励和交易仍使用`ApplyTransaction/ApplyMultiTransaction`，不能为了减少RPC把关键业务改成普通批量保存。

## 增加持久字段

开发新Component时按这个顺序接入：

1. 先判断字段属于`runtime`、普通`snapshot`还是关键`transactional`域。
2. 在TiangZ的`PlayerSaveData`和对应领域DTO中增加纯数据，不把Entity、Component、Timer或Native句柄放进去；一个字段只能属于一个领域。
3. 在`PlayerPersistenceCodec`增加编码后的完整校验；破坏兼容时升级Schema并提供迁移策略。
4. 在`Capture`采集数据，由周期快照/最终Flush或领域事务选择实际写入范围，在`MapComponent.RestorePersistedPlayer`恢复数据。
5. 需要Timer或索引的Component通过`Deserialize`做二次重建，不在Codec中启动业务。
6. 增加Repository自测和真实重启恢复冒烟。

业务Component不能直接创建数据库客户端。更换存储实现时只实现`PlayerRepository`并修改`CreatePlayerRepository`这个唯一工厂点，Handler与领域逻辑保持不变。

## 重启恢复验收

先构建客户端工具。持久化烟测不会给新账号注入测试道具，而是通过任务5003完成“接取 -> 进入地图2 -> 返回NPC -> 领奖”，领取3个1001小红后再消费1个：

```powershell
npm run build:client
node dist/smoke_client.cjs --dbproxy-persistence-write dbproxy_smoke_<timestamp>
```

该命令通过正式任务奖励链路获得3个1001、消费1个、立即断开，并等待Gate的30秒重连宽限结束后保存。命令会按当前快照校验扣除结果；看到写入完成后，只停止并重新启动TiangZ，保持DBProxy、PostgreSQL和Redis运行，再执行：

```powershell
node dist/smoke_client.cjs --dbproxy-persistence-read dbproxy_smoke_<timestamp>
```

通过标准是重新进入后同一Item的数量减少1、版本增加1，且没有重新发放物品。快速纯逻辑回归使用：

```powershell
npm run test:player-persistence
```

UseItem真实事务验收先启动DBProxy和`configs/local/all-in-one-dbproxy.json`，然后执行：

```powershell
node dist/smoke_client.cjs --dbproxy-item-use dbproxy_item_use_001
```

它会使用同一个operationId重复请求并确认1001道具只减少1次。随后只重启TiangZ，保持DBProxy、PostgreSQL和Redis运行，再执行：

```powershell
node dist/smoke_client.cjs --dbproxy-item-use-read dbproxy_item_use_001
```

通过标准是仍恢复同一ItemId、扣除后的数量和首次事务回执，而不是再次扣除或重新治疗。

自动化的交易与故障恢复验收使用：

```powershell
npm run test:player-trade:persistent
npm run test:player-domain-recovery
npm run test:tiangz-fault-matrix
```

第一条命令通过正式NPC商店制造铜币，提交双玩家inventory+wallet事务，重启TiangZ核对结果，并在最终确认前停止首选DBProxy `7800`，验证备用`7801`只提交一次。它还会注入一次提交后响应丢失并查询原始交易回执，再验证两个Endpoint同时不可用时UseItem失败不修改Entity、恢复后复用同一operationId只提交一次。第二条命令依次验证：立即优雅停机的最终Flush；等待周期窗口后强杀all-in-one；在`configs/local/cluster-dbproxy`中精确强杀承载地图100的`map-2`，确认Watcher保持存活并用新PID有界重启MapHost，再由Location代次接管、Gate重新路由和DBProxy快照恢复金币/背包、任务与位置。第三条命令是统一入口，会顺序运行这两组TiangZ验收和独立DBProxy存储故障矩阵；它会重启本地测试容器，只能在测试环境执行。

提交后丢响应的注入由`TIANGZ_TEST_DBPROXY_DROP_RESPONSE_ONCE`控制，只在Debug Rust Runtime中生效，值可以是`transaction`、`multi-transaction`或`any`。它在DBProxy已经返回成功之后让Host Promise失败，模拟“数据库已提交但业务响应没有到达V8”；业务必须通过`LoadTransaction`或`LoadMultiTransaction`用原operationId恢复，不能重新规划第二笔交易。Release构建忽略该注入。

这些命令要求本地PostgreSQL/Redis容器健康、两个DBProxy Debug二进制和TiangZ Debug二进制已经构建。它们创建唯一测试账号但不清库，也不是CPU或容量压测。

## 当前限制

- 周期快照默认30秒，普通成长与运行态最多允许回退一个周期；要求零回退的字段必须进入关键事务，不能缩短周期冒充事务保证。
- 任务奖励、拾取、UseItem、NPC商店和同地图玩家交易已经按实际领域提交；邮件、拍卖行、跨地图交易仍未实现，不能把现有链路描述为全部经济数据生产级不丢。
- 显式配置`lifecycle.restart`的静态MapHost可由Watcher有界重启；Location只删除死亡代次的Actor路由，Gate在下一次进图/重连时改走新Actor。当前不是无感保持原Socket上的战斗现场，也不恢复怪物、仇恨、AI目标、移动意图和动态副本实例。
- 尚无Prometheus DBProxy指标、TLS、令牌轮换和生产部署；Redis/PostgreSQL高可用使用云厂商能力，不在TiangZ内实现。

下一步是DBProxy可观测性、动态地图接管策略、Gate故障转移和生产运维能力；新增经济玩法继续复用领域Revision与多记录事务，不能退回巨型Player Snapshot。
