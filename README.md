# TiangZ

TiangZ 是 Rust Runtime + TypeScript 的模块化游戏服务端框架。当前开发版本为 `0.6.0-alpha.0`，尚未完成 0.6 正式发布验收。

MMORPG 不再是内置宿主：服务端模块、协议、配置、Native 游戏数据与六个客户端都在同级 TiangZ-Examples。TiangZ-ModuleGame 和 TiangZ-WoW335 显式依赖该 MMORPG 模块；SLG 不需要安装它。

## 新手从这里开始

```powershell
npm install
npm run project:create -- --path ../MyGame --id org.example.game
```

随后打开 MyGame，按生成的 README 运行 doctor、build 和 smoke。工程自带计数器 RPC 示例，不需要 MMORPG、数据库或客户端编辑器。

VS Code Developer Tools 提供创建、检查和导航入口；不安装插件也能使用相同的宿主命令。详见[模块入门工程](docs/tutorials/module-starter.md)。

## 看代码

| 目录 | 内容 |
| --- | --- |
| app/core | Entity、Scene、Actor、Component、mailbox、协议路由、模块装载等框架 |
| app/model/domains | 可复用的稳定领域契约，不装配游戏规则 |
| app/model/public.ts | 宿主 Model 的稳定入口；不导出 MMORPG 类型 |
| src | Rust 网络、Process、V8、Inspector、持久化传输与通用导航能力 |
| modules | 外置模块安装位置；引擎默认不安装游戏模块 |
| tools | 模块脚手架、生成、构建、检查与宿主维护 |
| client_sdk | 通用客户端 SDK 与空宿主协议产物；不包含 Demo 业务 |
| tests | 框架测试 |
| configs | 部署目录约定说明；具体实例配置归游戏工程 |
| app/generated、src/generated | 生成物，不手改 |

一个 OS Process 只有一个 V8 和一条 TS 业务线程；它可以承载多个 Scene。玩家等 Actor 通过 InstanceId 定位并进入 mailbox，不通过遍历地图寻找。Model 定义稳定类型和状态，Hotfix 实现行为；Model、协议和 Native 变化需要重建并重启。

## 使用 MMORPG 示例

在同级 TiangZ-Examples 执行：

```powershell
npm install
npm run server:build
npm run server:native-build
npm run test:runtime
```

最后一条会启动隔离的临时进程，验证真实注册、登录、进图和退出链路，不连接现有数据库。日常启动使用 server:start；客户端 SDK 通过 codegen:sdk、sdk:sync 显式生成和分发。

示例入口见[TiangZ-Examples](../TiangZ-Examples/README.md)，拆分边界与迁移说明见[示例拆分](docs/design/example-extraction.md)。旧内置宿主的性能/故障脚本作为历史资料迁出，不再列为引擎 npm 入口；不能将历史性能结果当作本次拆分后的容量验收。

## 模块开发规则

- 使用 tiangz.module.json 声明 Model、Hotfix、公开 API、协议、配置、Native 和直接依赖。
- Core 能力从 #tiangz/core，宿主契约从 #tiangz/model，模块自身从 #tiangz/module，依赖模块从 #tiangz/modules/<id> 导入。
- 默认且唯一受支持的宿主模式为 modules；旧 --host-profile demo 会明确报错，不静默回退。
- 不把游戏规则放进 Core，不跨仓深层导入，不手改生成代码和协议锁。
- 同步进程初始化与采样通过模块 processServices 接入；资源根通过可选 Native configureProjectRoot 接入。
- MMORPG 领域 System 的方法声明由 codegen:module-systems 生成在模块内；通用领域契约不会要求空宿主安装 MMORPG System。

完整说明见[外置模块](docs/design/external-game-modules.md)、[能力归属](docs/design/capability-ownership.md)和[API 稳定性](docs/reference/api-stability.md)。

## 验证

```powershell
npm run verify:quick
npm run test:game-project
npm run test:game-project-dev
```

框架检查不再运行 Demo 部署、游戏性能和数据库故障脚本。联合覆盖率仍保持原门槛，由 npm run test:unit:coverage 调用同级 Examples 的游戏场景；仅框架单测使用 test:unit。

发布前另执行 verify:release，严格检查版本和生成锁。大规模压测、长稳、真实数据库故障与客户端编辑器构建不属于普通快速检查。

## 相关资料

- [开发命令](docs/reference/commands.md)
- [AI 项目上下文](docs/ai/project-context.md)
- [业务开发手册](docs/ai/business-development-manual.md)
- [版本记录](CHANGELOG.md)
- [历史性能基线](PERFORMANCE.md)
- [TiangZ-DBProxy](../TiangZ-DBProxy/README.md)：独立通用持久化服务，不识别游戏规则

架构借鉴 ET 的 Scene/Actor/Entity/Component 模型与 Skynet 的消息隔离思想。采用 Apache-2.0 许可。
