# 可观测性与链路耗时

Runtime 每 5 秒输出一次进程和 Scene 指标。Scene 快照也只在这个采样点生成和 JSON 序列化，普通 Tick 不承担 metrics JSON 开销。链路耗时在 TypeScript Core 内聚合为直方图，只输出统计结果，不逐条打印消息。

## Prometheus 与 Grafana（3.10.4）

这是用于本机调试和拆分 Process 部署的最小监控栈。每个 TiangZ Process 独立暴露 `/metrics`，Prometheus 负责抓取全部实际运行的 Process，Grafana 再按环境、机器和 Process 聚合。不要在业务层新增 Observer Scene 来转发指标；它会引入单点、额外队列和错误的指标归属。

### 启动

Watcher 拆分部署（默认读取 `configs/local/StartMachine.json`）：

```powershell
npm run observability:up
```

`all.json` 单进程调试：

```powershell
npm run observability:up:single
```

### 启动 TiangZ 并验证

1. 新开终端启动与监控目标一致的服务端：

```powershell
cargo run --bin TiangZ -- configs/local/StartMachine.json
```

2. 验证一个实际 Process 健康端口（例如 Map 的 7606）：

```powershell
iwr http://127.0.0.1:7606/metrics
iwr http://127.0.0.1:7606/live
```

3. 打开 Prometheus targets 页面确认抓取到 UP：

`http://127.0.0.1:9090/targets`

确认 `State: UP` 后，打开面板看曲线：

`http://127.0.0.1:3000/d/tiangz-process-overview/tiangz-process-overview`

### 停止

```powershell
cd tools/observability
docker compose down
```

清理数据卷时可用：

```powershell
cd tools/observability
docker compose down -v --remove-orphans
```

### 访问入口

- Prometheus：`http://127.0.0.1:9090`
- Prometheus 告警：`http://127.0.0.1:9090/alerts`
- Grafana：`http://127.0.0.1:3000`
  - 默认账号：`admin`
  - 默认密码：`admin`

### Dashboard 核心字段

- Process：就绪状态、CPU、RSS、V8 Heap、当前连接数和网络吞吐。
- Scene：处理吞吐、Mailbox 当前队列、异步在途和 Handler/Update 耗时。
- 延迟：通过标准 Prometheus Histogram 计算 P50/P95/P99，可跨 Process 聚合。
- 背压：Rust 队列占用率、等待次数、慢连接断开和 Inner RPC pending/错误率。
- 游戏循环：Fixed Update 跳帧、V8 GC、Native 编码吞吐和 Map 广播队列。

`tiangz_process_cpu_percent` 使用“单个逻辑核心为 100%”的进程口径，多线程 Host 在多个核心同时工作时可以超过 100%；它不是任务管理器中除以整机核心数后的总机百分比。

### TiangZ 已暴露的指标（部分）

- `/live`、`/ready`、`/metrics`（可通过 `process.observability.health.port` 配置）
- `tiangz_process_live`、`tiangz_process_ready`、`tiangz_process_uptime_seconds`
- `tiangz_process_runtime_fresh`、`tiangz_process_runtime_heartbeat_age_seconds`：识别健康 HTTP 可响应但 V8 业务线程已经卡住的假存活。
- `tiangz_transport_inner_pending_calls`：内网 RPC 待返回调用
- `tiangz_transport_inner_overload_rejections`：transport 队列过载拒绝数
- `tiangz_transport_inner_timed_out_calls`：跨进程 RPC 超时
- `tiangz_transport_inner_disconnected_calls`：连接断开丢弃数
- `tiangz_scene_*`：按进程/Scene 聚合的处理与错误计数
- `tiangz_native_live_units`：Rust Arena 中在线 Unit 数
- `tiangz_native_encoded_bytes_total`：Native snapshot 下发累计字节

### 目标端口生成

`tools/observability/prometheus/targets.yml` 由 `npm run observability:update-targets` 自动生成（`observability:up` 会先执行）。生成器读取 `StartMachine.json` 中实际部署的 Process，不扫描整个配置目录，因此不会把互斥的压测、KCP、io_uring 和单进程配置同时当作在线 Target。

如需监控其他启动入口，可显式生成：

```powershell
node tools/observability/generate_prom_targets.mjs --startup configs/local/all.json --local-host host.docker.internal
```

`--local-host` 只替换 `127.*`、`localhost` 和 `::1`；远程机器仍使用 `StartMachine.json` 中的 `innerIp`。`host.docker.internal` 在 Docker Desktop 下映射宿主机。

生成器先写同目录临时文件并校验，再原子替换 `targets.yml`，避免 Prometheus 读到半截 YAML。Compose 只读挂载整个 `prometheus/` 目录而不是单独挂载该文件，保证 Linux/Docker 下原子替换后容器能看到新 inode。修改 `StartMachine.json`、Process 清单或健康端口后，必须重新执行 `npm run observability:update-targets`；`observability:up` 会自动执行这一步。远程机器不得把健康端口只绑定到 loopback，否则生成器会直接报错。

机器 CPU、整机内存、磁盘和网卡不属于 TiangZ Process 指标。正式部署时应在每台机器安装一个 `node_exporter`（Linux）或 `windows_exporter`（Windows），避免把机器指标重复挂在每个游戏进程上。

`all.json`、`gate1.json`和`map1.json`默认开启 `sampleRate=10` 的延迟采样，用于本地 Dashboard。性能基线配置默认不开启延迟采样；对比压测时必须保持两轮的采样设置一致。

## 健康检查

可在 `process.observability.health` 配置独立 HTTP 端口：

- `/live` 回答 Runtime 线程是否仍未退出；它不会因为一次心跳过期就宣告进程死亡。
- `/ready` 只有在业务端点绑定完成、全部 TS Scene 通过启动屏障、进程未进入停机且 Runtime 心跳未过期时才返回成功。
- `/metrics` 返回 Prometheus 文本格式的生命周期指标：`tiangz_process_live`、`tiangz_process_ready`、`tiangz_process_uptime_seconds`。

Runtime 每次发布 5 秒观测快照时刷新心跳，默认超过 `15000ms` 即撤销 ready。心跳只能由 V8 业务线程刷新，健康 HTTP 线程不会代刷，因此 `Game.Update` 或事件循环卡死能够被发现。

探针使用 HTTP 200/503 或文本快照，不执行数据库或其他远程依赖调用，因此不会把探针流量带入业务 mailbox。`/metrics` 已覆盖 Process、Scene、游戏循环、NativeData、Inner Transport 和延迟 Histogram；结构化日志用于保留带上下文的离散事件，二者职责不同。

## 结构化日志

Rust 使用 `tracing` 作为统一日志门面；TypeScript 的 `Logger` 通过 deno_core op 进入同一出口。开发环境默认输出易读文本，生产环境建议在 `process.logging` 中选择 JSON 和滚动文件，再由 Vector 或同类 Agent 采集到 Loki。

业务代码优先使用 Scene/Actor 上下文中已经绑定好的 Logger：

```ts
this.ctx.logger.info("玩家进入地图", { account, unitId, mapId });
this.ctx.logger.error("使用道具失败", { unitId, itemId, error });
```

固定字段包括 `process/scene/sceneType/actorId/connectionId/rpcId/msgcode/requestId/unitId`，其他业务字段会进入 `attributes`。协议分发时会自动绑定 `connectionId/actorId/msgcode/rpcId/requestId`，Handler 可直接使用 `context.logger`，不需要重复填写这些字段。`requestId` 当前只保证单个 Process/V8 生命周期内可区分请求，不等同于跨进程 Trace；真正的 `traceId` 传播留给后续内部协议设计。`Error` 会保留名称、消息和堆栈。旧的 `console.log/error` 仍可用并会进入统一出口，但缺少 Scene/Actor 绑定字段，只用于兼容旧代码。

TS Logger 会在合并字段和 JSON 序列化之前检查最低日志级别，关闭的低级别日志不会跨 deno_core op。简单的 `level`、`RUST_LOG=info` 等配置可精确预过滤；复杂的 target filter 会保守地允许 TS 日志进入 Rust，再由 `tracing` 做最终过滤，避免错误丢弃本应开启的 target。

日志分类：

- `framework`：Runtime、协议、网络、mailbox、定时器和生命周期错误。
- `business`：登录、地图、道具等普通业务诊断。
- `application`：尚未绑定上下文的兼容输出。

禁止记录密码、Token 和完整网络载荷。当前普通日志是可丢弃的诊断通道，可靠审计日志尚未实现。

链路耗时默认关闭，因为它会调用时钟并维护直方图，CPU Profile 时会污染热点。需要诊断链路分段时，在进程配置中显式开启：

```json
{
  "process": {
    "name": "all",
    "observability": {
      "latency": {
        "enabled": true,
        "sampleRate": 1
      }
    }
  }
}
```

`sampleRate` 表示每 N 次记录 1 次。压测定位阶段建议先用 `10` 或 `100`，需要精确分位数时再改成 `1`。

## Scene 指标

日志格式：

```text
[metrics:gate1] scene=gate_1 type=Gate processed=... failed=... ts_queue=... rust_queue=... handler_ms=...
```

字段含义：

- `processed`：该 EntryScene 已处理的 frame 数。
- `failed`：框架失败总数，包括未捕获异常、系统错误、解码失败、缺 Handler 和单向消息 Handler 异常；业务正常拒绝不计入。
- `protocol_successes`：RPC 或单向消息成功完成次数。
- `business_errors`：错误码大于等于 10000 的业务拒绝次数。
- `system_errors`：错误码小于 10000 的框架错误总数；包含下面三个细分类。
- `decode_errors/handler_not_found/message_handler_failures`：协议解码、缺 Handler、单向消息 Handler 异常的细分次数。
- `ts_queue`：当前 TS 入站队列长度。
- `ts_max_queue`：该进程启动以来 TS 入站队列峰值。
- `rust_queue`：Rust 到 V8 的进程事件队列当前长度。
- `rust_max_queue`：Rust 进程事件队列峰值。
- `backpressure`：Rust 入站队列满后等待次数。
- `slow_disconnects`：下行队列超过限制后被断开的慢连接数。
- `handler_ms/max_handler_ms/total_handler_ms`：EntryScene frame 处理耗时。

业务自定义指标通过 `CustomMetricSnapshot` 投影。`values` 中未声明类型的字段按 Gauge 导出；进程生命周期累计值必须在 `kinds` 中声明为 `counter`：

```ts
return {
  name: "map_broadcast",
  values: { pending_units: pending, sent_frames_total: sent },
  kinds: { sent_frames_total: "counter" },
};
```

Gauge 使用 `tiangz_scene_custom_metric_gauge`，Counter 使用 `tiangz_scene_custom_metric_total`。不要根据字段名后缀猜类型，也不要把会回退或每帧重置的值标为 Counter。

## 告警规则

`tools/observability/prometheus/rules/tiangz.yml` 已覆盖 Target down、Process 未就绪、Runtime 心跳过期、Rust 队列 70%/90%、背压、Inner RPC 失败、系统错误、缺 Handler、Update 跳帧、日志丢弃和 Handler P99 超预算。规则判定可在 Prometheus `/alerts` 查看。

当前没有接入 Alertmanager，规则只负责产生告警状态，不发送邮件或 Webhook。通知渠道、值班路由与抑制策略属于 Phase 5。

修改 Dashboard、Target 生成器或告警规则后执行：

```powershell
npm run verify:observability
```

该命令检查拆分/单进程 Target、Dashboard 生成漂移、面板 ID/refId、规则接线、Prometheus 指标格式、心跳语义、Histogram 结构和 Native Counter 单调性。安装 Docker 时，还应使用仓库固定的 Prometheus 镜像执行 `promtool check config`。

## Transport Backend 指标

`[process-metrics]` 同时输出：

- `transport_read_ops/read_frames/read_bytes`：累计 Backend 接收批次、拆出的逻辑帧和网络字节；
- `transport_write_ops/write_frames/write_bytes`：累计 Backend 发送批次、写出的逻辑帧和网络字节。

用 `read_frames / read_ops` 和 `write_frames / write_ops` 可以观察 Backend 的实际批量度。这里的 `op` 不是严格的系统调用计数；`read_exact` 或 `write_all` 内部仍可能执行多次 I/O。io_uring 的价值来自一个异步批次摊销多个逻辑帧，因此不能只比较消息吞吐；还应同时比较该比值、CPU、P95/P99、错误率与背压。

## Game.Update 与定时器指标

日志格式：

```text
[game-metrics] process=map1 fixed_update_ms=50 frame_count=... skipped_fixed_updates=... update_targets=... update_calls=... update_failures=... timers=...
```

- `frame_count`：启动后执行的固定 Game.Update 帧数。
- `skipped_fixed_updates`：暂停或过载后因超过 `maxCatchUpSteps` 而主动跳过的旧帧数；稳定运行时应保持不变。
- `update_targets`：当前自动注册的 IUpdate Component 数。
- `update_calls/update_failures`：累计 Update 调用数和异常数。
- `timers`：当前存活游戏定时器数，可用于发现生命周期泄漏。

## Map 移动广播指标

MapHost 每 5 秒随 Scene 快照输出每张地图的广播状态：

```text
[custom-metrics:map1] scene=map_1 type=MapHost name=map_broadcast timestamp_ms=... map_id=1 in_flight=1 pending_units=... coalesced_frames_total=...
```

移动广播采用 single-flight：同一张地图同时最多执行一个广播 Promise。广播在途期间产生的新状态进入待发区；同一个 Unit 多次更新时只保留最新帧，当前广播结束后立即发送合并后的下一批。

关键字段：

- `in_flight/in_flight_units`：当前是否有广播在途，以及该批包含的 Unit 数。
- `pending_units`：当前待发区中的 Unit 数。持续增长表示下行速度低于状态产生速度。
- `max_pending_units`：广播在途期间待发区的历史峰值，不包含能够立即发送的正常批次。
- `max_in_flight_units`：实际广播批次包含的 Unit 数历史峰值。
- `queued_frames_total`：进入广播调度器的原始移动帧数。
- `coalesced_frames_total`：被同一 Unit 更新覆盖的旧帧数；这是主动丢弃过时状态，不是网络丢包。
- `sent_frames_total`：实际进入广播批次的最新状态数。
- `broadcasts_started_total/broadcasts_completed_total`：开始和完成的广播批次数。
- `broadcast_failures_total`：广播 Promise 失败数；失败不会停止后续批次。
- `last/max/total_duration_ms`：广播 Promise 从调用到完成的耗时。
- `last/max/total_queue_wait_ms`：一批状态从进入空待发区到真正开始广播的等待时间。

容量测试会把这些字段自动汇总到报告的“Map 广播 single-flight”表格。重点观察 `pending` 是否长期存在、合并率是否突然升高、`广播 max` 和 `排队 max` 是否随玩家数出现拐点。

## NativeData 指标

使用 Rust 权威实体数据时，每 5 秒输出：

```text
[native-data-metrics] process=map1 scalar_gets=... scalar_sets=... batch_calls=... live_entities=... live_units=... encoded_frames=... encoded_items=... encoded_bytes=...
```

- `scalar_gets/scalar_sets`：TS 通过点状 fast op 访问 Rust Unit 数据的次数；热循环中持续偏高通常说明批量 API 可能更划算。该指标只观测，不限流、不拒绝调用，也不改变业务行为。
- `batch_calls`：NativeData 地图批量调用次数。
- `live_entities`：Rust generation Arena 中全部存活实体数，用于发现 Item 等非 Unit 实体泄漏。
- `live_units`：Rust Arena 中存活 Unit 数；玩家全部离开后应回到 0。
- `encoded_frames/encoded_items/encoded_bytes`：Rust 直接 protobuf 投影的帧数、Unit 数和唯一帧字节数；逻辑下行还要乘以收件人数。

## 链路耗时

日志格式：

```text
[latency:gate1] scene=gate_1 type=Gate name=protocol.handler msgcode=11001 count=10000 avg_ms=0.032 p50_ms=0.050 p95_ms=0.100 p99_ms=0.250 max_ms=1.200
```

当前采集项：

- `ingress.queue`：frame 进入 TS 入站队列后，到被 EntryScene 取出处理前的等待时间。
- `frame.total`：EntryScene 处理单个 frame 的总耗时，包含路由、协议、Handler、返回帧生成。
- `protocol.decode`：protobuf payload 解码耗时。
- `protocol.handler`：业务 Handler 耗时；异步 Handler 统计到 Promise 完成。
- `protocol.encode`：response protobuf 编码耗时。
- `scene.call.local`：同进程 EntryScene RPC 调用耗时。
- `scene.call.remote`：跨进程 EntryScene RPC 调用耗时，包含 Inner TCP 往返和目标处理。
- `scene.send.local`：同进程单向消息投递耗时。
- `scene.send.remote`：跨进程单向消息投递耗时。

`msgcode=-` 表示该指标不绑定单个协议号，例如入站队列等待。其他指标会尽量带上请求 `msgcode`，方便区分登录、移动、探针等消息。

### Prometheus 关键指标

- `tiangz_transport_inner_pending_calls`：内网 RPC 等待队列长度，持续上升说明跨进程调用比返回慢。
- `tiangz_transport_inner_overload_rejections`：内网 transport 队列满导致新调用被直接拒绝，说明需要提升 `process.observability.remoteTransportQueue` 或拆分热点进程。
- `tiangz_transport_inner_timed_out_calls`：跨进程调用超时，常见于目标进程阻塞或对端连接异常。
- `tiangz_transport_inner_disconnected_calls`：在链路断开时丢弃的调用数量，和 `disconnects` 联动可定位网络抖动。
- `tiangz_native_encoded_bytes_total`：Native snapshot 下发编码字节，通常比 TS 下发在高并发场景更直观体现下行压力。
- `tiangz_scene_latency_ms_bucket`：标准 Histogram bucket；Grafana 使用 `histogram_quantile()` 计算可聚合的 P50/P95/P99。

## 使用方式

压测时先看客户端端到端 p95/p99，再对照服务端日志：

```text
客户端 p99 高，protocol.handler 不高，ingress.queue 高：TS mailbox 或入站队列拥塞。
客户端 p99 高，scene.call.remote 高：跨进程 Inner TCP 或目标进程处理慢。
protocol.decode/encode 高：protobuf 编解码或 payload 结构需要优化。
protocol.handler 高：业务 Handler 本身慢。
rust_queue/backpressure 高：Rust 到 V8 事件队列成为瓶颈。
slow_disconnects 增长：客户端下行消费慢或广播过量。
```

这些指标是第一版工程诊断口径。所有带 `_total` 的 NativeData 和 Runtime Counter 都是进程生命周期累计值，不会因 5 秒快照而清零；区间速率统一交给 Prometheus 的 `rate()`/`increase()` 计算。

## TypeScript CPU 火焰图

链路耗时只能回答“慢在哪个阶段”，CPU Profile 用来回答“哪个函数占 CPU”。Runtime 配置中开启 `process.debug` 后，可以通过 V8 Inspector 采样并生成 `.cpuprofile`。

采集火焰图时建议关闭 `process.observability.latency`，避免 `nowMs`、`LatencyRecorder.record`、直方图快照出现在热点里：

```powershell
npm run profile:ts -- --port 9231 --duration 30 --out perf/results/map_150.cpuprofile
```

推荐流程：

1. 使用带 sourcemap 的 bundle 构建，便于把热点定位回 TS 源码：

   ```powershell
   npm run build:debug
   cargo build --release --bin TiangZ
   target\release\TiangZ.exe configs/local/all.json
   ```

2. 另开终端启动 CPU 采样：

   ```powershell
   npm run profile:ts -- --port 9231 --duration 30 --out perf/results/all.cpuprofile
   ```

3. 第三个终端启动压测：

   ```powershell
   node dist/full_chain_load_test.cjs --host 127.0.0.1 --manager-port 7000 --players 150 --warmup 3 --duration 30 --move-rate 5
   ```

`.cpuprofile` 可以用 Chrome DevTools 的 Performance 面板加载，也可以用 <https://www.speedscope.app/> 打开。分析时先看 `Self Time` 高的函数；`Total Time` 高但 `Self Time` 低通常说明它只是调用链入口。

注意：

- CPU Profile 采样本身有开销，结果用于找热点，不作为正式吞吐指标。
- sourcemap/debug bundle 可能影响绝对性能；对比优化前后时保持同一构建模式。
- split 模式每个 Process 都需要单独 Inspector 端口和单独 `.cpuprofile`。

Process bridge 的累计计数包括 `inbound_frames`、`host_completions`、`disconnects`、`runtime_updates`、`runtime_events` 和 `max_runtime_batch`。当 Rust queue 有流量而 TS `processed` 不增长时，用这些值判断问题位于网络接收、completion 洪峰、V8 注入还是 TS mailbox；单向 Message 正常情况下不会增加 `host_completions`。

`runtime_events / runtime_updates` 可近似观察实际批量度。该值过低且 CPU 偏高，通常表示 V8 update 调用太频繁；该值很高且 `ingress.queue`、客户端 p95/p99 上升，则说明批次或聚合窗口过大。调度模式和覆盖字段见“配置与协议参考”。

`[process-metrics]` 中的 `dropped_logs` 是当前进程控制台与文件非阻塞队列累计丢弃的日志行数。正常运行应保持为 0；持续增长说明日志生产速度超过输出能力，应降低日志级别、限制重复错误或提高采集端吞吐，不能改为阻塞游戏线程来掩盖问题。
