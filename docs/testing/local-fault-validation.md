# 本机精确回归与低内存故障验证

日期：2026-09-06。范围：TiangZ 当前 Model/Hotfix/Host 集成、DBProxy 当前通用提交/Outbox；不改变远程七天演练，不修改 WoW335 业务。

## 已定位问题与回归

- 首次 20 玩家短跑因 PG 故障后的 revision 冲突失败，证据保留于 `20260906-smoke2`，没有判为通过。定位到批量快照 ACK 丢失后，跨周期重试丢掉了原始请求；新增 `player_snapshot_recovery` 精确回归，保留未确认请求、先恢复后捕获、部分结果处理及跨图保护。后续必须使用重建后的包重新演练。

- `location_recovery_race.test.ts`：强制旧快照在删除之前、之后和重复到达；保存失败解锁后再成功删除；Location 重启重建；新 Actor 显式注册；所有者换代；重复 Unit/角色导致批次拒绝。旧实现 9 项中失败 5 项，修复后全部通过。
- Location 不引入无限增长的墓碑。只有首次 owner generation 报告重建缺失记录，正常同代重报不创建记录。已有不同记录仍拒绝，moving/removing 状态不被恢复为 active。新增低基数 `recovery_suppressed_entries_total`。
- `map_probe_load`：登录前先启动生产使用的 reader 分发，3 个 TCP 用例覆盖先到 Push、随后 RPC、错误 rpcId/业务错误/EOF、连续 Push 不延长登录期限。
- `business_recovery.test.ts`：无业务证据、单图失败、换账号、故障前启动的旧轮次、重复证据不能算业务恢复。外网执行脚本新增两轮同账号恢复要求，仅修改源码，不影响远程已部署脚本。
- 既有 `map_offline_receipt` / `gate_logout` / Location / Gate 重连测试一起回归。没有把超时当作死亡证明，没有新增未经所有权校验的清理接口。
- Map 完成 Location 删除与下线回执后立即移出玩家目录，只延迟 Actor/AOI 销毁，避免目录继续参与恢复快照。失败路径不提前移除。
- 真实数据库补验 26 项全部通过。DBProxy Redis Publisher 首次连接及重连显式设置 3 秒响应超时，覆盖最长 2 秒 WAITAOF；750 毫秒延迟确认回归防止退回客户端默认 500 毫秒。

## 本机环境与启动

### 3 小时首轮失败及修正（2026-09-06）

`20260906-3h-r1` 于北京时间 12:33:18 开始，12:52:27 失败，仅运行约 19 分钟，不是长测通过。PG/cache/可靠 Redis 各一轮业务恢复通过；缓存恢复窗口有 703 次低于已确认版本的读取，随后 AOF 前置检查因 pending=0 终止，没有进入后续进程矩阵或最终对账。

旧读已用真实数据库定向测试复现：缓存 Redis 仅关 AOF、遗漏 RDB，重启会恢复旧快照及 freshness 标记。测试先保存旧缓存磁盘镜像，强杀缓存，在停机期间提交并确认 revision 2，重启后不启动 repair worker、不重放写入，立即读取：旧部署返回 revision 1，新部署返回 revision 2。缓存现关闭 AOF/RDB 且 `/data` 使用 32 MiB tmpfs，即使意外执行 SAVE 也不能跨容器重启恢复。执行器在任何测试清理或启动前核对实际 CONFIG 和挂载，不能只相信 Compose 文件。

AOF 阶段改用 `dbproxy_aof_probe`：PG 停机后经真实 RPC 入队 64 个隔离记录，保存每个成功确认的 request ID；重启前后通过独立连接观察 pending+processing，避免将已领取队列或过期指标误认成丢失；恢复 PG 后直接逐条核对权威快照的 revision、schema 和 payload。队列数量只是辅助证据，逐条 PG 对账才是最终断言。任何 RPC 确认失败都判本阶段失败，不伪造成功收据。

持久化探针记录前 16 个旧读的记录键及版本；控制器解析每分钟报告，发现旧读/快照缺失/不变量错误即停止，不等最终对账。计数不重置，日志不丢弃。

短跑可使用 `--run <run-dir> 600 100 cache,aof 10000`，依次验证缓存和 AOF，故障间隔 10 秒（仍保留每次恢复的两轮原账号检查）；正式长跑不传后两个参数，恢复完整十场景和 180 秒间隔。实际计划写入 started.json。短跑不能替代后续全链路长测。

修正后的 `20260906-recovery-smoke5` 已完成：100 游戏玩家 + 100 持久化探针，420 秒负载，AOF/cache 两轮故障，最终报告时间北京时间 17:00:12。44,580 次读取，旧读/缺失/不变量错误均为 0；7,936 次入队确认、3,646 次首次事务应用、1 次幂等重复、300 次探针交易通过。故障期间 164 次入队错误及 51 次事务错误保留在报告中，不作为成功吞掉。64 条专用 AOF 快照重启后逐条验证；179 条通用 Outbox 全部发布且与实际 Stream 一致，无死信；358 条通用快照、179 条追加事实及游戏交易审计/资产对账通过。全轮采样可用内存最低约 4.20 GiB，日志丢弃采样为 0。

本次 TiangZ quick 23 项通过（含 97 项 TS 测试与 Rust 测试）；DBProxy 默认工作区 111 项、真实数据库 27 项通过，clippy/fmt 通过。此轮没有再改 Core API 或游戏协议，未重新执行完整 release 门禁；上轮 release 的通过记录不冒充本轮执行。

本轮 `npm run verify:release` 的完整 9 阶段发布门禁已通过，补上快照结果未知修复后再次全通过（其中 quick 23 项；TS 覆盖率运行 97 项）。DBProxy 默认 Rust 工作区 110 项通过、额外真实数据库 26 项通过，TypeScript SDK 18 项通过，严格 clippy 通过。它们是长跑前置证据，不替代长跑结果。

`20260906-smoke3` 的 100 玩家 6 分钟短跑已通过：PG 停机后原账号连续两轮恢复成功；500 条通用快照、250 条追加事实、250 条 Outbox 及实际 Stream 去重消息一致，无死信；游戏交易资产、审计与 Stream 校验通过。最终证据时间 2026-09-06 12:27:37（北京时间）。该短跑只注入一轮 PG 故障，其余进程/Redis/动态副本场景仍由正式 3 小时矩阵覆盖，不能提前宣称通过。

仅使用 `tiangz-dbproxy-local` Compose 项目的 PostgreSQL、可靠 Redis、可淘汰 Redis 缓存，端口只绑定回环地址。

```powershell
# 在相邻 DBProxy 仓库的 deploy/local 下执行；.env 不入库。
docker compose --env-file .env -f docker-compose.yml -f docker-compose.laptop.yml -f docker-compose.validation.yml up -d postgres redis cache
```

PostgreSQL 限制 1 GiB/shared_buffers 128 MiB/max_connections 30；可靠 Redis 限制 384 MiB/maxmemory 256 MiB/noeviction/AOF；缓存 Redis 限制 192 MiB/maxmemory 128 MiB/allkeys-lru。无需 Grafana、Prometheus 常驻，保留服务原始日志和指标。其他项目容器不在范围内。

执行器显式设置 `RUST_LOG=info`，不继承终端可能残留的 warn/off。原始指标包含全部游戏进程与两个 DBProxy 节点；游戏日志丢弃计数非零即不允许将验证判为通过。故障注入期间另起一轮明确标记的游戏流量，该窗口可记录失败；恢复后的两轮仍严格要求成功。

先串行编译，避免 V8 链接与多个 Rust 构建挤占笔记本内存：

```powershell
# TiangZ
cargo build --release --locked --bin TiangZ --bin map_probe_load --bin validation_resource_snapshot -j1
npm run build
npm run build:test:player-trade-persistence
npm run build:test:dynamic-map-fallback
# DBProxy
cargo build --release --locked --workspace --bins -j1
```

夜间 r8～r11 使用 normal Model/Hotfix 包；发布门禁中的 bench/debug 测试可能改写 dist，准备演练前须重新执行上述 normal 构建，不能混用不同模式的模型和热更包。

`run_local_validation.mjs --prepare <run-dir>` 是显式清理入口：只重建 `dbproxy_local_validation` 和 `dbproxy_local_contracts` 两个测试库，清空该项目的两只 Redis。原 `tiangz` PostgreSQL 数据库、其他项目和远程数据不清理。运行目录必须位于工作区的 `.build-tmp/local-validation/` 下；已有 manifest 拒绝覆盖。

`--contracts <run-dir>` 使用独立 contracts 库执行默认 Rust 测试及所有真实 PG/Redis 存储、Outbox 租约/并发、故障矩阵；不能将 ignored 当成通过。旧交易 Outbox 综合测试另建唯一 schema，不再修改其他用例遗留事件。

`--run <run-dir> 10800 100` 启动 3 小时、100 游戏玩家、100 持久化探针玩家及持续通用 Relay 探针。先用短时运行验证脚本；长跑重新 prepare 到新目录。脚本不自动构建，不占用已有监听端口。运行前冻结二进制、Model/Hotfix、游戏配置和导航资产，并记录 hash、HEAD、工作区差异；后续源码修改不进入运行中版本。

## 验证矩阵

### MapHost 重启后的两阶段恢复

`20260906-3h-r2` 在 17:35 因 map2 恢复检查提前停止，仅运行约 32 分钟。其 211,700 次读取没有旧读或快照缺失，64 条 AOF 对账通过，但未执行最后四项进程故障和最终全量对账，不能判为长测通过。

故障后旧 Actor 路由失效，Gate 按既有策略将原地图 100 的账号安全回退地图 1；原探针只发一次 EnterMap，后续反复重登又恢复安全地图会话，因此六轮业务全部可用但目标地图断言失败。服务器策略不因压测修改。

Rust 探针新增显式 `--recover-from-map 1`：首次 EnterMap 完成回包、MapReady 和必要的快照握手后，若实际进入指定安全地图，在**同一账号、同一连接**再请求一次原目标地图；最多一次，不无限重试、不更换账号。意外地图、意外实例、二次仍未到目标均失败。RESULT_JSON 的 mapRecovery 保存安全地图、回退人数和重进人数；本机执行器仍要求全员最终 mapId/mapInstanceId 与目标一致，且所有回退玩家重进成功，再运行完整移动/查询/业务检查。默认不带该参数时其他压测调用行为不变。

回归用真实 TCP fixture 覆盖直接进入目标、安全回退后重进、意外地图拒绝、第二次仍回退拒绝；额外短测优先运行 `map2,location,dbproxy1,dbproxy2,dynamic`，避免完整长跑尚未覆盖的场景一直被前序检查挡住。

`20260906-process-smoke6` 的上述五类进程故障各通过一轮，但第二次 map2 重启后暴露了真实的 Gate 孤立会话问题：旧 Actor 已丢失，Gate 仍等待不可能出现的离线成功回执，账号卡在 removing，最终于北京时间 18:57:55 失败。该轮不是最终通过，92,582 次持久化读取虽无旧读/缺失，也不能替代游戏恢复结果。

针对性修复：Core 缺失 Actor mailbox 返回已有 `ActorLocationNotFound` 错误码，不能与任意 HandlerFailed 混同；Gate 只在已断开的超时会话、明确缺失 Actor、原宿主回执查询可达且身份匹配但未完成、Location 按角色确认无主时清理本地孤立路由。主动登出成功仍需保存证据。新增正反向测试在旧代码上两项失败、修正后通过，保护存储失败/网络失败/仍有所有者/活连接等不得释放的边界。

矩阵新增 `map2-orphan`：宿主停机 45 秒，再重启等待 30 秒，期间不以立刻重登掩盖最终下线卡死，之后仍以两轮原账号回到目标地图验证。完整默认矩阵现为 11 种故障。

上述修复于 2026-09-06 19:08 完成 `npm run verify:release`：严格版本/协议/Core API 门禁通过，quick 23 项、全流程 9 项通过，TypeScript 100 项通过。Rust 地图探针 16 项测试和 Clippy 通过；构建链已运行 codegen，未手工修改生成物。发布检查通过不代替下述真实故障演练结果。

`20260906-process-smoke7` 于北京时间 19:10:57 开始，19:26:21 完成最终对账，15 分钟/100 人验证通过。`map2-orphan,map2,location,dbproxy1,dbproxy2,dynamic` 六项各执行一次，每项两轮原账号恢复和交易复核通过，无恢复重试。孤立会话场景真实记录 50 次受限 Gate 路由清理；动态副本丢失后的原账号安全回退通过。故障注入窗口有两份不健康地图分片结果，按设计保留，不能说整个过程没有错误。

最终持久化读取 106,767 次、排队写 17,900 次、事务应用 8,869 次、旧 Trade 应用 700 次，旧读/缺失/一致性错误均为 0。通用 Relay 提交并实际发布 430 条事件，SQL published=430/dead=0，去重后 Stream 连续序号 430 条，860 份快照与 430 条不可变事实匹配；三笔游戏 CommitRecords 交易的审计与实际消息流匹配。日志丢弃计数 0，采样最低可用内存 3.86 GiB，证据目录约 109 MiB。该轮 DBProxy 默认测试 111 项、真实数据库契约 27 项全部通过。此次短测未注入 PG/Redis/AOF 故障，需由后续完整 3 小时矩阵覆盖，不替代长测结论。

| 层 | 负载/故障 | 证据 |
|---|---|---|
| 游戏 | 账号注册、角色入图、移动、查询、使用物品/业务、反复同账号重连 | 每轮两张地图完整结果，不换账号 |
| 交易集成 | 两玩家金币与物品互换，新 CommitRecords 审计/事件，同账号重连核对 | 客户端资产断言、SQL/Stream 审计 |
| DBProxy 旧接口 | 快照、排队快照、事务、旧 Trade，独立正确性探针 | 已确认版本不倒退、无缺失、最终对账 |
| DBProxy 新接口 | 每两秒两记录 CAS + 不可变事实 + 通用事件，同请求重复提交 | Duplicate 回执、逐记录读取、最终 SQL/Stream 对账 |
| Relay | game/achievement 共用同一 Publisher/Stream/partition | 去重后连续序号，无丢失/逆序，积压完成发布 |
| 故障 | PG 超过重连宽限期停机、可靠 Redis/cache 停机、带 backlog 的 AOF 重启 | 基础恢复后两轮原账号业务成功 |
| 进程 | MapHost、Location、DBProxy 节点重启，动态副本宿主/管理器恢复 | 原账号与交易资产恢复、动态回退探针 |

Relay 探针刻意让全部事件共享一个 partition 以检验跨来源顺序；该组发送和 AOF 确认串行，everysec AOF 会限制组内吞吐。正式 3 小时运行按两秒一条保留故障后的追赶余量，不把这个单分区场景解释成 MQ 总吞吐测量。短跑用过每秒一条，正确性断言相同。

## 资源、日志与退出

首轮目录 `.build-tmp/local-validation/20260906-3h-r1` 已失败并保留证据，不能再视作运行中。后续每轮使用独立目录，实际开始、截止时间和控制进程 PID 以该轮 `started.json` 为准。运行期间笔记本不要休眠或关闭 Docker；启动状态不代表三小时验证已经通过。

完整矩阵 `20260906-3h-r2` 于北京时间 2026-09-06 17:03:32 启动，17:35:14 在 map2 恢复检查处失败停止；不能再视作运行中。其详细问题及两阶段探针修正见上文，原日志保留。

修正后完整矩阵 `20260906-3h-r3` 已于北京时间 **2026-09-06 19:29:38** 启动，计划 **22:29:38** 结束负载，随后进行最终对账与清理。100 名游戏玩家、独立 100 记录持久化探针和通用 Relay 同时运行，默认 11 类故障循环注入。启动前 DBProxy 111 项默认测试与 27 项真实数据库契约再次通过；基线两张地图、交易检查和两个持久化探针 READY 均已确认，启动后的可用内存约 4.15 GiB。控制进程初始 PID=25940，证据在工作区 `.build-tmp/local-validation/20260906-3h-r3`。这是已启动状态，**不是三小时通过结论**；后续以该目录 final.json/failure.json 为准。未修改远程环境或 WoW335，本轮只重置本机演练专用两库及两套 Redis 测试数据，既有 tiangz 数据库和历史日志保留。

每 5 秒使用 Node 原生计数器记录系统可用内存、CPU 时间差分、控制器 RSS 和采样间隔，不再同步启动 PowerShell/CIM 查询内存。磁盘余量、证据目录大小和服务指标每分钟记录。启动前至少 2.5 GiB 可用；任一次低于 1 GiB、磁盘少于 10 GiB 或证据超过 2 GiB 时停止本轮负载，保留服务用于清理，不删除证据，也不将资源中止视为通过。单个受管进程输出超过 256 MiB 也停止，不静默截断磁盘日志。分析用内存 tail 有界，原始输出保留。

资源保护或健康轮次失败时，`failure-diagnostics.json` 异步保存现场可用内存、受管服务 PID 和有界进程诊断。r10 起使用冻结的 `validation_resource_snapshot.exe`：只取进程名称/RSS 与约一秒区间的 CPU 差分，CPU 前 8、内存前 12，避免 PowerShell/CIM 启动开销；不采集命令行或环境变量，不操作其他进程。受 Windows 权限限制，不保证覆盖 vmmemWSL 等受保护进程，整机内存仍独立采样。诊断命令最长 30 秒并记录采集起止时间，不能将晚到的现场冒充故障瞬间。服务指标同时补采，诊断失败单独记录，不能覆盖原始业务错误。`failure.json.stopRequested` 只说明同时存在停止请求，不掩盖已经观察到的业务失败。日志丢弃检查覆盖所有标签序列，不能只接受第一条为零的指标。

后续轮次在可用内存低于 2 GiB、单次下降至少 512 MiB 或 CPU 达到 90% 时，还会提前保存独立的 `resource-pressure-*.json`（每分钟最多一次），避免等到资源恢复后才抓失败现场；压力提示不改变正确性判定。Rust 游戏探针的 `RPC_ERROR` 每玩家至多记录两条系统错误并截断详情，仍保留全部错误计数。持久化探针对非暂时性错误发出 `SOAK_CONTRACT_ERROR`，控制器立即失败，不把协议错误、冲突或 Internal 当作允许的故障重试。启动时也检查当前控制器源码与 prepare 的冻结副本一致；准备后修改控制器须重新 prepare。

低开销查看状态：`node tools/chaos/report_local_validation.mjs <运行目录名>`。完成后复核保存证据：`node tools/chaos/audit_local_validation.mjs <运行目录名>`，检查最终状态、运行期限、故障/恢复顺序、日志丢弃、资源守卫和对账计数；存在失败记录或缺少最终结果会拒绝。该命令不访问实时数据库，不能把部分对账升级为完整通过。原生采集可单独验证：`node --test tools/chaos/validation_resource_snapshot.test.mjs`（Windows，需先构建上述 release 工具）。

### 2026-09-06 夜间续测基线

`20260906-3h-r3` 实际在 22:14:05 结束，11 类故障各完成三轮，共 33 次恢复成功；22:13:43 已发出 STOP，但正在执行的第 341 轮先出现两个地图合计 4 次 Probe 错误、2 次业务传输错误（Actor RPC timeout），因此原 failure.json 必须保留为失败，不能改记为完整通过。最终探针收敛检查未执行。22:11:56 采样曾出现可用内存 0.60 GiB，下一分钟恢复；两个地图的长尾延迟同时升高，但旧监控不能证明具体资源争用来源，当前不宣称运行时超时根因已修复。

停止后只读对账：9,128 份快照、4,564 条不可变事实匹配，12 笔游戏交易审计与实际 MQ 事件匹配。Outbox 最初有 1 条待发布；夜间修改前仅恢复一个 DBProxy 节点，该条成功发布，SQL 4,564/4,564，实际 Stream 去重后 4,564 条连续序号，包含 7 次重复投递（at-least-once，需要消费者幂等）。原始运行日志不改写。后续按 30～60 分钟独立目录继续，保留相同账号恢复和严格错误判定；不得靠提高 RPC 超时或忽略健康窗口错误获得绿灯。

`started.json` 保存开始、截止时间与控制进程 PID；`events.jsonl` 保存阶段、失败和恢复证据；`resources.jsonl` 保存资源；`metrics-*.log` 每分钟保存 DBProxy 原始指标；`runtime/` 保存游戏日志。`final.json` 只在全部最终断言通过时写入；`failure.json` 记录失败。运行中不得宣称“3 小时验证通过”。手动停止可在运行目录创建 `STOP` 文件，控制进程在下一检查点退出，恢复依赖并回收自己启动的进程；游戏进程先用 stdin 请求有限时间的正常停机。不要直接杀控制进程，否则它无法执行清理。

笔记本演练是功能/恢复验证，不是远程 500 玩家容量结论。新代码也不等于 WoW335 真实客户端已经验收；保持其持久化公开接口不变，模块专属客户端验证另行执行。
