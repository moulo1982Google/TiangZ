# 模块化主线整合（2026-09-15）

## 范围

原主线 `f8c676a`，模块化分支 `feat/module-protocol-sdk` 的已提交基线 `c10a24d`。主线是该分支祖先，整合不需要用冲突覆盖策略选择一方。

包含原有五个提交：模块 Proto/TypeScript/Godot SDK、独立 Godot 读取器、模块公开 API/配置/迁移/Native、持久记录和可恢复流消费、deno_core 0.411 升级。后续工作区代码另外整理为运行时关闭/资源目录/Native 依赖身份修复，以及 MMORPG 地图分线、准入、队伍、交易、任务和战斗扩展契约。

游戏特有地图、职业、数值、图片、UI 和模块协议留在 ModuleGame。临时日志不入库。DBProxy 独立仓库的停止修复不属于这次 TiangZ Git 合并。

## 消费方与兼容

- WoW335 保留自己的模块和部署制品；用候选宿主验证类型、模块图、Hotfix 边界、账户契约与独立输出构建，不覆盖运行中的部署目录。
- ModuleGame 的开发入口统一引用 `../TiangZ`；SDK 和配置输出仍在游戏目录中，构建和运行通过显式模块目录与资源目录隔离。
- 类型检查器从当前宿主加载生成的系统方法声明，避免旧 tsconfig 的另一 worktree 声明与新宿主 API 身份混用。新增回归覆盖旧声明排除、自有声明保留和类型错误拒绝。
- 原有协议锁保持显式校验；生成文件由 codegen 更新，不手改。Model/协议/Native 变化需要完整构建和进程重启。

## 验证与回退

整合在独立 worktree 中验证。合并前主线保留为 `backup/main-before-modular-20260915`；原模块化工作目录与临时日志保留。

合并前最终 `npm run verify` 通过：quick 26/26、check 15/15、full 11/11，耗时 525756 ms。设置 `GODOT_BIN`，实际执行双 SDK 独立 Godot 工程、旧读取器兼容与 TypeScript 共用传输验证；Native 两模块在同一 V8 独立读写及无效制品拒绝通过。报告保存在整合 worktree 的 `dist/test-results/`，日志为 `logs/merge-full-final.log`。

首轮新目录编译因 Windows 跨盘 V8 symlink 权限失败；在 `target/debug/gn_root` 建立指向本机对应 V8 缓存的目录联接后，完整重跑得到上述结果。未修改系统权限或 Rust/V8 依赖来绕过验证。MSVC 有 LNK4098 链接警告，构建与运行测试仍通过。

WoW335：1 模块类型检查、模块图、Hotfix 边界、4 项账户/会话与 5 项技能协议契约检查通过；独立 Bundle 构建与运行时装配检查通过，识别 577 个怪物刷怪点、65 个 NPC、145 个交互物、25 条任务与 6 个玩家出生配置。ModuleGame：2 模块类型检查、86+6 条消息协议校验与独立 Bundle 构建通过。

验证不包含大规模容量、长稳、真实 WoW 客户端全流程或生产发布；本次不推送远端、不自动切换正在运行的 WoW 服务。

## 合并后落地

本地 `main` 已快进到整合提交 `3be619f`。在主线目录重新执行 `npm run codegen`，生成结果无 Git 漂移；执行 `cargo build --locked --bin TiangZ`（通过 `--target-dir` 复用整合目录缓存），构建主线源码，并将同一构建的可执行文件/调试符号安装到主线 `target/debug`。旧文件保存在工作区 `.build-tmp/main-binary-before-modular-20260915`，主线与构建产物 SHA256 一致。

ModuleGame 已通过实际主线入口的 `engine:check`、`protocol:check`、`config:check`、`godot:sdk:check`、`engine:build`；2 模块的 Bundle 与启动配置已更新到游戏自己的 dist。`checks:unit` 通过 12 组 Node 单测和 27 个 Godot 无界面脚本。20 个迁移脚本通过 `node --check`；命令索引由工具重建并检查一致。入口修改前文件保存在工作区 `.build-tmp/modulegame-mainline-20260915`。游戏仓库原有未提交内容保留，没有把全部游戏改动混入框架提交。

WoW335 在实际主线上复验模块类型、消费的协议契约以及独立 Bundle/运行时装配，结果通过；输出放在主线 `temp/mainline-wow335`，不覆盖其原部署。后续新功能统一从主线创建分支。

按后续清理指令，旧 `TiangZ-Modular` worktree 已注销并删除。删除前逐文件确认源码改动匹配已整合快照 `f12b635`，152 个改动文件/临时日志和 55 个忽略日志归档到工作区 `.build-tmp/modular-retired-20260915`；删除前断开内部目录联接，未删除其外部目标。整合验证目录的 node_modules 联接已切到主线。旧目录消失后，ModuleGame 的模块、协议、Godot SDK 清单及命令索引检查再次通过。

DBProxy 的停止信号修复与能力文档已提交并合到较新的 DBProxy 主线，常用 `TiangZ-DBProxy` 目录现位于 `main`（`5162376`）。保留主线原有连接限额、端点切换、cache-repair 等修复；Rust fmt/workspace tests/clippy 和 TypeScript SDK 18 项测试通过。另一个 DBProxy worktree 的未提交部署改动保留在 `archive/dbproxy-deployment-worktree-20260915` 分支。TiangZ 随后使用该 SDK 重新构建。此次未重新部署容器或执行数据库故障/容量测试，未推送远端。
