# 内部 Scene RPC 基线测试

这个测试用于区分两类成本：

- `local`：两个 Scene 在同一进程、同一 V8 内，通过 `SceneCallContext` 直接调用。
- `remote`：两个 Scene 拆成两个进程，通过内部 TCP transport 调用。

运行：

```bash
npm run perf:inner-rpc -- \
  --duration 10 \
  --warmup 2 \
  --connections 8 \
  --concurrency 512 \
  --call-count 1 \
  --delay 0
```

链路：

```text
Rust TCP Client
-> MailboxParityScene
-> SceneCallContext
-> BenchScene.BenchInner.RuntimePing
-> MailboxParityScene
-> TCP Response
```

`call-count` 表示每个外部请求内部调用多少次 `BenchInner.RuntimePing`。默认 1，用于测单次内部 RPC 基线。
