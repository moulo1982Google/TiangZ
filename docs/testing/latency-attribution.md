# DBProxy 尾延迟归因（2026-09-07）

## 当前结论与范围

夜间 r10/r11 最终正确性通过不代表延迟稳定。旧 SDK 的 request duration 从等待连接锁前开始计时，包含共享连接排队；r8 的 9–14 秒不能直接当作 PostgreSQL 执行时间。服务端 RPC 直方图原来的最大有限桶为 1 秒，也不足以区分多秒恢复延迟。

本轮不提高业务超时、不增加连接数、不改变重试策略，不修改 Model/Hotfix 或 WoW335，不操作外网。第一步区分客户端排队与持锁请求处理；第二步补齐下述存储阶段；第三步已完成提交后本机 30 分钟验证，仅重置演练专用数据，结果见本文末尾。所有指标都是进程侧观察时间，不等于纯 SQL 执行时间。

## 新增指标及边界

`tiangz_dbproxy_request_stage_ms` 是累计 Prometheus histogram，固定标签为 process、endpoint、stage：

| stage | 覆盖范围 | 不应误解为 |
|---|---|---|
| connection_queue | 单次 SDK attempt 等待共享连接锁；可能排在其他请求或重连之后 | 服务端 SQL 等待 |
| connection_exchange | 获得连接锁之后至 attempt 结束，含检查、编解码、网络与服务端处理 | 纯网络或纯 PostgreSQL 时间 |

每个已结束 attempt 两阶段各计一次，包括成功、超时、远程错误，以及拿到失效连接后未发送的失败。重试是新 attempt。重连仍看原 connection attempts/duration；外层 Host 调度、首次建池和整个业务的多次重试不在两阶段总和内。future 被外部取消时没有完成回调，不计作成功，也不补造完成样本。这是完成样本分布，不是所有进入系统请求的全量延迟。

SDK 新增默认 `ClientObserver.request_attempt_timed`，默认只向原 `request_attempt` 转发一次，两段之和保持原总耗时语义。TiangZ 覆盖新回调同时维护原计数；旧观察者无需修改。无协议/codegen/Core TypeScript API 变化。

有限桶为 0.1、0.5、1、5、10、50、100、500、1000、2000、5000、15000 ms，另有 +Inf。热路径每阶段只增一个固定桶和 sum，无请求级分配、锁、日志或玩家/记录/幂等 ID 标签。8 个端点上限下新增至多 240 条序列，采集时才构造快照。并发采集时 sum 与桶可能有极小时间偏差；count 来自同一组桶快照，保证累计桶不超过 count。

DBProxy 的 `dbproxy_rpc_duration_seconds` 保留原桶并新增 2、5、15、30 秒，按固定 operation 聚合。服务端耗时仍可能含缓存与存储排队，不等于 SQL 时间。升级期间聚合新旧节点的直方图，要等所有节点使用相同桶结构后再比较。

## 如何使用

在同一时间窗口比较分布，累计计数必须做 rate/increase，不能用整晚累计均值解释某一分钟尖峰：

```promql
histogram_quantile(0.99,
  sum by (process, endpoint, stage, le) (
    rate(tiangz_dbproxy_request_stage_ms_bucket[5m])
  )
)
```

不要把各阶段 p99 相加或相减来还原某一个请求。样本不足或分位目标落在 +Inf 时，有限桶不能给出精确尾部值；同时检查 count、sum 和超出最高有限桶的数量。

- queue 升高：查同连接前序请求、重连与路由热点，不直接加数据库连接数。
- exchange 与服务端 RPC 同时升高：查存储/缓存路径及机器调度，仍需子阶段证据才能归因于 SQL。
- exchange 高但服务端 RPC 不高：继续检查网络、运行时调度和发送/接收。两侧不是逐请求关联，不能直接判定网络故障。
- SDK 两阶段不高但游戏 RPC 高：复用 `tiangz_scene_latency_ms`、Actor mailbox 队列、游戏探针与资源采样，检查 SDK 以外的等待。

本机执行器已开启 Scene 延迟采样（sampleRate=10），每分钟保存 `/metrics` 原文。新指标由同一采集器保留，不加全量请求日志。必须重建并 prepare 新轮次，不能把新指标解释成旧 r10/r11 已包含的证据。

## 精准验证

SDK 的 loopback 协议用例先持有共享锁并手动 poll，确认请求已排队，再允许其发送；服务端收到请求后通过独立信号控制回包。两阶段分别检查对应事件的时间上下界，不依赖机器绝对速度。另覆盖超时后未发送失败和旧观察者恰好一次回调。

TiangZ 覆盖固定桶零值/精确边界/溢出、并发计数、原指标不重复计数、非法端点不增加标签，以及 Prometheus 累计桶/count/sum。DBProxy 服务端用 1–31 秒合成耗时检查尾部桶和失败计数，不实际等待 31 秒。

前两步尚未使用新二进制执行故障长跑；当时的测试证明计时与导出契约，不证明夜间尾延迟已修复。发布依赖仍是相邻 DBProxy 本地集成，远端固定版本的无补丁发布验收另行进行。

第一步实际执行结果（存储分段接入前）：

- TiangZ `npm run verify:quick`：23/23，通过，260,056 ms；包含 TypeScript 100 项、Rust 全目标测试、严格 Clippy 和 codegen。生成物及协议/Core API 锁无新增差异。已存在的 Windows LNK4098 链接警告仍出现，没有忽略测试失败。
- TiangZ `cargo test --bin TiangZ dbproxy --locked -j1`：8 项通过，覆盖新阶段计数及指标导出。
- DBProxy `cargo test --workspace --locked -j1`：通过；27 项真实数据库/故障用例保持 ignored，本轮未执行，不算通过。
- SDK 9 项、服务端库 25 项定向测试通过；其中新增 3 项 SDK 计时测试连续重复 10 轮全部通过。
- DBProxy client/server 全目标严格 Clippy、双方 fmt/diff 检查通过。

第一步结束时未执行 `verify:release` / 完整运行时 `verify`、真实数据库故障测试、7 天长稳和 WoW335 实机客户端验收，尚未提交或部署。

## 第二步：存储路径分段

新增 `dbproxy_storage_stage_seconds`（累计 histogram）和 `dbproxy_storage_stage_in_flight`（采集时仍在阶段内的数量）。只使用固定 stage 标签，全部请求分片共享聚合计数；不输出 shard、玩家、记录、SQL、凭据或幂等 ID。

| stage | 精确计时边界 |
|---|---|
| cache_lookup | Tiered 缓存读取/批量读取及复查，包括缓存连接锁等待与缓存超时 |
| cache_write | 缓存写入、批量写入、负缓存写入和删除，包括回源预热与修复写入 |
| fallback_capacity_wait | 等待回源信号量，结束于拿到配额、失败或取消；不包含持有配额的查询时间 |
| fallback_key_wait | 等待进程内同记录门闩，含弱引用表维护；不包含持锁期间的查询 |
| fallback_distributed_lease | Redis 分布式回源租约协调，包括重试、轮询及协调内部的缓存复查 |
| fallback_lease_release | 释放已取得的 Redis 回源租约，含失败/超时 |
| postgres_connection_wait | PostgresSnapshotStore 等待共享连接锁，取消排队也记录 |
| postgres_operation | 拿到连接锁后至本次快照/事务/回执操作退出，包含重连、数据库协议、SQL 和数据库内部锁等待 |
| committed_cache_sync | 已提交记录的 best-effort 缓存同步整体，包含 cache_write 和 cache_repair_ack；一次批量同步只算一份样本 |
| cache_repair_ack | Redis 更新成功后确认 PostgreSQL 修复任务，包含该 ACK 的 PG 连接锁等待、重连与 SQL |

`committed_cache_sync` 是父阶段，不可再与 cache_write、cache_repair_ack 相加。ACK 使用独立阶段，不重复计入 postgres_operation。分布式租约内部的缓存复查计入协调阶段；普通 Tiered 复查计入 cache_lookup。批量、多次复查、后台预热和缓存修复使阶段样本数量不等于游戏请求数量，也不能相减两组 p99 来得到单个请求的耗时。

快照保存、批量保存、普通/多记录事务、CommitRecords、旧 Trade 及回执读取均经过计时的 PostgresSnapshotStore 边界，SQL 和事务顺序未改变。启动迁移使用独立的未导出指标，随后才绑定请求分片共享指标；专用维护连接的 Outbox/修复队列轮询不混入此 PostgreSQL 阶段。通过请求分片执行的回源预热、修复读取仍会被聚合，本指标不区分前后台流量。

计时器在作用域退出时统一记录，正常返回、错误、提前返回、future 超时取消都不会泄漏 in_flight。取消样本仅代表取消前已经等待的时间，是截断观测；不表示数据库查询已经停止、已经回滚或已经提交。这里的 histogram count 不是成功计数，必须同时查看原 RPC 错误/缓存错误/回源错误指标。SDK 第一阶段仍只记录已结束 attempt，两层取消采样口径不同。

固定有限桶为 1/5/10/25/50/100/250/500/1000/2000/5000/10000/15000/30000 ms，导出为秒，另有 +Inf。10 个阶段共 180 条序列（每阶段 15 个桶、count、sum、in_flight）。热路径只读单调时钟并更新固定原子计数，不分配、不额外请求 Redis/PG、不新增请求日志。冷路径沿用存储 poller 更新快照；HTTP 抓取不会重新查询数据库，也不对累计值重复累加。in_flight 是上次 poll 的采样值，不是 HTTP 请求时的实时状态；sum 与桶在并发采集下可能轻微错位。

查询示例（结果单位为秒）：

```promql
histogram_quantile(0.99,
  sum by (instance, stage, le) (
    rate(dbproxy_storage_stage_seconds_bucket[5m])
  )
)
```

先看客户端 queue，再看 PG connection_wait 与 operation；缓存故障时对照 committed_cache_sync、cache_write、cache_repair_ack，读取故障时对照配额/同键/分布式租约等待。真正的根因结论仍需下一轮使用新二进制的受控验证。

第二步精准用例覆盖：固定桶边界/溢出、多线程累计/重复采集、失败与取消收尾、真实回源配额超时和同键等待、重复 poll 替换而非累加、Prometheus 单位与无穷桶。另以私有 loopback PG/RESP 端点调用真实 Store 方法，证明 PG 排队取消不计入查询阶段、查询取消保留耗时、缓存失败不尝试 ACK、缓存成功而 ACK 卡住时两个阶段可分辨。模拟端点不执行 SQL、不做迁移、不访问本机 Docker 数据，不证明真实 PostgreSQL 事务或 Redis 持久性。

第二步最终验证：DBProxy `cargo test --workspace --locked -j1 --quiet` 共 **124 通过、0 失败、27 ignored**；其中 storage 库 21 项、server 库 26 项。新加的三个真实调用路径模拟测试再重复 10 轮全部通过。workspace 全目标严格 Clippy、fmt 与双方 diff 检查通过。最后复核保留了原启动顺序（PG 连接/迁移 → Redis 连接 → 回源协调器配置验证），不借观测改动调整初始化失败语义。

第二步仅修改 DBProxy 代码和双方诊断文档；TiangZ 第一阶段代码保持不变，当时未重新执行其 quick 门禁或 codegen，尚未执行真实数据库故障、完整发布门禁或长稳测试，没有提交/部署，也未修改 WoW335。后续按下述第三步验证，不以模拟测试通过宣布夜间尾延迟已解决。

## 第三步：提交后本机 30 分钟验证

结论：**恢复与最终数据正确性通过，缓存故障延迟问题复现，尚未实施性能修复。**

- 冻结候选：TiangZ `ba2bc3d`、DBProxy `69ef4f9`，prepare 时两个工作区干净。双方 release 串行重建，TiangZ 正常 Model/Hotfix、游戏配置和两项业务探针重建通过；codegen 未留下生成物或协议/Core API 锁差异。保留既存 Windows LNK4098 警告。
- 前置检查：DBProxy 默认工作区 **124 通过**；另外显式运行全部 **27 项真实 PG/Redis 用例**通过（12 快照/Redis、6 Outbox 并发、1 Relay、7 故障矩阵、1 网络集成），不是把 ignored 算通过。控制器/资源采集 Node 测试 **7 项通过**。
- 证据：工作区 `.build-tmp/local-validation/20260907-latency-30m-r12/`；manifest 保存提交、候选文件 hash 和空工作区 patch。日志及两个只读分析脚本留在证据目录，不入 Git。
- 北京时间 **2026-09-07 09:43:55 至 10:13:55** 的计划负载，10:14:15 完成最终对账，控制器退出码 0；随后 `audit_local_validation.mjs` 再次通过。
- 100 名游戏玩家（两地图各 50）+ 独立 100 名持久化探针玩家 + 通用 Relay。不是 200 名游戏玩家或容量基线。
- 五次故障：cache → PostgreSQL → 可靠 Redis → AOF → cache；每次基础恢复后要求两轮原账号业务成功及交易复核。没有注入 MapHost/Location/DBProxy 进程/动态副本故障，本轮不替代既有完整矩阵。

本轮仅清理 `dbproxy_local_validation`、`dbproxy_local_contracts` 和本机两只演练 Redis 的测试数据；原 `tiangz` 数据库、历史证据、外网及 WoW335 不动。被重置的测试数据没有在本轮另做备份。结束后自启游戏/DBProxy/探针进程均已回收，测试数据库容器恢复健康并保留数据。

### 正确性与错误证据

| 检查 | 结果 |
|---|---|
| 持久化读取 | 199,362 次；旧读、缺失、不变量错误均 0 |
| 排队快照 | 33,708 次成功，492 次故障错误 |
| 普通事务 | 16,165 次首次应用、2 次重复回执、417 次故障错误 |
| 旧 Trade 探针 | 1,296 次首次应用、2 次重复回执、2 次错误 |
| AOF backlog | 64 条成功确认，重启后 64 条逐条 PG 校验通过 |
| 通用 Outbox | 提交/SQL 已发布/实际 Stream 去重均 795；死信 0；Relay 重试 12 次 |
| 通用记录与事实 | 1,590 份快照的 revision/payload 匹配；795 条不可变事实匹配 |
| 游戏 CommitRecords 交易 | 2 笔审计与对应已发布事件、实际 Stream 及资产复核匹配 |

19 次读取领先探针本地版本不是旧读；故障结果未知和重试会使服务端与本地确认进度不同，最终探针收敛断言通过。不能用领先计数单独证明成功，也不抹去错误计数。

故障窗口共 7 份地图分片结果不健康。PG 恢复初期第 20 轮另有一次登录 `10003: player is completing offline; retry login`，控制器记录一次恢复重试，再用同账号连续两轮验证通过。该失败发生在登录阶段，没有完整 RESULT_JSON；不能因所有已输出的非故障分片结果都健康就漏报它。正常稳定窗口没有失败，但不能写成“全程零错误”。

### 新指标给出的归因

分析逐个端口的相邻采样差值；未检测到计数回退，本轮没有重启应用进程。按故障开始到业务恢复的时间段标记与其相交的采样窗口，故障边缘混有少量正常流量；同类故障的聚合是多个不连续窗口之和，不是两个端点间的整段累计。以下 p99 是桶范围，不是精确值；不相减、不相加两阶段 p99。

1. **缓存故障可重复放大尾延迟。** 两次停机游戏业务 p99 分别约 3.70–4.10 秒、3.95–3.99 秒。两节点 `cache_write`/`committed_cache_sync` 的 p99 均落在 2–5 秒桶；相交窗口的缓存写阶段分别有 283/97 份超过 1 秒的样本，PG operation 超过 1 秒的样本均为 0（PG p99 在 100–250 ms 桶），缓存修复 ACK 也无超过 1 秒样本。地图客户端连接排队同时显著上升，p99 分别进入 2–5 秒、5–15 秒桶。
2. **PG 停机是另一种等待形状。** 09:52:12–09:53:12 的主节点 PG connection_wait 为 94 份样本、均值约 4.62 秒、p99 在 10–15 秒桶；另一节点 60 份样本、均值约 4.25 秒、p99 在 5–10 秒桶。持锁 PG operation 该窗口 p99 在 2–5 秒桶。说明重连/失败处理期间连接排队本身不可忽略，不能把整个耗时归给 SQL。取消样本仍是截断观测，不推断底层事务是否已完成。
3. **可靠 Redis 与缓存 Redis 的影响不同。** 可靠 Redis 停机的标记游戏窗口仍健康；09:58:12–09:59:12 地图客户端 exchange 无超过 1 秒样本，排队写和 MQ 发布则出现故障重试。最后发布和数据对账通过，不代表停机期间排队服务一直可用。

代码与采样相符：`TieredSnapshotStore::synchronize_committed_cache(_multi)` 在 PG 提交后仍等待有超时的缓存写入；失败时留下事务内已持久化的修复任务。此次证据支持“缓存等待 + 客户端共享连接排队”是缓存停机长尾的重要来源，但不是逐请求 tracing，也没有拆出纯 SQL 时间。

正常非故障已完成分片结果的最差业务 p99 为 285.582 ms，最后一轮为 18.298/24.737 ms；本轮未复现 r8/r11 正常窗口秒级尾延迟。整机 CPU 峰值约 67.01%、最低可用内存 **3.454 GiB**，与旧轮次资源压力不同，不能据此认定旧问题已修复。

### 日志、资源与下一步

采样间隔最大 5.128 秒；资源保护触发 0、CPU/内存压力抓取 0、指标采集缺失 0、日志丢弃 0，证据总量约 **149.8 MiB**（包含冻结二进制/资源，不是纯日志）。本轮 30 分钟不构成 7 天磁盘容量证明。

下一步优先评估缓存不可用时的快速降级/有界同步预算，以及 PG 不可用时的连接排队控制；必须保留持久化修复、revision 防旧读、结果未知幂等恢复和现有故障断言。不要单纯提高业务超时或增加连接数掩盖问题。本轮只提交并验证观测代码，未顺带实施性能策略。

## 2026-09-07 换机续接：PG 请求排队

相邻 DBProxy 基于 `c126b80` 继续实施 PG 排队控制；此前缓存单次操作预算已经独立为 200 ms。本次 `storage.postgresConnectionWaitTimeoutMs`、`storage.postgresReconnectCooldownMs` 默认分别为 2,000 ms 和 500 ms，分别限制请求分片取得连接前的等待，以及同一连接失败/取消重连后的再次尝试。

旧实现的精确用例证实：持有连接锁时请求超过外层 900 ms 仍未返回；4 个并发等待者产生 4 次失败重连。修改后等待者超时退出且没有发送 SQL，共享失败冷却减少重复连接。PG SQL/事务执行、2 秒建连和原 2 秒回源预算保持原语义。提交后修复 ACK 仅增加连接排队预算，失败保留已提交结果及修复目标。独立维护连接不采用请求预算；Worker 调用请求分片保存/回源时按原错误重试路径处理。

真实 PG 用例已验证：服务器确认在途 SQL 被锁阻塞后，排队者先超时；在途事务可继续提交，主动取消可回滚且后续事务复用连接；服务器发出 COMMIT 成功消息后丢失回包，原 ID 查回回执、重试返回 Duplicate，快照版本、事实和 Outbox 各只产生一次。最终 DBProxy 默认测试 136 项通过、31 项 ignored；另按套件隔离状态显式运行全部 31 项数据库/故障测试通过，包括原 AOF、缓存重启、恢复和 Relay 并发契约；严格 Clippy 与格式检查通过。

初始 500 ms 排队候选在新机器健康并发测试中失败；临时 30 秒预算仅用于诊断。最终 2 秒默认值下，同一分片 16 个并发写入者连续两轮各 64 次保存全部成功，排队均值分别为 908.797 ms 和 892.183 ms，p99 均在 (1,000, 2,000] ms 桶。工作区 `.build-tmp/pg-queue-20260907/` 保留最终验证、候选失败及套件复用旧 Relay 路由导致启动拒绝的日志；失败记录未被覆盖，也未关闭路由校验。

DBProxy `cargo build --workspace --release --locked -j1` 通过；双仓库 diff 检查与 TiangZ 本机痕迹门禁通过。未改生成输入、未运行 codegen；TiangZ release、正常 Model/Hotfix 与探针尚未重建。

本轮 TiangZ 只同步上述存储行为与验证状态，未修改协议、Core、Host、Model/Hotfix 或 WoW335。新机器完整游戏负载、短跑/30 分钟对比、最终 SQL/Stream/资产对账尚未执行，因此没有新的游戏 p99 或容量收益结论；旧 r12/r13 数值不能作为本次实现的验收。详细配置与后续状态见相邻 DBProxy 的 `docs/postgres-request-budget.md`。

本步骤未重新执行完整 `verify:release` / 运行时 `verify`、7 天长稳、远端无本地 SDK 补丁发布或 WoW335 实机验收；第一步 quick 的记录只代表当时执行，不冒充第三步重跑。

## 第四步：缓存预算分离后的 r13 验证

DBProxy 将缓存操作预算独立为 `storage.cacheOperationTimeoutMs=200`，PG 回源仍为 2,000 ms，AOF/MQ、业务超时和修复 ACK 不变。实现及兼容性详见相邻 DBProxy 仓库 `docs/cache-operation-budget.md`；本轮 TiangZ 只改诊断文档，不改业务/协议。

`20260907-cache-budget-30m-r13` 在北京时间 2026-09-07 12:22:06–12:52:06 跑完 30 分钟，12:52:29 完成最终对账，控制器和保存证据审计均通过。候选是 TiangZ `36f0fbf` / DBProxy `f2acd14` 之上的未提交修改，以 manifest 的 patch/二进制 hash 为准。两边 release 和正常业务包重建，Model/Hotfix 指纹与 r12 相同，无生成物或协议/Core API 锁差异。

同样 100 名游戏玩家 + 100 持久化探针，cache/PG/可靠 Redis/AOF/cache 五次恢复通过。两次缓存停机的业务 p99（地图 1/100）分别为 118.358/35.824 ms、30.850/286.470 ms；r12 对应为 3698.529/4100.462 ms、3986.178/3952.958 ms。四份缓存故障分片均健康，查询/业务传输错误 0。缓存写和提交后同步 p99 均从 2–5 秒桶降至 100–250 ms 桶；地图 SDK 排队 p99 为 100–500 ms 桶，无超过 1 秒排队样本，但 exchange 仍有合计 5 份超过 1 秒的样本。不是端到端 200 ms 保证。

最终 200,196 次读取无旧读/缺失/不变量错误；813 条通用事件全部发布并与实际 Stream 去重顺序一致，1,626 份快照、813 条不可变事实及 2 笔交易审计/资产匹配；AOF 64 条成功确认记录重启后逐条 PG 对账通过。PG/AOF 故障共 4 份不健康分片，PG 恢复有一次登录 10003、随后原账号重试及连续两轮恢复通过，错误没有抹去。普通事务/排队写/旧 Trade 的故障错误详见 DBProxy 报告与 SOAK_FINAL。

资源最低可用内存 5.206 GiB、CPU 峰值 55.45%，日志丢弃/指标缺失/资源守卫均 0，证据约 149.4 MiB。资源条件优于 r12，不能把两轮数值差异解释为严格容量基准。PG 停机的连接等待 p99 仍可在 15–30 秒桶，AOF 阶段仍出现约 3–4 秒业务长尾；下一步是独立评估 PG 排队，不宣布所有延迟问题已解决。

DBProxy 默认 128 项、真实数据库 28 项、控制器 7 项通过，严格 Clippy 和构建通过；TiangZ 执行类型检查/codegen/构建和本机痕迹门禁，未重跑完整 quick/release/runtime 或 WoW335 实机验收。测试进程已回收，数据库容器保持健康，外网和历史证据未改动；只重置了本机演练专用测试数据，没有另备份这些被重置的数据。
