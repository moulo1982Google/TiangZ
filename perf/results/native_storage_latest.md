# Native数据布局基准

- 时间：2026-07-28T03:57:09.101Z
- 机器：13th Gen Intel(R) Core(TM) i7-13700F / 24逻辑核 / win32-x64
- 负载：50,000 Unit，平均每Unit 10 Item
- 计时：预热20轮，每轮200次Unit热更新，共5轮取中位数
- 边界：只测试数据布局与热循环；不包含AOI、网络、protobuf、V8或业务Handler
- 正确性：三档checksum一致（875399479296）

## 结构尺寸

| 结构 | 字节 |
|---|---:|
| NativeEntityData enum | 608 |
| UnitData | 600 |
| ItemData | 28 |
| UnitHotData | 60 |
| UnitColdData | 544 |

## 结果

| 布局 | 中位耗时 | 百万Unit更新/秒 | ns/Unit | 估算存储 | 吞吐相对前档 |
|---|---:|---:|---:|---:|---:|
| Handle Arena基线 | 127.76ms | 78.27 | 12.78 | 323.5MiB | - |
| UnitPool + ItemPool | 56.88ms | 175.81 | 5.69 | 42.0MiB | 124.6% |
| UnitHotPool + UnitColdPool | 16.21ms | 617.02 | 1.62 | 42.2MiB | 251.0% |

## 纯Unit控制组

控制组不创建Item，用于区分enum/句柄本身的成本与异构工作集的成本。

| 布局 | 中位耗时 | 百万Unit更新/秒 | ns/Unit | 估算存储 | 吞吐相对前档 |
|---|---:|---:|---:|---:|---:|
| Handle Arena基线 | 63.30ms | 157.97 | 6.33 | 29.8MiB | - |
| UnitPool + ItemPool | 57.84ms | 172.89 | 5.78 | 28.6MiB | 9.4% |
| UnitHotPool + UnitColdPool | 16.22ms | 616.57 | 1.62 | 28.8MiB | 256.6% |


## 解释

Handle Arena复刻当前异构Entity槽位与Unit句柄跳转；类型分池让Unit热循环不再跨过Item槽位；冷热分池进一步让每Tick只触碰自动生成的UnitHotData。该结果只回答存储布局收益，不代表AOI或完整游戏容量。
