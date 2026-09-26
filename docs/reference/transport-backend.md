# 传输协议与 I/O Backend

## 边界

0.7 新增 `tiangz_process_host_backing_store_{bytes,max_bytes,buffers,created_total}`，按固定 Process 标签观测已经交给 V8、最后 Native/V8 所有者尚未释放的原 Host 整块存储。小视图仍持有整批，GC 尚未回收也计入；包含帧/completion，但不含显式业务复制、其他 op、转换前 Vec、分配器或总堆。计数不在请求结束时提前清零，不因观测增加强制 GC 或容量拒绝；高水位不是限额，当前值也不是泄漏证明。实现/实际 V8 证据与后续硬额度边界见[Host backing store](../design/v0.7-host-backing-store.md)。

0.7 控制入站在 Process 全部 listener、Native 队列、Host 批次与 TS 之间共用 **65536** 个未开始名额。Inner RPC 满额返回既有 1011；Disconnect 等待留在原连接/Session 清理中并保留连接名额，实际开始或丢弃未执行节点才确认归还。搬入忙碌 Scene mailbox、Rust 出队或 V8 拷贝都不代表开始；Host completion/Shutdown 不占此额度，避免妨碍完成与释放。指标 `tiangz_control_ingress_{reserved,capacity,max_reserved,rejections_total,waits_total}` 只带固定 Process 标签。新增必需 Model 确认入口，部署须完整重建并重启；无新增配置或插件版本变更。该数量不包含已开始 Handler、普通数据与任意 TS 对象/字节，详见[所有权和验收](../design/v0.7-control-ingress.md)。

0.7 Rust→V8 packed event 单批另限 64 MiB（含 4 字节数量与每条 13 字节头），普通 Update 和停机 completion 路径共用。满批执行 Update 后再继续，无新增配置字段。两条接收通道各可保留一个队首事件，保持原字节守卫与 FIFO；物理 mpsc 槽位外最多另有两条，控制通知不被暂存数据挡住。拆批不截断 payload、不产生业务过载；无法放入空批的异常内部事件复制前明确失败。其指标为 `tiangz_process_host_event_batch_{limit_bytes,max_bytes,splits_total}`，不能当作 V8/TS 存活副本或进程内存总量，见[批次契约](../design/v0.7-host-event-batches.md)。

0.7 准入修正：`inner` 只接受通过凭据认证的内部 TCP，`outer` 只接受外部连接，`mixed` 允许两者。TCP/Auto 在 writer 注册前执行该规则；WebSocket 在 HTTP Upgrade 前检查外部准入。内部身份和内部 msgcode 校验继续生效。WebSocket 解码器的单帧、分片消息均限制为既有 1 MiB，避免接收超大载荷后才检查逻辑帧。

网络层分成两个正交维度：

- `IoBackend` 决定操作系统如何执行 I/O，当前为 `epoll` 或 `io-uring`；
- `EndpointProtocol` 决定连接采用哪种传输协议，当前为 `tcp`、`websocket`、`kcp` 或开发期 `auto`。

二者共同负责 Scene Endpoint 的监听、连接生命周期、收发、逻辑帧提取和连接级背压。协议适配器最终都向 Process 提交统一的 `ProcessEvent::Frame`，并消费统一的共享 `Bytes` 下行队列。

以下内容不随协议或 I/O Backend 分叉：

- msgcode 与 protobuf 编解码；
- RPC ID、多路复用和 Handler 分发；
- Scene、Actor、Mailbox 与 Game.Update；
- Rust/V8 二进制 Bridge；
- 连接队列容量和慢客户端断开规则。

当前 I/O Backend：

- `EpollIoBackend`：默认 Backend；Linux 上由 Tokio/mio 使用 epoll；
- `UringIoBackend`：Linux 实验 Backend，每个 TCP Endpoint 使用一个 io_uring Runtime 线程。

当前协议：

- `tcp`：`[u32 length][frame]` 流协议，epoll 与 io_uring 均支持；
- `websocket`：二进制 WebSocket，当前由 epoll Backend 支持；
- `auto`：读取连接前导数据，在 TCP 与 WebSocket 间探测；当前 Gate 同端口兼容内部 TCP 和浏览器 WebSocket 时需要使用它；
- `kcp`：UDP + KCP 可靠消息协议，当前由 epoll Backend 支持；包含 Challenge 握手、连接 ID、超时回收、CLOSE 和队列背压。

0.7 的 Auto 探测会等待完整三字节前缀，允许 `G/ET`、`GE/T` 分片；已读字节原样交还 HTTP 握手或 TCP 前导解析，不使用重复 peek 的忙轮询。Auto 从开始接收握手起共用 **5000ms 墙钟期限**，覆盖协议探测、WebSocket HTTP 升级或内部 TCP 凭据校验；新分片不重置期限。到期即关闭尚未注册的连接。客户端应在建立连接后立即发起握手，不能依赖空闲预连永久保留。该首批期限采用现有 DBProxy 握手默认值的量级，但两者配置独立；后续统一网络预算以版本化配置契约为准。

第二批已将同一 **5000ms** 握手期限扩展到显式 `tcp`/`websocket` 与 io_uring TCP；空闲预连须及时发出前导。该期限不是业务 RPC 超时，也不是首帧之后的读写期限；连接总量与慢写期限仍分别验收。本地 Windows Socket 用例不能替代 Linux/io_uring/KCP 的联合运行验收。

客户端建立Gate会话后每5秒调用一次`C2G_Ping -> G2C_Ping`，回包包含Gate的Unix毫秒时间。Gate以任意客户端入站帧刷新Route存活时间，连续30秒无入站消息才关闭`connectionId`并调用Map的最终`PlayerOffline`。普通transport disconnect只进入30秒重连宽限，不立即删除Map Unit。该机制与KCP自身的UDP会话回收不是同一层：前者判断游戏玩家是否最终离线，后者负责传输资源兜底。

## 配置

0.7 的 `maxKcpBufferedBytes` 为全部 KCP listener 的独立共享保守额度，默认 64 MiB，整数 1..1073741824，每 Session 另限 4 MiB。覆盖 C 控制块/MTU 工作区、收发与未确认段、保留 ACK 数组、尚未释放的输出 Bytes；创建、输入、发送与输出复制前准入，并覆盖 ACK 连续扩容的瞬时峰值。纯 ACK 在额度满时仍可释放已确认数据，复合 PUSH 包保守预留。超过协定 MSS 的输入拒绝；额度不足/发送失败/输出回调失败只终结对应 Session，不能静默丢弃可靠数据或停止共享 listener。固定 `kind="kcp"` 指标属于同一 buffer 指标族，共享额度拒绝与单 Session 限额日志区分。接收和 UDP 封包副本、Rust 容器容量、allocator 元数据、系统/V8 不计在内，不能当作 RSS 上限。Rust KcpSession.update 现返回 Result、take_output 返回持有预算的 Bytes；握手/线协议保持。详见[KCP 预算](../design/v0.7-kcp-buffers.md)。

0.7 的 `process.network.maxIngressBufferedBytes` 独立限制 Rust Process 已解码帧，默认 67108864，整数 1..1073741824。TCP/WS/io-uring/KCP 共用，包含 Inner RPC 控制帧；首次入队前无等待预留，原 Bytes 移交不复制，等待帧数空位/出队/热更延后仍占额度，直到最后引用释放。额度满时 Inner RPC 保持原 rpcId 返回既有目标入口过载，外部/单向来源按接收错误关闭连接或 Session；Disconnect、Shutdown、Host completion 不占本项帧额度。指标复用 `tiangz_transport_buffer_bytes/limit_bytes/rejections_total`，固定 `kind="ingress"`，不算慢客户端。此处是逻辑帧字节，未包括解码器、Host 打包副本、V8/TS mailbox、completion 响应、KCP 内部或系统缓冲；契约与测试范围见[入站预算](../design/v0.7-ingress-buffers.md)。

默认配置无需修改，仍然使用 epoll 和协议自动探测：

```json
{
  "process": { "name": "gate1" },
  "scenes": [
    { "name": "gate_1", "sceneType": "Gate", "innerIp": "127.0.0.1", "port": 7201 }
  ]
}
```

io_uring 必须显式启用，并把本进程启动的 Scene 标记为 `tcp`：

```json
{
  "process": {
    "name": "gate1",
    "network": {
      "ioBackend": "io-uring",
      "uringEntries": 2048,
      "uringReadBufferBytes": 65536
    }
  },
  "scenes": [
    {
      "name": "gate_1",
      "sceneType": "Gate",
      "innerIp": "127.0.0.1",
      "port": 7201,
      "protocol": "tcp"
    }
  ]
}
```

完整单进程示例见 `configs/experiments/all.io-uring.json`。

配置限制：

- 0.7 新增 `maxAcceptedConnections`（默认 65536）和 `maxPendingHandshakes`（默认 1024），均为 1..1000000 整数。当前 Process 全部业务 listener 共享额度；TCP/Auto/WebSocket 在创建连接任务前取得连接与握手名额，超限即关闭新增 Socket，不排队等待额度。完成前导、认证和 HTTP 升级后归还握手名额，连接名额保留到任务销毁；失败、断开、取消/panic、停机均归还。两项独立配置，握手实际数量也受连接上限约束，不保证端点间公平。
- KCP 在有效 cookie 的 CONNECT 后取得同一 Process 连接名额；HELLO/Challenge 无 Session 分配，不占流握手名额，重复 CONNECT 复用已有 Session。KCP 既有每端点 65536 Session 上限仍生效。主动建立的 Inner 链接、健康 HTTP 不计入这两项业务入站额度；帧字节、KCP 未确认/重传缓存另行控制，连接数量上限不是整个进程的内存上限。
- `tiangz_transport_admission_in_use`、`tiangz_transport_admission_limit`、`tiangz_transport_admission_rejections_total` 使用固定 `kind="connection"|"handshake"`，分别观察当前占用、配置上限、即时拒绝总数，不附加连接 ID 或地址标签。并发读写时两个占用 gauge 为近似同时的快照。旧 `tiangz_process_active_connections` 继续表示已登记 writer，不能拿它代替握手计数。
- 0.7 新增 `writeTimeoutMs`，正整数 1..300000，默认 10000ms。每个出站批次从 writer 准入到完整写出共用期限，包含排队；主动 Inner 同时受原操作期限约束，批次取最早期限，出队不重置。KCP 只限制交给可靠传输前的宿主排队，不代表 ACK/重传完成。超过期限断开连接，部分写仍属于结果未知；0.6.x 宿主不接受此字段。
- 0.7 新增 `maxOutboundBufferedBytes`，整数 1..1073741824，默认 67108864（64 MiB）。全部已登记 ConnectionWriter 批次 payload 与主动 Inner 的 Host scene 整包共享预算；后者复制 V8 内容前预留，按整包（含头部）保守累计，最后一个 Bytes 切片释放才归还，覆盖待调度操作、manager/connection/writer 队列和写出。广播仍按接收者保守累计，每连接限制继续生效。Writer 总量不足拒绝发送并关闭连接；Host 整包超限则同步拒绝整批并走原操作号清理，不部分入队。由 `tiangz_transport_buffer_rejections_total{kind="outbound"}` 记录，不归入慢客户端计数。占用/上限分别为 `tiangz_transport_buffer_bytes` / `tiangz_transport_buffer_limit_bytes`，相同固定 kind 标签。资源守卫跨排队、写出与 KCP 转发持有，不承诺不同连接公平性。此项不包括 RPC 响应、入站/V8、系统 Socket 缓冲、KCP 内部未确认数据或 Rust 任务元数据，不是 Process 总内存上限。主动 Inner 会话销毁取消读写任务；成功写出立即释放当前批次，不能等下一条消息才归还。
- 开始关闭后，所有已接受批次共享 `process.lifecycle.stopTimeoutMs` 排空时间，不逐批重置。批次期限或关闭期限先到即停止；只有写出成功才记录完成指标。
- `uringEntries` 必须是 64 到 32768 之间的 2 次幂；
- `uringReadBufferBytes` 必须在 4KB 到 1MB 之间；
- 未在 Linux 上使用 `--features io-uring` 构建时，选择 io_uring 会明确启动失败，不会静默降级；
- Cocos Web 依赖 WebSocket，仍使用 epoll；Cocos Native 或服务器内部 TCP 才能使用当前 `UringIoBackend`；
- `network.backend`、`scene.transport` 和协议值 `raw` 作为旧配置兼容别名保留，新配置不要再使用。
- KCP 当前只允许 `audience=outer`。`inner` 会明确拒绝启动，直到内部身份认证和 Process 握手接入 KCP。

## 组合关系

| EndpointProtocol | epoll | io_uring |
|---|---:|---:|
| `tcp` | 支持 | 支持 |
| `websocket` | 支持 | 暂不支持 |
| `auto` | 支持 | 不支持 |
| `kcp` | 支持 Outer | 不支持 |

协议按 Scene Endpoint 选择，而不是按整个 Process 选择。当前一个 Scene 仍只有一个 Endpoint；后续增加多 Endpoint 配置后，同一个 Gate 可以同时开放 Native TCP、浏览器 WebSocket 和移动端 KCP 端口，而 RPC、protobuf、Handler 和 mailbox 不需要改变。

## KCP 实现选择

Runtime 不依赖预编译的 `kcp.so`，也不采用第三方纯 Rust 重写。`third_party/kcp` 固定收录 KCP 官方 C 实现的稳定 v1 分支 commit，Cargo feature `kcp` 启用时由 `build.rs` 静态编译进 Runtime：

```bash
cargo build --features kcp --bin TiangZ
```

选择静态源码集成是为了让 Windows/Linux 使用完全相同的协议内核，并避免目标机器安装动态库、动态库搜索路径、ABI 和版本漂移。Rust 的 `KcpSession` 封装 C 对象生命周期、`send/input/recv/update/check` 和 UDP 输出数据报队列；UDP socket、握手、会话 ID、防错误路由、队列限流、CLOSE 和超时回收由 `KcpTransport` 管理。握手用于防止伪造源地址直接放大会话资源，但它不是账号认证或加密协议。

当前单元测试覆盖消息边界、4096 字节分片以及确定性丢失一个 UDP 数据报后的重传。`kcp_smoke` 还会通过真实 UDP Endpoint 完成 protobuf RPC；Cocos Native Windows 已通过 LoginMgr、Login、Gate、MapReady 的完整 KCP 链路。

KCP Runtime 构建与 smoke：

```powershell
cargo test --features kcp --lib --bin TiangZ --bin kcp_smoke
cargo run --features kcp --bin TiangZ -- configs/experiments/all.kcp-native.json
```

启动 `all.kcp-smoke.json` 后，可以运行多会话 LoginMgr RPC 基准：

```bash
npm run perf:kcp-loginmgr -- 127.0.0.1:7000 256 5 20
```

四个参数依次为地址、KCP 会话数、预热秒数和正式测试秒数。每个会话串行执行 PingPong，结果输出 req/s、p50、p95、p99 和错误数。

KCP 根据 Endpoint 的 `audience` 选择固定 Profile：

| Profile | nodelay | wndsize | MTU | min RTO |
|---|---|---|---:|---:|
| Inner | `1, 10, 2, 1` | `1024, 1024` | 1400 | 30ms |
| Outer | `1, 10, 2, 1` | `256, 256` | 470 | 30ms |

外网 MTU 470 是当前框架的明确协议参数，不按操作系统默认 MTU 或常见互联网经验值自动放大。官方 v1 没有公开设置 `rx_minrto` 的函数，因此 `src/native/kcp_shim.c` 只补充 `min RTO` 的 set/get；固定的上游 `ikcp.c/ikcp.h` 保持原样，便于校验来源和未来升级。

## io_uring TCP 收发模型

接收侧为每条连接复用一个固定容量的读取 Buffer。一次 `recv` 得到的字节先进入流式解码器，解码器循环提取多个 `[u32 length][frame]`，保留不完整尾部供下一次读取继续解析。它不会为每个包单独执行一次4字节读取。

发送侧继续消费框架现有的连接下行队列，并在以下限制内合并帧：

- 每批最多 64 帧；
- 每批最多 256KB；
- 每批拼成一个连续 Buffer，提交一次 io_uring `write_all`；
- 完成后按照业务帧字节数扣减连接背压水位。

当前版本还没有使用注册 Buffer、provided buffer、multishot recv 或 send zero-copy。这些优化必须在现有全链路基线上逐项验证，不能仅凭微基准进入正式 Runtime。

## 构建与验证

Linux 编译：

```bash
cargo build --release --features io-uring --bin TiangZ
./target/release/TiangZ configs/experiments/all.io-uring.json
```

容量测试可以用同一个命令切换 Backend：

```bash
npm run perf:map-capacity -- \
  --io-backend io-uring \
  --gates 12 \
  --players 525 \
  --move-rate 5 \
  --probe-rate 1 \
  --warmup 10 \
  --duration 30 \
  --rounds 3
```

改为 `--io-backend epoll` 即可生成同口径对照结果。脚本会根据 I/O Backend 自动选择 Cargo feature，并在报告中输出 read/write 的 `frames/op`。旧参数 `--network-backend` 暂时作为兼容别名保留。

## 2026-07-21 初步结果

在 Linux `7.0.0-27-generic`、i7-13700F 虚拟机上，以 525 玩家、12 Gate、每玩家 5Hz Move 和 1Hz Probe 各运行一轮：

| Backend | Map CPU avg/p90 | Gate max avg | Move p99 | Probe p95/p99 | RSS |
|---|---:|---:|---:|---:|---:|
| epoll | 71.4% / 73.6% | 15.1% | 131.65ms | 8.70 / 33.53ms | 1440.2MB |
| io_uring | 67.5% / 70.2% | 12.7% | 107.04ms | 7.73 / 29.38ms | 1668.1MB |

两组都是 `2625 Move/s`、约 `137.8万 push/s`，错误、过载和背压均为 0。io_uring 已表现出 CPU 和尾延迟收益，但总 RSS 增加约 228MB；当前只有一轮探索结果，尚不足以改变默认 Backend。正式判断至少需要三轮、长稳测试和 Buffer/线程内存拆解。

## 指标

`[process-metrics]` 增加以下累计指标：

- `transport_read_ops`、`transport_read_frames`、`transport_read_bytes`；
- `transport_write_ops`、`transport_write_frames`、`transport_write_bytes`。

`frames/op` 越高，说明一次 Backend 读写批次摊销的逻辑帧越多。这里的 `op` 是框架观察到的异步读写批次，底层 `read_exact`、`write_all` 仍可能对应多次系统调用；最终是否采用 io_uring，仍以全链路 CPU、P95/P99、吞吐、错误率和背压为准。
