# DBProxy 尾延迟归因（2026-09-07）

## 当前结论与范围

夜间 r10/r11 最终正确性通过不代表延迟稳定。旧 SDK 的 request duration 从等待连接锁前开始计时，包含共享连接排队；r8 的 9–14 秒不能直接当作 PostgreSQL 执行时间。服务端 RPC 直方图原来的最大有限桶为 1 秒，也不足以区分多秒恢复延迟。

本轮不提高业务超时、不增加连接数、不改变重试策略，不修改 Model/Hotfix 或 WoW335，不操作外网和测试数据。第一步区分客户端排队与持锁请求处理；第二步补齐下述存储阶段。所有指标都是进程侧观察时间，不能声称已经得到纯 SQL 执行时间或完成实际故障根因归因。

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

本轮尚未使用新二进制执行故障长跑；测试证明计时与导出契约，不证明夜间尾延迟已修复。发布依赖仍是相邻 DBProxy 本地集成，远端固定版本的无补丁发布验收另行进行。

第一步实际执行结果（存储分段接入前）：

- TiangZ `npm run verify:quick`：23/23，通过，260,056 ms；包含 TypeScript 100 项、Rust 全目标测试、严格 Clippy 和 codegen。生成物及协议/Core API 锁无新增差异。已存在的 Windows LNK4098 链接警告仍出现，没有忽略测试失败。
- TiangZ `cargo test --bin TiangZ dbproxy --locked -j1`：8 项通过，覆盖新阶段计数及指标导出。
- DBProxy `cargo test --workspace --locked -j1`：通过；27 项真实数据库/故障用例保持 ignored，本轮未执行，不算通过。
- SDK 9 项、服务端库 25 项定向测试通过；其中新增 3 项 SDK 计时测试连续重复 10 轮全部通过。
- DBProxy client/server 全目标严格 Clippy、双方 fmt/diff 检查通过。

未执行本轮 `verify:release` / 完整运行时 `verify`、真实数据库故障测试、7 天长稳和 WoW335 实机客户端验收。本轮没有提交或部署。

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

本步骤仅修改 DBProxy 代码和双方诊断文档；TiangZ 第一阶段代码保持不变，未重新执行其 quick 门禁或 codegen。仍未执行真实数据库故障、完整发布门禁或长稳测试，没有提交/部署，也未修改 WoW335。下一步应重建候选，在资源允许的短时受控场景中采样上述指标，再决定是否需要性能修复，不以模拟测试通过宣布夜间尾延迟已解决。
