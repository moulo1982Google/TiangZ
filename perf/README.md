# 性能测试

本目录记录运行时的本机微基准和完整链路负载测试。

## 框架性能回归门

固定性能机器首次使用`npm run perf:gate:update`显式建立基线，后续使用`npm run perf:gate`或`npm run verify:perf`执行三轮中位数比较。该命令检查RPC Payload、同/跨Process Inner RPC和Rust状态复制；配置、容差与基线更新规则见[gate/README.md](gate/README.md)。

## 跨平台 RPC 基线

Windows 和 Linux 使用相同命令：

```bash
npm run perf:rpc-baseline
```

它会自动构建、启动 `BenchScene`、执行 5 档 Payload、关闭 Runtime，并生成 Markdown/JSON 报告。Linux 环境准备和完整参数见 [rpc_baseline/README.md](rpc_baseline/README.md)。

## 全链路测试

运行：

```bash
npm run perf:full-chain
```

该命令同时执行框架 RPC Payload 基线，以及真实的
`LoginMgr -> Login -> Gate -> MapHost -> AOI Push -> Client` 闭环，并比较单进程多 Scene 与拆分进程部署。

完整矩阵、指标口径和结果文件见 [full_chain/README.md](full_chain/README.md)。

单 MapHost 的 3000 玩家回归和运行中 Hotfix 测试口径见 [hotfix/README.md](hotfix/README.md)。Hotfix 用例会区分候选构建耗时与真正的业务切换耗时，并验证现有玩家、连接和 Native handle 不重建。

## Bridge 性能

运行：

```bash
npm run perf:bridge
```

默认测试以下 payload 大小：

```text
64, 256, 1024, 4096, 16384
```

可选参数：

```bash
npm run perf:bridge -- <iterations> <payload-bytes|sweep|comma-sizes> <warmup>
```

示例：

```bash
npm run perf:bridge -- 200000 256 5000
npm run perf:bridge -- 100000 sweep 5000
npm run perf:bridge -- 100000 64,256,1024 5000
```

测试项目：

- `base64 string echo`：JS 把 base64 字符串传入 Rust op 并原样返回。
- `base64 decode+encode`：Rust 解码并重新编码 base64 payload。
- `Uint8Array copy echo`：JS 传入 `Uint8Array`，Rust 复制到 `Vec<u8>` 后再返回 `Uint8Array`。
- `Uint8Array len only`：Rust 只读取 `Uint8Array` 长度，不返回消息帧。

报告把一次迭代视为一个请求帧，因此 `req/sec` 表示同一桥接调用的请求吞吐。`vs prev` 表示当前 payload 的吞吐相对上一个 payload 的变化，用于观察性能骤降拐点。

这不是完整游戏服务器基准，只用于测量桥接调用形态和 payload 搬运成本。

## Protocol 性能

运行：

```bash
npm run perf:protocol
```

默认测试以下 PingPong payload 大小：

```text
64, 256, 1024, 4096, 16384
```

可选参数：

```bash
npm run perf:protocol -- <iterations> <payload-bytes|sweep|comma-sizes> <warmup>
```

示例：

```bash
npm run perf:protocol -- 20000 sweep 2000
npm run perf:protocol -- 100000 64,256,1024 5000
```

基准使用模拟的 `PingRequest` / `PingResponse`：

- 请求帧：`[msgcode:u16][protobuf payload]`
- 请求 payload：`rpc_id:uint32`、`seq:uint32`、`payload:bytes`
- 响应 payload：`rpc_id:uint32`、`seq:uint32`、`payload:bytes`

测试项目：

- `msgcode lookup`：读取 msgcode 并查找协议描述符。
- `protobuf decode`：解码请求 payload。
- `response encode`：编码复用的响应对象。
- `pingpong full`：完整执行 `msgcode -> descriptor -> decode -> handler -> response encode`，Handler 每次创建新响应对象。
- `pingpong pooled resp`：执行相同完整链路，但 Handler 复用响应对象。

该测试用于隔离 Rust 已经去除 length-prefix 之后的 TS 协议层开销。

## Runtime 本机负载

运行 Node 客户端基线：

```bash
npm run perf:runtime
```

命令会构建 release Runtime，在 `127.0.0.1:7400` 启动 `BenchScene`，并测试完整链路：

```text
TCP 消息帧 -> Rust 有界入站队列 -> V8 -> protobuf 解码 -> Handler
           -> protobuf 编码 -> 有界连接写队列 -> TCP 响应
```

默认参数为 4 个持久连接、128 并发、256B payload、预热 2 秒、正式测试 10 秒。报告包含请求/秒、延迟分位数、错误数、队列峰值和背压计数器。

Node 客户端适合检查 TypeScript 客户端工具链。为了排除 Node socket/事件循环上限，使用 Rust 客户端测试 Runtime 容量：

```bash
npm run perf:runtime:rust
```

自定义 Rust 客户端参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/runtime_load_test.ps1 `
  -Release -Client rust -Duration 10 -Warmup 2 `
  -Connections 8 -Concurrency 1024 -Payload 256
```

运行带断言的过载场景：

```bash
npm run test:backpressure
```

Phase 1.9 的容量限制见 `docs/phase1_9_acceptance.md`；同步/异步 Handler 和热路径性能结果见 `docs/phase1_10_acceptance.md`。
