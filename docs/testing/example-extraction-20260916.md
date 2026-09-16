# 示例独立与依赖迁移验收（2026-09-16）

## 交付结果

主工程版本保持 `0.6.0-alpha.0`。MMORPG/Bench 的 Model、Hotfix、协议、配置、Native 游戏实现，以及六个客户端示例，归同级 `TiangZ-Examples` 所有。主工程不再默认装入 MMORPG，也没有建立旧业务路径的兼容联接。

- `TiangZ`：通用宿主、稳定领域契约、模块生成/装配/检查工具。
- `TiangZ-Examples`：`modules/mmorpg`、`modules/bench`、客户端、部署样例、导航资源与游戏测试。
- `TiangZ-ModuleGame` / `TiangZ-WoW335`：显式依赖 MMORPG，通过模块根联接安装，通过模块公开入口消费；各自拥有运行输出和资源根。
- `TiangZ-SLG`：保持独立模块，不安装 MMORPG。
- `tiangz-developer-tools`：区分未装配的共享契约与实际业务 System，保留真正缺失实现的诊断。

这次按 TiangZ 后端开发规范保留了 Model/Hotfix 边界、生成锁与协议兼容检查；没有通过手改生成物或关闭错误检查来完成迁移。新增的通用能力包括模块进程服务、配置提交前校验、模块 System 声明、模块自有 SDK 输入，以及独立 Native 组合二进制。

## 已执行的验证

| 范围 | 命令或检查 | 结果 |
| --- | --- | --- |
| 主工程 | `npm run verify:quick` | 28/28，包括 Rust fmt、Clippy、测试与模块宿主检查 |
| 主工程 | `node tools/game_module_build_self_test.mjs` | 通过 |
| 主工程 | `npm run test:module-native-runtime` | 真实双模块 V8/Native、身份及发布完整性回归通过 |
| 主工程 | `npm run test:module-install` | 安装失败撤回联接、源文件保留、幂等、目标占用保护通过 |
| 主工程 | `npm run check:project` | 120 文件，0 错误、0 警告 |
| 生成物 | 主工程及 Examples 生成清单校验 | 分别 7、1 个生成器通过；四个游戏模块目录编辑器配置检查无变化 |
| 框架与示例 | `npm run test:unit:coverage` | 83 文件、223 测试通过；Core 行覆盖率 75.64%，原门槛不变 |
| Examples | `npm run verify`、`npm run test:native` | TS/客户端静态检查、部署资产检查通过；Rust 49 单测与 2 个 bridge 测试通过 |
| Examples | `npm run test:runtime` | 临时目录、随机本地端口：注册、角色、Gate、地图/AOI、退出与切换角色通过 |
| Examples | `npm run test:perf-runtime-log` | 迁移后的日志分类测试通过 |
| ModuleGame | `npm run engine:build`、运行根回归、交易规则测试 | TS + Native 组合构建、运行二进制选择和 10 项交易规则通过 |
| WoW335 | `node tools/build-tiangz-wow335-runtime.mjs --debug` | 输出在本工程 `dist`，模块组合与 577 怪物、65 NPC、145 交互点等装载验证通过 |
| WoW335 | JS 工具测试、`cargo test --workspace` | 114 项 JS、267 项 Rust 测试通过；2 项数据库集成测试保持忽略 |
| SLG | `npm run build`、`npm run check` | 不依赖 MMORPG，独立通过 |
| 插件 | 核心与扩展测试、打包 | 44 + 37 项测试通过，VSIX 已本地安装 |

MMORPG 原始 `opcode.lock.json` 与 `schema.lock.json` 和迁移前备份逐字节相同。稳定 Core API 仍为 196 项。收尾增加的安装回归和日志测试单独执行；随后重跑了生成清单、注释、版本、API 与项目检查。

## 使用入口

示例从 [Examples README](../../../TiangZ-Examples/README.md) 开始；模块内手写物与生成物见 [MMORPG README](../../../TiangZ-Examples/modules/mmorpg/README.md)。主工程命令见 [命令参考](../reference/commands.md)。

本地插件安装包在 `tiangz-developer-tools/dist/tiangz-developer-tools-0.15.2.vsix`。VS Code 需要执行一次 **Developer: Reload Window**。引擎本地开发依赖也已连接到修改后的插件；尚未发布新的远端插件版本，干净克隆不能假定旧远端依赖已包含本次修复。

## 边界与恢复

- 旧固定拓扑的联机、故障和性能脚本在 Examples 的 `legacy`/`perf` 保留历史用途；它们没有被宣称为已适配并验收的新入口。主工程已撤下失效的 npm 命令。
- Docker Linux 冒烟入口已改为模块宿主/新工程验证，并做语法检查；本次未执行容器验收。
- 客户端检查不等于 Cocos、Unity、UE、Godot 编辑器与正式平台构建。未运行编辑器完整验收、长稳、容量、数据库故障或生产发布。
- 没有停止或改动既有运行服务、DBProxy/数据库、AzerothCore 或 WoW 客户端；隔离冒烟只管理自己启动的进程。
- 主工程保留通用导航测试资源与底层诊断工具，并非只剩空目录。
- 用户原有未提交修改保留。迁出的原文件可从工作区 `.build-tmp/mmorpg-original-sources`、`.build-tmp/final-example-backup` 恢复；没有清空这些备份。
- 尚未提交或推送。保存版本时必须成套包含引擎删除、Examples 新增、消费工程依赖与插件变更，不能只提交主工程删除项。
