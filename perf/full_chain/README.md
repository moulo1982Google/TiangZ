# 全链路性能测试

本测试用于观察真实 Demo 游戏链路。框架空 Handler 的 RPC 基线由 `npm run perf:rpc-baseline` 单独测试，避免把两种口径混在一份报告里。

## 测试链路

真实游戏链路：

```text
GetLoginServiceAddr
  -> Login
  -> 断开 Login，连接 Gate
  -> LoginGate
  -> EnterMap
  -> MapReady
  -> 循环发送 C2M_Move（IActorLocationMessage）
  -> Gate Core 自动定位 Unit 所在 MapHost 并转发
  -> 地图 Actor + MovementComponent
  -> MapHost 按 Gate 聚合 M2G_EntityMove
  -> Gate 遍历 targetUnitIds 下发 G2C_EntityMove
  -> 客户端收到自身 G2C_EntityMove，完成一次闭环
```

`all` 使用一个操作系统进程、一个 V8 和多个 EntryScene；`split` 使用六个进程，Scene 调用经过内部 TCP 和 rpcId 多路复用。

## 一键运行

在 `ets_runtime` 目录执行：

```powershell
npm run perf:full-chain
```

该命令跨平台运行，Windows 和 Linux 使用同一个 Node 调度脚本。默认矩阵：

- 玩家数：10、50、100。
- 部署：`all` 和 `split`。
- 稳定负载：每个玩家目标 10Hz 移动。
- 极限负载：每个玩家收到自身权威移动后立即发送下一条。
- 每个案例预热 10 秒、正式采样 60 秒、独立运行 3 轮并报告中位数。

开发期间可缩小矩阵：

```bash
npm run perf:full-chain -- \
  --mode all --players 10,50 --move-rates 10,0 \
  --warmup 2 --duration 10 --rounds 1
```

旧 PowerShell 调度器暂时保留为 `npm run perf:full-chain:legacy`，只用于历史结果复现。

## 独立压测机

先在服务端机器启动对应配置，并确保配置返回给客户端的 Login/Gate IP 是压测机可访问的地址。随后在压测机执行：

```bash
npm run build
npm run build:perf:full-chain
node perf/full_chain/run_full_chain_perf.mjs \
  --remote --host 192.168.1.100 --manager-port 7000 \
  --players 10,50,100 --move-rates 10,0 \
  --warmup 10 --duration 60 --rounds 3
```

远程模式报告压测机 CPU/RSS/GC；服务端 CPU/RSS/V8 Heap/GC 从服务端日志的 `[process-metrics]` 采集。两类指标不会混算。

## 指标口径

- `登录 users/s`：本轮有限玩家并发完成完整登录进图的启动速率。10/50/100 个样本只用于链路对比，不等于登录服容量上限。
- `move/s`：采样窗口内，客户端从发送 Move 到收到自身权威 `G2C_EntityMove` 的闭环完成数。
- `push/s`：所有客户端收到的 `G2C_EntityMove` 总数除以完整移动窗口。当前仍是同地图全量可见，因此业务扇出仍为 O(N²)，但 MapHost 到 Gate 的跨进程消息已按 Gate 聚合。
- `p50/p95/p99`：已完成移动闭环的端到端延迟。
- `stalled`：在总测试截止时间后仍未收到自身权威移动的玩家数。延迟分位数不包含这些未完成请求，因此必须和 `stalled` 一起判断。
- `overloads`：内部 TCP transport 有界队列拒绝的消息数，可在对应 Runtime 日志的 `[metrics:inner_transport]` 中查看。
- `Server CPU/RSS/GC`：Runtime 周期输出的进程 CPU、RSS、V8 Heap、V8 GC 次数与累计暂停时间；split 模式按进程汇总。
- `Load CPU/RSS/GC`：Node 压测客户端自身资源，仅用于判断压测机是否先成为瓶颈。

目标 10Hz 是客户端调度目标；Windows 定时器、Node 事件循环和 AOI Push 解码都会影响实际 `move/s`，报告以实际完成数为准。

## 输出文件

每次执行生成：

- `perf/results/full_chain_<时间>.md`：人读报告。
- `perf/results/full_chain_<时间>.json`：结构化结果。
- `perf/results/full_chain_<时间>_raw.json`：每轮完成后立即更新，异常中断时也能保留已完成数据。
- `perf/results/logs/<时间>/`：每个 Runtime 的 stdout/stderr，可用于关联队列和 Handler 指标。
- `perf/results/full_chain_latest.*`：最近一次完整报告。

## 判读边界

这套测试回答“当前框架和 Demo 链路在哪里开始退化”，不能单独替代生产容量规划。正式容量结论还需要：

- 固定 CPU 频率并减少后台进程干扰。
- 默认命令已经覆盖 60 秒、三轮中位数；正式结论仍应保留每轮原始值观察波动。
- 使用 `--remote` 在独立压测机上测试真实网络，而不是只用 `127.0.0.1`。
- 接入真正网格 AOI 后，按视野内实体数设计玩家分布。
- Runtime CPU、RSS、V8 Heap、GC 已采集；网络带宽与更细的队列时序仍需后续补充。
