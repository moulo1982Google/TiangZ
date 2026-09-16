# 示例拆分（2026-09-16）

后续包组织：SLG 已迁入 Examples/packages/slg；MMORPG 运行入口在 packages/mmorpg。根 build/check/start/smoke 通过 --package 选择单个包，构建输出隔离；共享 MMORPG 模块和客户端不再重复搬迁。详见 Examples/README.md。

## 所有权

TiangZ 只装配显式安装的模块，不再拥有内置 MMORPG/Bench 的 Model、Hotfix、协议、配置、Native 游戏存储和客户端 Demo。空宿主的 Rust 不注册 MMORPG ops；通用导航、网络和 DBProxy 传输保留在引擎。

同级 TiangZ-Examples 拥有 modules/mmorpg、modules/bench、clients、configs、navigation，以及游戏测试和示例运维资产。MMORPG 的公开入口是 #tiangz/modules/org.tiangz.mmorpg，协议编号沿用原锁。旧 #tiangz/model 不再混入游戏类型。

TiangZ-ModuleGame 的 wasteland、TiangZ-WoW335 的 wow335 显式声明 MMORPG 直接依赖；模块根联接是安装点，不是旧 app 路径的兼容联接。SLG 继续独立构建，不安装 MMORPG。

## 补齐的通用边界

- processServices：模块同步初始化与具名指标采样，禁止覆盖宿主保留指标。
- Native configureProjectRoot：显式绑定进程资源根，宿主不解释游戏文件。
- 模块 System 声明：生成在模块内，可扩充通用领域类型；未装配的共享契约不要求空宿主实现 System。
- Model 配置 validator：在提交前校验候选与上一版冻结表；MMORPG 冷表策略在模块内实现。
- SDK source：消费工程拥有协议/配置组合产物，通用发布器负责受控分发和哈希。
- Native 缓存：多个游戏复用 Cargo 缓存，各组合独立发布二进制，启动验证 Native 与文件哈希。

## 命令迁移

引擎入口保留 project:create、模块生成/构建、框架检查和发布。hello、旧 starter、固定部署 Demo、游戏压测与故障脚本不再是引擎入口。

在 Examples 使用 server:build、server:native-build、server:start、codegen:sdk、sdk:sync、test、test:native、test:runtime、verify:server-assets。旧固定拓扑联机脚本保留在 legacy，明确作为历史资料，不伪装成适配后的可执行命令。

游戏单测继续执行。Core 联合覆盖率调用 Examples 的场景，原门槛不变；框架快速矩阵不依赖示例部署资产。静态部署与可观测性检查移到 Examples。

## 验证含义

真实登录冒烟在临时资源根用随机本地端口和内存数据；检查注册、角色目录、Gate、地图、AOI、退出和立即切换角色。它不证明真实 DBProxy 恢复、Cocos/Unity/UE/Godot 编辑器构建或生产容量。

历史性能报告保留历史语境，不代表拆分后已重跑压测。长稳、数据库故障与现有服务操作仍需单独授权。

迁移前原始文件在工作区 .build-tmp 的 mmorpg-original-sources 与 final-example-backup 中保留；Git 删除项和 Examples 新增项需成套保存，不能只提交引擎删除。本文不替代最终命令执行报告。
