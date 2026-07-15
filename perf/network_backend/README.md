# Linux epoll 与 io_uring 网络基线

该测试只替换 Rust 服务端 TCP Backend，客户端、length-prefix、RPC payload、连接数和在途并发完全一致。它用于判断是否值得把 io_uring 集成到正式 Runtime，不代表完整业务吞吐。

## 运行

仅支持 Linux。建议内核至少 5.11：

```bash
uname -r
npm run perf:network-backend -- \
  --warmup 10 \
  --duration 60 \
  --connections 8 \
  --concurrency 512 \
  --workers 4 \
  --payloads 64,256,1024,4096,16384
```

测试自动以 `--features io-uring` 构建：

- epoll：`tokio::net::TcpListener/TcpStream`。
- io_uring：`tokio_uring::net::TcpListener/TcpStream`，每个 worker 线程一个 current-thread Runtime 和 ring，共享监听 socket。
- 两种 Backend 使用相同 `--workers`，默认 4；建议分别测试 `--workers 1` 和生产计划使用的线程数。
- 客户端：同一个 `runtime_load`。
- 协议：`[u32 length][u16 msgcode][protobuf payload]`。

结果写入：

```text
perf/results/network_backend_latest.md
perf/results/network_backend_latest.json
```

可以单独测试一个 Backend：

```bash
npm run perf:network-backend -- --backends epoll
npm run perf:network-backend -- --backends io-uring --uring-entries 2048
```

## 结果边界

`tokio-uring` 使用 completion-based API并拥有读写 Buffer；它不是 Tokio epoll socket 的透明开关。当前 `tokio-tungstenite` 依赖 Tokio `AsyncRead/AsyncWrite`，因此 WebSocket 不能直接切到该 socket。

只有当该基线在目标 Linux、目标内核和真实并发下表现出稳定收益，才进入正式 Runtime Backend 改造。正式验收还需覆盖 Raw TCP、WebSocket、Inner TCP、背压、断线、CPU 和 RSS。
