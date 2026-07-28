# TiangZ 开发日志

本文记录已经发生的工程变更、验证结果和当时的取舍。未来计划仍以 [路线图](roadmap.md) 为准，稳定架构约束以 [AI 项目上下文](ai/project-context.md) 和 [AI 业务开发手册](ai/business-development-manual.md) 为准。

维护约定：

- 最新记录放在最前面，使用日期和版本作为标题。
- 记录目标、实现、验证、设计决定和遗留问题，不复制完整提交清单。
- 公共 API、配置、数据所有权或业务开发方式发生变化时，同步更新对应教程以及两份 AI 文档。
- 性能数字必须注明拓扑、负载和边界，微基准不得直接写成整服容量结论。

## 2026-07-28 - v0.3.10-alpha.9

### 本次目标

把Item、Buff、动态Quest和Achievement等“Component拥有的多个实例”收敛为框架级子Entity语义，同时验证新增生命周期索引不会成为性能瓶颈。

### 完成内容

- Stable Core新增`ChildEntity`以及`AddChild/GetChild/TryGetChild/GetChildren/RemoveChild`，统一Parent、DomainScene、InstanceId、EntityRoot、Timer与级联销毁。
- ChildEntity明确没有mailbox、Actor路由和网络地址；挂在Unit下的Timer仍经过所属Unit mailbox串行。
- Item从ItemComponent私有Map和伪InstanceId迁移为真实ChildEntity；每个Item拥有自己的NativeItemRef，局部规则与集合规则分别位于ItemSystem和ItemComponentSystem。
- 创建失败、异步Awake拒绝、重复Id、Timer取消、Root清理、Component/Actor级联销毁和Hotfix System候选均加入自动测试。
- 新增`npm run perf:child-entity`，独立测量框架对象语义，不把AOI、Native、protobuf和网络混入结果。
- 新增`docs/patterns`领域设计知识库，使用稳定规则编号描述所有权、Entity形态、Audience、同步、生命周期、Timer与数据位置。
- TiangZ Developer Tools `v0.13.0`增加确定性`design-core`、业务系统设计向导、`@tiangz`解释入口、CLI与只读MCP服务；AI不改变规则结论，也不自动修改业务代码。
- Developer Tools `v0.13.0`已发布Tag并成为主工程固定依赖；新增`verify:design-rules`交叉检查24条稳定规则及其领域文档归属。

### 性能验证

Windows Node 24、单进程、100,000个纯TS ChildEntity、1,000,000次随机查询：创建约47.24ms（2.12M/s），查询约92.93ms（10.76M/s），稳定数组遍历约4.15ms，销毁约22.80ms（4.39M/s），保留V8 Heap约506字节/实例。该结果只说明容器和生命周期开销可控，不能推导地图或AOI容量。

### 设计决定

- Unit是带mailbox的地图Actor；Item/Buff/动态Quest是Component拥有的本地ChildEntity。是否需要被AOI看到不决定它是否是Actor。
- Buff采用生命周期事件而不是通用dirty Delta：创建广播Add、删除广播Remove，进入AOI时随Unit整体Snapshot发送；Tick只执行Action，产生的Numeric、Move等变化由对应领域同步。
- QuestComponent只为进行中任务持有Quest子Entity；完成时记录稳定配置ID并删除实例。任务进度默认只同步本人，组队共享通过显式Party受众发送摘要，不进入地图AOI。
- 少量子Entity可直接持有Timer；大量Buff由BuffComponent按`nextTickAt/expireAt`合并调度，避免每个Buff常驻重复Timer。
- `GetChildren`返回数组快照，只用于低频管理、保存和全量同步；高频帧尾路径必须维护dirty集合或紧凑索引。

## 2026-07-28 - v0.3.10-alpha.8

### 本次目标

验证 Rust 权威实体数据从通用 Handle Arena 迁移到类型分池、冷热分离后的收益，并减少帧尾状态编码与广播路径中的临时分配。同时补齐可观测指标和可重复执行的性能基准。

### 完成内容

- `.native` 增加实体存储和字段温度描述，由 codegen 生成 `NativeEntityPools`、类型 Pool、Unit 热/冷数据结构以及 TypeScript NativeRef 操作。
- Unit 与 Item 进入独立紧凑 Pool；Unit 的高频字段与低频字段分离存放。Rust 仍是权威数据源，TypeScript 只持有带 generation 校验的句柄。
- 帧尾移动快照直接编码到最终输出缓冲，复用 handles、records 和编码 scratch，避免逐玩家临时 `Vec` 与 Rust -> TypeScript -> Rust 往返。
- health/Prometheus 增加活跃 Entity、Unit、Item，Pool/Scratch 容量与增长次数、TypeScript NativeRef 数量、Native 编码吞吐等指标。
- 新增 `npm run perf:native-storage`，独立比较 Handle Arena、类型分池和 Unit 冷热分离。
- Map 容量工具在普通测试中也为每个 Process 启用临时 health 端口，直接采集 CPU、RSS、V8、Transport、NativeData 和广播指标；累计计数按正式窗口差值换算速率。
- TiangZ Developer Tools 升级到 `v0.12.0`，Native Language 升级到 `v0.14.0`，补齐 Model 稳定字段和 `.native` 存储语义支持。

### 性能验证

Native 数据布局微基准：50,000 Unit、每 Unit 10 Item、Release 构建，5 轮取中位数。

| 布局 | 更新吞吐 | 估算存储 | 相对前档 |
|---|---:|---:|---:|
| Handle Arena | 78.27M Unit/s | 323.5MiB | - |
| UnitPool + ItemPool | 175.81M Unit/s | 42.0MiB | +124.6% |
| UnitHotPool + UnitColdPool | 617.02M Unit/s | 42.2MiB | +251.0% |

完整游戏链路三轮基线：Windows IOCP、1 MapHost、16 Gate、3000 玩家、每玩家 5Hz Move + 1Hz MapProbe。

| 指标 | 三轮中位数 |
|---|---:|
| Map CPU | 47.5% |
| 最忙 Gate CPU | 56.6% |
| Move | 14,998/s，达标率 100% |
| Push | 59,913/s |
| Probe p95 / p99 | 175.76 / 229.85ms |
| 业务错误 / 内部超时 / 慢连接断开 | 0 / 0 / 0 |

边界探索中，3500 玩家时 Map CPU 为 60.1%，最忙 Gate 平均/峰值为 74.2%/83.3%，Probe p95/p99 上升到 473/633ms。4000 玩家在入图阶段因全地图可见快照形成瞬时下行洪峰，触发 Gate 慢连接保护，未进入正式测量窗口。

3000 玩家稳态复核中，帧尾 scratch 容量约 0.2MiB，正式窗口 `scratch grows/s` 为 0；进程启动后的累计扩容发生在容量爬升阶段。

详细结果见：

- [Native 数据布局最新报告](../perf/results/native_storage_latest.md)
- [Map 容量最新报告](../perf/results/map_capacity_latest.md)
- [Map 容量测试说明](../perf/map_capacity/README.md)

### 设计决定

- 保留 `.native` 作为存储意图的唯一描述源，业务开发者不手写 Rust Pool 和 FastOp 胶水。
- 当前不引入 Bump allocator。帧尾 scratch 在稳态没有继续扩容，新增分配器的生命周期约束和维护成本高于可证明收益。
- 3000 玩家作为当前全地图互相可见模型的可重复基线；3500 是压力边界，不作为舒适容量承诺。
- 4000 人首先暴露的是入图全量状态与下行扇出问题，而非 Map CPU 上限。该问题应由后续 Rust AOI、分批入图快照和明确的客户端延迟 SLO 处理，不能通过放宽慢连接保护掩盖。

### 遗留问题

- 在 Rust AOI 落地后重新测量入图快照、增量广播和单 Map 容量。
- 为容量候选增加明确的 Probe p95/p99 SLO，避免只按 CPU 和错误数判断。
- Linux 环境补充 epoll/io_uring 同口径验证；本次数据只代表 Windows IOCP。
