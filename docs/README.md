# TiangZ 文档

## AI 协作

- [AI 项目上下文](ai/project-context.md)：架构演进、关键决策、当前状态、性能事实和明确暂缓事项。
- [AI 业务开发手册](ai/business-development-manual.md)：业务需求的默认修改边界、实现配方、禁区和验证矩阵。
- 根目录 [`AGENTS.md`](../AGENTS.md)：编码 AI 必须先读的高优先级规则。

## 学习手册

1. [架构与快速启动](tutorials/01-architecture-and-quickstart.md)
2. [TypeScript 与第一个入口 Scene](tutorials/02-typescript-and-scene.md)
3. [protobuf、RPC 与客户端 Push](tutorials/03-protocol-rpc-and-push.md)
4. [Scene 通信、Mailbox、Actor 与 Component](tutorials/04-scene-mailbox-and-actor.md)
5. [登录、Gate、地图与 Cocos 链路](tutorials/05-game-chain-and-client.md)
6. [调试、测试与部署](tutorials/06-debug-test-and-deploy.md)
7. [客户端传输协议与 Cocos Native](tutorials/07-client-transport-and-native.md)
8. [Rust Entity 与 TS Handle 代码生成](tutorials/08-native-entity-codegen.md)
9. [NumericComponent、定时器与状态广播](tutorials/09-numeric-component-and-broadcast.md)
10. [Luban游戏配置](tutorials/10-game-config.md)
11. [地图实例与动态副本](tutorials/11-map-instance-and-dungeon.md)
12. [Rust业务模块](tutorials/12-rust-business-modules.md)
13. [NavMesh3D离线资源与Rust查询](tutorials/13-navmesh3d.md)
14. [Unreal Engine 5.4.4客户端](tutorials/14-unreal-engine-client.md)
15. [Godot 4.7.1客户端](tutorials/15-godot-client.md)
16. [怪物模块](tutorials/16-monster-module.md)
17. [Unity 2022.3客户端](tutorials/17-unity-client.md)

## 开发参考

- [配置与协议](reference/config-and-protocol.md)
- [传输协议与 I/O Backend](reference/transport-backend.md)
- [Core API](reference/core-api.md)
- [公共 API 与版本稳定性](reference/api-stability.md)
- [RPC 与 Actor 正确性](reference/rpc-actor-correctness.md)
- [故障注入测试](reference/fault-injection.md)
- [依赖与许可证策略](security/dependency-policy.md)
- [常用命令](reference/commands.md)
- [可观测性与链路耗时（含 Prometheus 与 Grafana）](reference/observability.md)
- [故障排查](reference/troubleshooting.md)
- [业务开发清单](guides/business-cookbook.md)
- [运行时维护者指南](design/maintainer-guide.md)
- [Phase 4 前框架成熟度审计](design/framework-readiness-audit.md)
- [Process 级 TypeScript 热更设计](design/typescript-hot-reload.md)
- [移动预测与快照插值](design/movement-prediction.md)
- [Rust 权威实体数据](design/native-entity-storage.md)
- [Gate 断线重连与最终下线](design/gate-reconnect.md)
- [Location 与玩家 Actor 路由](design/location-routing.md)
- [Entity 地图迁移](design/entity-transfer.md)
- [运行时基础能力：ID、时间、Timer、协程锁与Scene事件](design/runtime-foundations.md)
- [Veto Event与后台任务设计](design/veto-events-and-spawn.md)
- [Unit与ActorUnit边界](design/unit-actor-boundary.md)
- [地图空间与3D坐标契约](design/spatial-world.md)
- [AOI完整设计与函数调用关系](design/aoi-architecture.md)
- [TypeScript 调试](typescript_debugging.md)
- [路线图](roadmap.md)

`phase*_plan.md` 和 `phase*_acceptance.md` 是阶段历史记录。其中出现的“一 Service 一 V8”等文字只描述当时实现，不代表当前架构；当前事实以 README、教程、reference 和 maintainer-guide 为准。
