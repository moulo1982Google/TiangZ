# TiangZ 文档

## 学习手册

1. [架构与快速启动](tutorials/01-architecture-and-quickstart.md)
2. [TypeScript 与第一个入口 Scene](tutorials/02-typescript-and-scene.md)
3. [protobuf、RPC 与客户端 Push](tutorials/03-protocol-rpc-and-push.md)
4. [Scene 通信、Mailbox、Actor 与 Component](tutorials/04-scene-mailbox-and-actor.md)
5. [登录、Gate、地图与 Cocos 链路](tutorials/05-game-chain-and-client.md)
6. [调试、测试与部署](tutorials/06-debug-test-and-deploy.md)
7. [客户端传输协议与 Cocos Native](tutorials/07-client-transport-and-native.md)
8. [Rust Entity 与 TS Handle 代码生成](tutorials/08-native-entity-codegen.md)

## 开发参考

- [配置与协议](reference/config-and-protocol.md)
- [传输协议与 I/O Backend](reference/transport-backend.md)
- [Core API](reference/core-api.md)
- [常用命令](reference/commands.md)
- [可观测性与链路耗时](reference/observability.md)
- [故障排查](reference/troubleshooting.md)
- [业务开发清单](guides/business-cookbook.md)
- [运行时维护者指南](design/maintainer-guide.md)
- [移动预测与快照插值](design/movement-prediction.md)
- [Rust 权威实体数据](design/native-entity-storage.md)
- [TypeScript 调试](typescript_debugging.md)
- [路线图](roadmap.md)

`phase*_plan.md` 和 `phase*_acceptance.md` 是阶段历史记录。其中出现的“一 Service 一 V8”等文字只描述当时实现，不代表当前架构；当前事实以 README、教程、reference 和 maintainer-guide 为准。
