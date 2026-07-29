# 传输协议与 I/O Backend

## 边界

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

客户端建立Gate会话后每5秒发送一次业务层`C2G_Ping`。Gate以任意客户端入站帧刷新Route存活时间，连续30秒无入站消息才关闭`connectionId`并调用Map的最终`PlayerOffline`。普通transport disconnect只进入30秒重连宽限，不立即删除Map Unit。该机制与KCP自身的UDP会话回收不是同一层：前者判断游戏玩家是否最终离线，后者负责传输资源兜底。

## 配置

默认配置无需修改，仍然使用 epoll 和协议自动探测：

```json
{
  "process": { "name": "gate1" },
  "scenes": [
    { "name": "gate_1", "sceneType": "Gate", "ip": "127.0.0.1", "port": 7201 }
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
      "ip": "127.0.0.1",
      "port": 7201,
      "protocol": "tcp"
    }
  ]
}
```

完整单进程示例见 `configs/experiments/all.io-uring.json`。

配置限制：

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
