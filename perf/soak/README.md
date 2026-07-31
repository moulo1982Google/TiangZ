# 长稳测试

长稳测试复用完整链路压测：玩家依次完成 LoginMgr、Login、Gate、进入地图，然后持续发送移动消息并接收地图广播。它主要观察错误、移动请求到自身权威 Push 的闭环延迟、队列积压，以及 Runtime 和压测客户端的 RSS/V8 Heap 长期增长趋势。

## 10 分钟预检命令

在空闲机器的工程根目录执行：

```powershell
npm run perf:soak -- --minutes 10 --mode split --players 200 --move-rate 2
```

该命令会先生成代码、完成 TypeScript 构建并编译 Release Runtime，然后启动拆分进程拓扑。正式采样前默认预热 60 秒。测试期间不要同时运行 Cocos、其他压测或 CPU Profile。

预检通过后，10 小时正式长稳使用 `--minutes 600`。

只检查参数和最终展开命令，不启动服务与压测：

```powershell
node perf/soak/run_soak.mjs --minutes 10 --mode split --players 200 --move-rate 2 --dry-run
```

## 输出

- `perf/results/soak_latest.json`：机器可读结果，包含延迟、错误、吞吐、服务端与压测端内存趋势。
- `perf/results/soak_latest.md`：人工验收摘要。
- `perf/results/logs/soak_<时间>/`：各 Runtime 标准输出与错误日志。

测试完成后保留上述三个位置。验收时重点检查：

1. Move 确认数是否接近发送数，以及 `errors`、`stalled`、背压和广播失败是否为零。延迟分位数使用有界均匀样本，不会随测试时长无限占用内存。
2. 后半程 p95/p99 是否持续恶化，而不是偶发抖动。
3. RSS/V8 Heap 的首尾折算值与后 1/4 线性斜率是否同时持续为正；阶跃后平台化不能直接判为泄漏。
4. `live_entities`、`live_units`、定时器和连接数量是否与在线玩家规模一致。

单次“起点到终点”的增长只能用于发现明显泄漏，不等于严格的内存泄漏证明。JSON 会保留压测端的完整内存时间序列，服务端时间序列保留在 Runtime 日志中；若增长异常，应结合后半程斜率和分阶段采样重复验证。
