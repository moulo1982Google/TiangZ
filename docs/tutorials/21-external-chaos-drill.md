# 外网 500 玩家七日故障演练

本文描述在一台 4 核、8 GiB 内存、带 2 GiB swap 的 Linux 开发机上，持续运行 500 个游戏玩家和 100 个 DBProxy 正确性玩家，并间歇重启 Redis、PostgreSQL、MapHost、动态副本和两个 DBProxy peer 的方法。

这是一场恢复正确性演练，不是容量基准，也不是高可用验收。机器上只部署一个 PostgreSQL 和一个 Redis。不要在同一台 4C8G 主机上再增加 PostgreSQL standby 或 Redis replica：它们不能抵抗整机故障，却会挤占本次演练需要的内存、磁盘 I/O 和故障边界。真正的主从、自动切换和多可用区验收应在至少三台独立节点或云厂商托管高可用实例上另做。

## 验收目标

必须同时满足以下条件：

- 500 个游戏玩家持续完成登录、Gate、进入地图、移动、探测和轻量业务操作；玩家平均分布在静态地图 `1` 与 `100`。
- 100 个 DBProxy 正确性玩家持续覆盖权威读取、带 revision 的事务、AOF backlog、双玩家交易、不可变账本和 Outbox。
- Redis、PostgreSQL、两个 DBProxy peer、两个 MapHost 以及动态副本恢复后，业务负载能自行恢复，不依赖重启整个环境。
- Redis AOF 在 PostgreSQL 停机且 backlog 已积压时经历非优雅重启，重启前后 backlog 均非零；PostgreSQL 恢复后 backlog 最终排空。
- 最终逐玩家对账通过；没有缺失快照、低于已确认 revision 的旧读、账本不平衡、未排空队列或死信。
- 所有故障、恢复、负载结果和资源样本都有持久日志，控制终端断开不会丢失演练状态。

## 固定版本与资源预算

| 组件 | 演练配置 |
| --- | --- |
| PostgreSQL | `18.4-bookworm`；1.5 CPU、2 GiB 容器上限、512 MiB shared buffers、100 connections、15 分钟 checkpoint、2 GiB max WAL |
| Redis | `8.8.1-trixie`；0.5 CPU、768 MiB 容器上限、512 MiB `maxmemory`、`noeviction`、AOF `everysec`、64 MiB 起始 rewrite |
| DBProxy | 两个对等 peer，各 2 个 Tokio worker；backlog/cache-repair/outbox 各 1 worker |
| TiangZ | 一个 Watcher 管理 10 个子进程；日志落盘，控制台日志关闭；延迟与 trace 采样率为 1% |
| 游戏负载 | 500 玩家，两个 Rust/Tokio 子进程各 250；每 5 分钟重建一次全链路连接；1 Hz 移动、0.05 Hz 探测、0.02 Hz 业务 |
| DBProxy 负载 | 100 玩家；32 连接拆成读写池；每秒循环；每 10 分钟生成交易、账本与 Outbox |

这些数值是 4C8G 演练机的保护性起点，不是生产推荐值。`effective_cache_size` 只是 PostgreSQL 优化器提示，不会预分配内存。正式七日运行前必须用 500 玩家预演的峰值 RSS、swap、磁盘增长和 p99 来决定是否下调采样或业务频率。

Redis 宿主机必须设置 `vm.overcommit_memory=1`，否则每次 AOF rewrite/BGSAVE 都会留下内核内存承诺告警，并可能在内存压力下直接失败。仓库中的宿主机策略同时设置 journald 上限和 rsyslog 日轮转：

```bash
cd /opt/tiangz-chaos
/usr/local/bin/node tools/chaos/prepare_external_host.mjs       # 只校验
sudo /usr/local/bin/node tools/chaos/prepare_external_host.mjs --apply
sysctl vm.overcommit_memory
logrotate --debug /etc/logrotate.d/rsyslog
```

安装器只首次备份被替换的宿主机配置到 `/var/backups/tiangz-host-policy`。历史日志清理由运维显式决定，安装器不会删除旧日志。

## 代码与协议版本边界

当前 DBProxy 工作树是 `0.6.0`，Rust server/client/protocol 必须来自同一份源码，以保证握手 fingerprint 一致。TiangZ 的 Rust 构建在两个仓库尚未提交到远端前，应通过 Cargo `patch` 指向同级 `TiangZ-DBProxy` 工作树；不能拿远端 `main` 上的旧 `0.5.0` Rust client 与 `0.6.0` server 混用。

TiangZ 的 TypeScript 运行时目前仍锁定 DBProxy SDK `0.5.0`。本次游戏链路只使用快照和既有事务 API，因此可以保持该版本；新增的 `loadTrade`、`applyTradeTransaction` 和 `loadTradeTransaction` 暂时只由 DBProxy 的 Rust 正确性驱动使用。以后要让 TiangZ TypeScript 业务直接调用交易 API，必须先给 Rust Host 增加类型完整的桥接 op，再升级 TypeScript SDK，不能用 `as any` 绕过接口差异。

## 目录与服务

外网机使用以下固定位置：

```text
/srv/tiangz-build/<build-id>/          源码与只读构建产物
/opt/tiangz-external/                  TiangZ 二进制、bundle 与外网配置
/opt/tiangz-dbproxy/                   DBProxy 二进制、配置与 Compose
/opt/tiangz-chaos/                     游戏负载和故障编排器
/var/log/tiangz-chaos/runtime/         TiangZ 各进程按日滚动日志
/var/log/tiangz-chaos/game/            游戏负载 state、JSONL 和输出
/var/log/tiangz-chaos/control/         故障计划 state、JSONL 和探针输出
```

长期服务如下：

```text
tiangz-dbproxy@1.service
tiangz-dbproxy@2.service
tiangz-external.service
tiangz-dbproxy-soak.service
tiangz-chaos-game.service
tiangz-chaos-faults.service
```

`tiangz-chaos-faults.service` 需要控制 Docker、systemd 和子进程，因此以 root 运行。它同时要求命令行 `--execute` 和 `/etc/tiangz/chaos-enabled` 标记文件；少一个条件都不会注入故障。其余游戏负载与运行时使用非特权 `tiangz` 用户。

故障 unit `Requires` 游戏和 DBProxy 两个负载：任一负载停止时，故障注入也必须停止，不能对无人验证的环境继续施压。游戏 runner 有持久 deadline 和 epoch state，可以 `Restart=on-failure` 后续跑；DBProxy 正确性驱动的逐玩家状态只在内存中，因此 soak unit 使用 `Restart=no`。它若异常退出，本轮演练直接失败，不能换 run ID 静默重启后假装仍是同一个七日窗口。

## 构建门

外网构建必须锁定依赖并限制为两个 Cargo job，避免抢占在线服务。下面的 `<build-id>` 和 V8 文件路径按实际构建目录替换：

```bash
export CARGO_BUILD_JOBS=2
export RUSTY_V8_ARCHIVE=/srv/tiangz-build/<build-id>/librusty_v8_simdutf_release_x86_64-unknown-linux-gnu.a.gz

cd /srv/tiangz-build/<build-id>/TiangZ-DBProxy
nice -n 10 ionice -c2 -n7 cargo build --release --locked \
  --bin tiangz-dbproxy-server --bin dbproxy_fault_soak
nice -n 10 ionice -c2 -n7 cargo test --workspace --release --locked --no-fail-fast

cd /srv/tiangz-build/<build-id>/TiangZ
npm ci
npm run build
npm run build:perf:full-chain
npm run build:test:dynamic-map-fallback
npm run config:chaos:external
nice -n 10 ionice -c2 -n7 cargo build --release --locked --bin TiangZ \
  --config .cargo-config.toml
npm run build:perf:full-chain-rust
```

如果外网从 GitHub 下载 `rusty_v8` 归档长时间无进度，应在可信网络下载官方 release 资产、核对长度与 SHA-256 后上传，并通过 `RUSTY_V8_ARCHIVE` 指定本地文件。不要反复清空 `target`，也不要改用来源不明的镜像。

构建完成后至少执行：

```bash
file target/release/TiangZ
file target/release/map_probe_load
ldd target/release/TiangZ | grep 'not found' && exit 1 || true
ldd target/release/map_probe_load | grep 'not found' && exit 1 || true
node --check perf/chaos/run_longhaul_game.mjs
node --check tools/chaos/run_external_fault_plan.mjs
/usr/local/bin/node tools/chaos/run_external_fault_plan.mjs --preflight
docker compose --env-file /opt/tiangz-dbproxy/.env \
  -f /opt/tiangz-dbproxy/docker-compose.chaos.yml config --quiet
systemd-analyze verify /etc/systemd/system/tiangz-*.service
```

`--preflight` 是只读检查：它验证两个容器、两个 DBProxy、10 个 TiangZ `/ready` endpoint、真实 Watcher PID、10 个可注入子进程和动态副本探针。它不要求 marker，也不会停止进程。systemd 为保持 Watcher 标准输入而使用 wrapper shell，因此编排器以 `comm=TiangZ` 和 `StartMachine.json` 在服务进程树内唯一定位 Watcher，不能把 systemd 的 MainPID 直接当作 Watcher。

## 新建分区数据库

以下步骤会永久删除外网开发环境的 PostgreSQL 和 Redis 数据。必须先确认目标 Compose project 与数据卷名称，不能使用模糊通配符。

```bash
systemctl stop tiangz-chaos-faults.service tiangz-chaos-game.service \
  tiangz-dbproxy-soak.service tiangz-external.service \
  'tiangz-dbproxy@1.service' 'tiangz-dbproxy@2.service'

docker compose --env-file /opt/tiangz-dbproxy/.env \
  -f /opt/tiangz-dbproxy/docker-compose.yml down

docker volume inspect \
  tiangz-dbproxy-local_tiangz-dbproxy-postgres-data \
  tiangz-dbproxy-local_tiangz-dbproxy-redis-data
docker volume rm \
  tiangz-dbproxy-local_tiangz-dbproxy-postgres-data \
  tiangz-dbproxy-local_tiangz-dbproxy-redis-data

docker compose --env-file /opt/tiangz-dbproxy/.env \
  -f /opt/tiangz-dbproxy/docker-compose.chaos.yml up -d
```

新的固定数据卷是：

```text
tiangz-dbproxy-chaos-postgres-data
tiangz-dbproxy-chaos-redis-data
```

两个容器健康后启动 DBProxy。首个 peer 在 PostgreSQL advisory lock 内执行 migration，第二个 peer 等待后复用同一 schema。必须确认 `dbproxy_snapshots` 是 `HASH (namespace, record_key)` 父表且恰有 `p00` 到 `p31` 共 32 个叶子分区。

## 分阶段放量

不要从空数据库直接启动七日计划。按下面的门逐级推进；任一阶段出现 OOM、swap 持续增长、磁盘不可控、未恢复队列或正确性错误，都回到健康基线并停止升级。

1. 10 玩家、10 分钟、无故障：验证注册、登录、Gate、地图 1/100、日志和重复账号恢复。
2. 100 玩家、30 分钟：各做一次 Redis、PostgreSQL、MapHost 和 DBProxy peer 的单故障。
3. 500 玩家、2 到 4 小时：运行正式频率与完整故障序列，观察 RSS、CPU、swap、WAL/AOF 和日志增长。
4. 清理预演 state，重新创建专用七日 run 目录，才启动 168 小时服务。

预演应使用独立目录，例如：

```bash
runuser -u tiangz -- /usr/local/bin/node \
  /opt/tiangz-chaos/perf/chaos/run_longhaul_game.mjs \
  --client rust --client-path /opt/tiangz-chaos/map_probe_load \
  --host 127.0.0.1 --manager-port 27000 --players 10 \
  --total-hours 0.167 --session-seconds 300 --warmup-seconds 10 \
  --move-rate 1 --probe-rate 0.05 --business-rate 0.02 \
  --account-prefix smoke10 --run-dir /var/log/tiangz-chaos/preview-10
```

长稳 runner 每 5 分钟完成一个 epoch，并用稳定账号重新走完整连接链路。正式 unit 通过 `--client rust` 启动两个 Tokio 客户端分片；`--client node` 只保留为协议 SDK 对照和回退入口。地图 `1` 的进图响应声明 `Grid2D`，Rust 客户端据此使用 `C2M_Move/G2C_EntityMove`，直接扫描 protobuf wire 数据中本玩家的累计确认序号，不为同屏其他实体构造对象；地图 `100` 声明 `NavMesh3D`，客户端自动改用 `C2M_NavigateInput/M2C_NavigateInput`，并验证 `G2C_EntityNavigate` 权威 Push。不能只按进程退出码判断通过，否则错误地向 NavMesh3D 地图发送 Grid2D 消息也可能得到退出码 `0`。

每个 `shard_finished` 事件同时记录 `completed`、`healthy` 和 `healthIssues`。正常窗口必须满足：进图人数与目标一致、空间模式一致、移动确认率至少 99%、移动/Probe 错误为零、存在权威移动 Push，且业务传输错误为零。业务因冷却等规则被拒绝不等同于传输故障。注入故障期间出现不健康 shard 是预期现象，但故障后的 epoch 必须重新变为健康；最终报告要把这些事件与 `fault-events.jsonl` 的故障窗口关联，而不能简单要求七天内 `failedShards=0`。

`state.json` 使用临时文件加原子 rename 保存；systemd 重启后会继续原 deadline，而不会重新计时七天。状态 schema 与全部实质参数都进入 fingerprint。升级 runner、改变参数或改变判定语义时必须换 run 目录，旧 schema 会被明确拒绝，不能误续跑。

DBProxy 正确性驱动也要先独立短跑。例如 100 玩家运行 2 分钟并完成最终对账：

```bash
systemd-run --unit=tiangz-dbproxy-soak-preview --collect \
  --property=User=tiangz --property=Group=tiangz \
  --property=WorkingDirectory=/opt/tiangz-dbproxy \
  --property=EnvironmentFile=/etc/tiangz/dbproxy.env \
  /opt/tiangz-dbproxy/dbproxy_fault_soak \
  --endpoint 127.0.0.1:7800 --failover-endpoint 127.0.0.1:7801 \
  --players 100 --duration 120 \
  --cycle-ms 1000 --read-pool-size 24 --write-pool-size 8 \
  --trade-interval-cycles 30 \
  --report-interval 15 --validation-timeout 120
```

短跑必须输出 `SOAK_FINAL` 且最终验证通过。认证 token 由 systemd 在降权前读取的 root-only `EnvironmentFile` 注入，不出现在命令行和日志中。

## 2026-08-27 外网准备基线

4C8G 外网机已完成 fresh 分区环境、无故障短跑和一次 DBProxy peer 定点切换，但尚未执行第 2、3 阶段完整故障预演，也没有启动七日 unit：

- PostgreSQL 18.4 和 Redis 8.8.1 均 healthy；快照父表为原生分区表，32 个叶子分区和 001–007 migration 完整。
- DBProxy release workspace 的 73 个非 ignored 测试全部通过；16 个需要显式真实 Docker/存储环境的测试仍保持 ignored，由独立故障演练覆盖。
- Map 100 定点验证的 30/30 次 NavMesh3D 移动全部确认。随后 10 玩家分布到地图 1/100，连续两个 epoch 的 4 个 shard 全部 `healthy=true`：Grid2D 为 289/289、NavMesh3D 为 290/290，移动、Probe 和业务传输错误均为 0。
- DBProxy 100 玩家先以 32 连接单池运行 120 秒：读取成功 16,110、AOF 入队 2,300、事务首次提交 1,326、交易首次提交 426；随后按正式配置改成 24 读 + 8 写的拆分池再运行 60 秒：读取成功 8,934、AOF 入队 1,100、事务首次提交 737、交易首次提交 481。两轮的缺失快照、旧读、交易/事务错误和不变量错误均为 0，最终逐玩家验证都通过。压缩交易负载停止后必须继续等待 Outbox，最终 backlog、cache repair、outbox 的 pending/processing/dead-letter 全为 0。
- 正式 soak 配置增加 7801 failover，并移除对 peer 1 的 systemd `Requires`。100 玩家运行 90 秒期间把 peer 1 停止约 35 秒，负载始终存活并经 peer 2 继续完成请求；最终读取 13,238、AOF 入队 1,700、事务 1,102、交易 348，全部错误为 0且最终对账通过。peer 1 恢复后两个 `/dependencies` 均回到 healthy。
- 10 个 TiangZ `/ready`、两个 DBProxy `/dependencies` 和全部可观测组件均通过；长期游戏、DBProxy soak 和故障 unit 均为 disabled/inactive，故障安全 marker 不存在。
- Rust 长稳客户端已在同机完成 3 个 10 玩家 epoch 的稳定账号复用，以及最终版 500 玩家、`2 x 250`、300 秒正式窗口。Grid2D 与 NavMesh3D 均发送并确认 75,000 次移动，`skippedTicks=0`，移动/Probe/业务传输错误均为 0；真实道具与技能共 3,000 次业务响应中接受 2,954、规则拒绝 46，并收到 1,454 个 `G2C_ItemChanged`。
- 与同参数、同 64 setup 并发的 Node epoch 5 对照，两个负载进程累计 CPU 从 351,255 ms 降至 141,490 ms（下降 59.7%），结束 RSS 合计从 647.5 MiB 降至 17.8 MiB（下降 97.2%）。NavMesh3D 客户端 CPU 单独下降 91.3%，移动 p99 从 1,823.5 ms 降至 9.1 ms，且 Node 的 9,561 个 skipped tick 在 Rust 中归零。Grid2D 因完整排空并扫描 36,694,542 个权威 Push，CPU 从 40.0 秒增至 114.6 秒，但 p99 仍从 122.0 ms 降至 99.9 ms；不能只看合计值掩盖这项模式差异。

这些结果只说明编译、协议选择、低开销负载端、基础持久化链路、单 peer 切换和安全开关已经就绪，不能替代 100 玩家完整故障序列、500 玩家 2–4 小时和最终 168 小时验收。500 玩家数据来自无故障短跑；不能据此宣称故障恢复已经通过。

## 截止时间验证与日志预算

七日演练前使用同一套负载和故障动作做有明确截止时间的验证。starter 创建四个 transient service：500 玩家 Rust 游戏负载、100 玩家 DBProxy 正确性负载、故障编排和五分钟日志审计；最后再创建一个定时 finalizer。负载在截止时间前预留 2–10 分钟自然收尾，DBProxy 输出 `SOAK_FINAL` 后做逐玩家及队列对账；截止时 finalizer 撤销安全 marker、停止残留故障、恢复两个存储容器和全部服务，并写出最终报告。

长稳客户端不会只回显请求的目标地图：`RESULT_JSON.enteredMapId/enteredMapInstanceId` 来自真实 `G2C_EnterMap` 响应。复用账号的移动序列以 epoch 为基数保持单调；如果 MapHost 丢失后玩家被安全回退到地图 1，runner 会记录失败并为该 shard 切换一代新账号，下一 epoch 必须重新进入目标地图并恢复健康。最终 shard 仍不健康时，即使 runner 正常退出也不能通过。

```bash
/usr/local/bin/node /opt/tiangz-chaos/tools/chaos/start_external_validation.mjs \
  --deadline '2026-08-28T07:00:00+08:00' \
  --run-id overnight-20260828 --players 500
```

每轮目录通过 `/var/log/tiangz-chaos/current-validation` 指向。无需持续登录；随时可读：

```bash
systemctl --no-pager status \
  tiangz-overnight-game.service tiangz-overnight-soak.service \
  tiangz-overnight-faults.service tiangz-overnight-audit.service
tail -n 20 /var/log/tiangz-chaos/current-validation/game/game-events.jsonl
tail -n 20 /var/log/tiangz-chaos/current-validation/control/fault-events.jsonl
tail -n 5 /var/log/tiangz-chaos/current-validation/log-audit.jsonl
```

日志分为两类，不能用同一种保留策略：

- `game-events.jsonl`、`fault-events.jsonl`、`dbproxy-soak.log`、`service-journal.jsonl`、`container-logs.jsonl` 和最终 JSON 是本轮验收证据。审计器以至少一次方式每五分钟复制 systemd/Docker 日志，轮转后仍能分析；单轮证据预算为 2 GiB，达到预算必须停止升级而不是覆盖旧证据。
- TiangZ 业务/警告/错误结构化日志仍按日滚动，latency/trace 维持 1% 采样；重复的 `tiangz::metrics`/`tiangz::latency` 周期摘要不再写文件，因为相同累计序列已由 Prometheus 保存 14 天。Docker `local` driver 每容器按 `32 MiB × 5` 有界轮转；journald 使用 4 GiB 上限、保留 12 GiB 磁盘余量并关闭 rate-limit 丢弃；rsyslog 按日或达到 256 MiB 时轮转并只保留 7 份。应用的 `tiangz_process_dropped_logs_total` 必须始终为 0。

`log-budget-final.json` 同时按已知日志目录之和与整块文件系统的稳健增长率投影 168 小时，并取两者较大值检查磁盘保留量；文件系统使用 Theil–Sen 斜率、另保留观测到的瞬时峰值余量，最终还会对 `df` 连续采样取中位数，避免刚好撞上 Prometheus TSDB 压缩时把短暂双份 block 当成持续增长。后者仍会把 PostgreSQL/Redis 数据、WAL/AOF、Prometheus、Loki 和 Tempo 等未单列空间纳入风险判断。

报告除应用日志丢弃、journal 连续性、JSON、证据预算和 `SOAK_FINAL` 外，还直接扫描每个 TiangZ `/metrics` 是否有重复序列，并检查 Prometheus duplicate-timestamp/out-of-order 拒收计数在本轮是否增长；游戏必须以所有 shard 最终恢复健康结束，故障计划必须所有已开始动作都通过且无 baseline recovery failure。`validation-final.json` 再确认基线服务和这些强门禁。只有两个报告均通过，才能把相同配置升级为七日；“进程退出码为 0”“磁盘还有空间”或“服务仍 active”都不能单独算通过。

## 正式七日启动

外网游戏入口在演练期间应下线，Grafana、Prometheus、Loki、Tempo 和 ACME 入口保持运行。修改 Nginx 前先保存并验证可恢复的站点链接或配置，只关闭 TiangZ 游戏站点，不要停止整个 Nginx。

在 2 到 4 小时预演通过后执行：

```bash
systemctl enable tiangz-dbproxy-soak.service tiangz-chaos-game.service
systemctl start tiangz-dbproxy-soak.service tiangz-chaos-game.service

install -o root -g root -m 0644 /dev/null /etc/tiangz/chaos-enabled
systemctl enable tiangz-chaos-faults.service
systemctl start tiangz-chaos-faults.service
```

先启动两个负载，再创建安全标记并启动故障计划。故障编排器默认预热 30 分钟，故障间隔在 45 到 120 分钟之间；动作顺序确定，间隔由持久 RNG state 决定。联合存储故障在最初 24 小时不会执行。

## 日常查看

无需持续登录监控。需要检查时收集以下证据：

```bash
systemctl --no-pager --full status \
  tiangz-external.service tiangz-dbproxy@1.service tiangz-dbproxy@2.service \
  tiangz-chaos-game.service tiangz-dbproxy-soak.service tiangz-chaos-faults.service

tail -n 30 /var/log/tiangz-chaos/game/game-events.jsonl
tail -n 30 /var/log/tiangz-chaos/control/fault-events.jsonl
journalctl -u tiangz-dbproxy-soak.service --since '2 hours ago' --no-pager
docker stats --no-stream
free -h
df -h /
```

Prometheus 至少观察：

```text
dbproxy_dependency_up
dbproxy_backlog_pending
dbproxy_backlog_processing
dbproxy_backlog_oldest_pending_age_seconds
dbproxy_cache_repair_pending
dbproxy_cache_repair_dead_lettered
dbproxy_outbox_pending
dbproxy_outbox_dead_lettered
```

故障期间 `/ready` 返回 503 是预期降级信号；恢复后持续 503、队列 oldest age 继续上涨、dead letter 非零、玩家旧读或账本不平衡才是失败。

## 停止与恢复基线

正常结束或人工停止时，先移除安全标记和故障服务，避免恢复过程中再次注入故障：

```bash
rm -f /etc/tiangz/chaos-enabled
systemctl disable --now tiangz-chaos-faults.service
systemctl disable --now tiangz-chaos-game.service tiangz-dbproxy-soak.service

docker start tiangz-dbproxy-postgres tiangz-dbproxy-redis
systemctl restart 'tiangz-dbproxy@1.service' 'tiangz-dbproxy@2.service' \
  tiangz-external.service
```

最后等待 PostgreSQL、Redis、12 个 `/ready` endpoint 与三类持久队列恢复健康，再做最终逐玩家对账。只有完成最终对账、队列排空和日志归档后，七日演练才能标记为通过。
