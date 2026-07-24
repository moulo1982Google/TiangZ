# 长稳测试

长稳测试复用完整链路压测：玩家依次完成 LoginMgr、Login、Gate、进入地图，然后持续发送移动消息并接收地图广播。它主要观察错误、延迟恶化、队列积压，以及 Runtime 和压测客户端的 RSS/V8 Heap 长期增长趋势。

## 10 小时标准命令

在空闲机器的工程根目录执行：

```powershell
npm run perf:soak -- --hours 10 --mode split --players 200 --move-rate 5
```

该命令会先生成代码、完成 TypeScript 构建并编译 Release Runtime，然后启动拆分进程拓扑。正式采样前默认预热 60 秒。测试期间不要同时运行 Cocos、其他压测或 CPU Profile。

只检查参数和最终展开命令，不启动服务与压测：

```powershell
node perf/soak/run_soak.mjs --hours 10 --mode split --players 200 --move-rate 5 --dry-run
```

## 输出

- `perf/results/soak_latest.json`：机器可读结果，包含延迟、错误、吞吐、服务端与压测端内存趋势。
- `perf/results/soak_latest.md`：人工验收摘要。
- `perf/results/logs/soak_<时间>/`：各 Runtime 标准输出与错误日志。

测试完成后保留上述三个位置。验收时重点检查：

1. `errors`、`stalled`、背压和广播失败是否为零。
2. 后半程 p95/p99 是否持续恶化，而不是偶发抖动。
3. `rssGrowthBytesPerHour` 与 `v8HeapGrowthBytesPerHour` 是否在预热后仍持续正增长。
4. `live_entities`、`live_units`、定时器和连接数量是否与在线玩家规模一致。

单次“起点到终点”的增长只能用于发现明显泄漏，不等于严格的内存泄漏证明。若增长异常，应结合 Runtime 日志和分阶段采样重复验证。
