# 框架性能回归门

该门只验证可重复的框架能力：RPC Payload、同/跨 Process Inner RPC，以及 Rust 状态复制。完整玩法容量与长稳仍使用独立命令，不进入日常质量门。

首次在一台固定性能机器上建立基线：

```bash
npm run perf:gate:update -- --reason "建立当前机器初始基线"
```

后续比较：

```bash
npm run perf:gate
```

工具按平台、架构、CPU 和逻辑核匹配基线，运行三轮并取中位数。吞吐低于基线 90%、p99 超过配置容差或出现任何错误时返回非零退出码。参数与容差集中在 `performance_gate.config.json`；修改参数会要求显式更新基线。

基线更新是评审动作，`--reason`为必填项；工具会在`perf/results/gate`生成旧值、新值和变化比例评审报告。不应为了让失败测试变绿而直接执行。
