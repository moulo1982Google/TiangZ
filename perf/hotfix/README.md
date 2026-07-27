# 在线 Hotfix 性能与正确性测试

本目录规划 TiangZ 的运行中 Hotfix 验收。测试目标不是证明“新进程能加载新 Bundle”，而是验证已有连接、Scene、Entity、Component 与 Rust Native handle 均不重建时，运行中的 Process 能原子切换 Hotfix generation。

## 测试前提

- Model Bundle 在整轮测试中保持完全不变。
- 候选 Hotfix Bundle 必须在触发切换前构建完成；构建时间单独记录，不计入业务暂停时间。
- Hotfix 只改变行为，不增加字段、Component、协议或 Native schema。
- 压测客户端和 Runtime 都使用 Release 构建。
- 正式运行前关闭 Cocos、浏览器、Docker Desktop 和其他高 CPU 程序。

当前框架已经具备双 Bundle、不可变候选目录、兼容性校验、隔离预检、Watcher/Process Reload、超时屏障、TypeScript事务提交和Prometheus指标。5个拆分Process的无连接切换、损坏候选拒绝、2人有连接语义和3000人1Hz Reload A/B均已自动化；后续慢RPC、Timer和连续generation长稳仍不能用“停服后替换文件并重启”代替。

## 用例 A：3000 玩家容量回归

固定拓扑和负载：

- 1 MapHost、16 Gate、1 Login、1 LoginMgr；
- Rust 全链路压测客户端；
- 3000 个玩家全部进入同一地图；
- 每玩家 5Hz `C2M_Move`；
- 每玩家 1Hz `C2M_MapProbe`；
- 同一方向保持 5 次 Move，避免每条消息都人为转向；
- 10 秒预热、30 秒正式窗口、3 轮；
- Windows 使用 IOCP（配置名仍为 `epoll`）。

```powershell
npm run perf:map-capacity -- `
  --client rust `
  --gates 16 `
  --players 3000 `
  --move-rate 5 `
  --movement-hold-messages 5 `
  --probe-rate 1 `
  --probe-concurrency 1 `
  --setup-concurrency 4 `
  --warmup 10 `
  --duration 30 `
  --rounds 3 `
  --target-map-cpu 80
```

正式 A/B 验收统一使用下面的单独命令。它会先完成 Release 构建，然后依次运行“不 Reload”与“每秒 Reload”两组三轮测试，并生成 `perf/results/hotfix_latest.json` 和 `perf/results/hotfix_latest.md`：

```powershell
npm run perf:hotfix
```

候选 Bundle 会在压测前构建，构建耗时不进入正式窗口。两组都会打开相同的 Process 健康端口，避免把观测服务本身的开销错误算作 Reload 开销。测试模式会直接向每个 Process 注入与 Watcher 相同的父进程控制命令；业务 Runtime 和协议链路不使用测试专用捷径。

Rust 压测客户端会在玩家全部登录后写出正式测量时间，runner 只在预热结束、正式窗口开始时启动 Reload。Windows 下每轮使用独立 loopback IP 与固定源端口段，隔离大量登录短连接产生的 `TIME_WAIT`；这只修复负载发生器自身的端口耗尽，不减少连接数，也不改变服务端链路。

主要观察：

- Move 实际吞吐达到目标值的 95% 以上；
- Move、Probe、内部 RPC 均无错误和超时；
- 无 transport overload、slow disconnect；
- Probe 的 p50/p90/p95/p99/max；
- Map 与 Gate CPU、RSS、V8 Heap；
- 广播 pending、coalesced、排队时间和发送失败数。

## 用例 B：Hotfix 空载正确性

先以 2 个真实客户端连接验证语义，不让容量压力掩盖功能错误：

1. 启动正常 generation，玩家 A 持续按上，权威坐标只向上变化。
2. 预构建候选 generation，其中 `PlayerUnit.Move` 将 `inputY` 取反。
3. 请求在线 Reload，不关闭连接，也不重新创建玩家。
4. 玩家 A 继续按上，权威坐标改为向下变化；左右方向保持不变。
5. 玩家 B 能观察到同样的反向权威移动。
6. 再切回正常 generation，方向语义恢复。

验收必须同时满足：

- 两次 Reload 均成功，generation 单调递增；
- 切换前后 `connectionId`、`unitId`、Entity 数和 Native handle 不变；
- 不出现重复 Handler、旧 Handler 残留或玩家重登；
- 候选失败时仍继续使用旧 generation；
- 切回正常版本后行为完整恢复。

## 用例 C：3000 玩家负载中 Hotfix

本用例复用用例 A 的拓扑，但把正式窗口拆为：

- `before`：正常 generation 下稳定运行 15 秒；
- `switch-to-inverted`：切换到上下反转 generation；
- `after-inverted`：继续运行 15 秒；
- `switch-to-normal`：切回正常 generation；
- `after-normal`：继续运行 15 秒。

候选 Bundle 在进入正式窗口前全部构建完成。切换时只允许执行：兼容性复核、隔离预检、等待安全屏障、候选求值和事务提交。

每次切换记录：

| 指标 | 含义 |
|---|---|
| `candidate_build_ms` | 预构建候选耗时，不计入暂停 |
| `preflight_ms` | 隔离 V8 校验耗时 |
| `barrier_wait_ms` | 等待当前 Handler/Promise 和消息批次排空的时间 |
| `candidate_eval_ms` | 正式 V8 求值候选 Bundle 的时间 |
| `commit_ms` | prototype 与 Handler 表事务提交时间 |
| `reload_total_ms` | 从发出 Reload 到新 generation 可接收消息的总时间 |
| `active_generation` | 提交后的 generation |
| `in_flight_generations` | 尚有旧异步任务存活的 generation 数 |

业务影响按 `before / transition / after` 三个窗口分别统计：

- Move/s 与目标达标率；
- Probe p50/p90/p95/p99/max；
- Process 事件队列峰值和背压等待；
- Map/Gate CPU 与 V8 GC；
- 连接数、在线 Unit 数、错误、超时和慢连接断开；
- Hotfix 阶段、版本、失败原因和日志关联字段。

第一轮不预设武断的毫秒阈值，以零断线、零丢失、零错误和行为正确作为硬条件，并保存切换窗口数据作为后续性能门槛的基线。若 `transition` 的 Probe p99 明显高于前后窗口，需要按 `preflight / barrier / eval / commit` 分段定位，而不能只看一个总耗时。

## 实现清单

实现状态：

1. 已完成：`PlayerUnit.Move`的可变实现迁入Hotfix，Model只保留稳定方法形状。
2. 已完成：正常版和上下反转版候选输出到独立目录，不覆盖正在服务的文件。
3. 已完成：Watcher到Process的跨平台Reload控制消息。
4. 已完成：Process在超时安全屏障处加载候选，并返回结构化阶段耗时与结果。
5. 已完成：`perf:hotfix` runner 自动执行 3000 玩家基线与 1Hz Reload A/B 测试，并生成 JSON/Markdown 报告。
6. 已完成Prometheus指标；Grafana面板留到相应可观测性阶段统一展示。
