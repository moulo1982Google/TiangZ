# 可观测性与链路耗时

Runtime 每 5 秒输出一次进程和 Scene 指标。Scene 快照也只在这个采样点生成和 JSON 序列化，普通 Tick 不承担 metrics JSON 开销。链路耗时在 TypeScript Core 内聚合为直方图，只输出统计结果，不逐条打印消息。

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
- `failed`：处理过程中抛出未被协议层转换的失败数。
- `ts_queue`：当前 TS 入站队列长度。
- `ts_max_queue`：该进程启动以来 TS 入站队列峰值。
- `rust_queue`：Rust 到 V8 的进程事件队列当前长度。
- `rust_max_queue`：Rust 进程事件队列峰值。
- `backpressure`：Rust 入站队列满后等待次数。
- `slow_disconnects`：下行队列超过限制后被断开的慢连接数。
- `handler_ms/max_handler_ms/total_handler_ms`：EntryScene frame 处理耗时。

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

这些指标是第一版工程诊断口径。后续接 Prometheus/Grafana 时，应沿用相同名称和含义，只替换输出后端。

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
