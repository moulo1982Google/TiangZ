# 单 MapHost 同屏容量测试

这个测试用于回答：在增加 Gate 数量、避免 Gate 先成为瓶颈后，一个单线程业务 MapHost 在最坏全量同屏广播下能承载多少玩家。

测试拓扑固定为一个 MapHost，可通过 `--gates` 横向增加 Gate。每个玩家同时执行：

- `10Hz C2M_Move`，触发同地图全量广播。
- `1Hz C2M_MapProbe`，经过客户端、Gate、MapHost 和返回链路，但不触发广播。

默认执行：

```bash
npm run perf:map-capacity
```

常用参数：

```bash
npm run perf:map-capacity -- \
  --gates 4 \
  --players 100,125,150,175,200 \
  --move-rate 10 \
  --probe-rate 1 \
  --warmup 10 \
  --duration 30 \
  --rounds 1 \
  --target-map-cpu 85
```

报告生成到 `perf/results/map_capacity_*.md`。容量点必须同时满足：

- MapHost 平均 CPU 不超过目标值。
- 实际 Move 吞吐至少达到设定频率的 95%。
- Move 和 MapProbe 没有超时。
- 内部传输没有 overload。

CPU 的 100% 表示占满一个逻辑核。当前广播仍是全地图全量可见，因此结果代表没有 AOI 切割时的最坏同屏模型。
