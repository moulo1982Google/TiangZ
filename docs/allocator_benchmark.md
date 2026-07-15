# Rust Allocator 对比测试

测试日期：2026-07-10。

## 测试目标

对比 MiMalloc 与 Windows 系统 allocator 对以下链路的影响：

1. Rust 与 V8 二进制桥接。
2. `msgcode -> decode -> handler -> response encode` 协议链路。
3. localhost Runtime TCP pingpong。

每种微基准交替运行 3 轮并取中位数。Runtime 使用相同参数运行 3 轮：

```text
duration=5s
warmup=1s
connections=8
concurrency=1024
payload=256B
delay=0ms
```

默认构建使用 MiMalloc：

```bash
cargo build --release
```

系统 allocator 构建：

```bash
cargo build --release --no-default-features
```

## Runtime 结果

| Allocator | 三轮 req/s | 中位数 req/s | p50 中位数 |
|---|---:|---:|---:|
| MiMalloc | 257,252 / 264,355 / 268,414 | 264,355 | 3.841 ms |
| 系统 allocator | 257,090 / 265,582 / 268,104 | 265,582 | 3.788 ms |

MiMalloc 的中位吞吐比系统 allocator 低约 `0.5%`，属于测试抖动范围。这条链路的主要成本不在通用堆分配器。

## Bridge 结果

`Uint8Array copy echo` 的中位吞吐变化：

| Payload | MiMalloc 相对系统 allocator |
|---:|---:|
| 64B | +6.6% |
| 256B | +15.7% |
| 1024B | +45.7% |
| 4096B | +98.7% |
| 16384B | +160.9% |

`Uint8Array len only` 没有稳定提升，符合预期：该路径不创建 Rust 侧副本。MiMalloc 的明显收益集中在 `JsBuffer -> Vec<u8> -> Uint8Array` 这类真实分配与复制路径。

## Protocol 结果

完整 pingpong 的中位吞吐变化：

| Payload | MiMalloc 相对系统 allocator |
|---:|---:|
| 64B | +6.7% |
| 256B | +5.7% |
| 1024B | +7.0% |
| 4096B | +23.3% |
| 16384B | -3.6% |

小中型消息有一定收益，但 16KB 时收益消失，说明大消息成本逐渐转向字节遍历、protobuf 编解码和内存带宽。

## 当前结论

- 默认保留 MiMalloc。
- MiMalloc 对 Rust 二进制复制路径有明确收益。
- MiMalloc 不会直接替换 V8 GC 堆或 V8 默认 ArrayBuffer allocator。
- localhost Runtime 吞吐没有显著提升，不能把更换 allocator 当作达到 30 万 req/s 的主要手段。
- 后续应持续使用真实游戏消息大小、连接数和 mailbox 负载复测。
