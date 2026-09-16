# 常用命令参考

## 新游戏

```powershell
npm run project:create -- --path ../MyGame --id org.example.game
```

随后在 MyGame 使用 doctor、setup、check、build、host-build、start、smoke、inspect、dev。dev 监听现有 Hotfix 行为并发布候选；Model/协议/模块声明变化要求重建重启，不在线迁移字段。

插件的创建与检查入口调用同一组宿主工具。模块系统以 tiangz.project.json 和 tiangz.module.json 为事实，不靠 Demo 目录猜测。

## 引擎维护

持久 ID 隔离验收：`node tools/global_id_runtime_self_test.mjs`。需先构建 TiangZ 与同级 DBProxy 的 debug 二进制；只启动自有内存后端与临时进程，不连接现有数据库。生产切换见[号段配置与恢复约束](../design/global-id-ranges.md)。

合服只读规划：`node tools/realm_merge_plan.mjs --catalog <目录.json> --request <请求.json> --policy <模块策略.json>`。目录/请求为格式 v2，策略为格式 v1；输出不是可执行迁移。开发者职责见[租户与区服边界](../design/tenant-realm-foundation.md)。

| 命令 | 作用 |
| --- | --- |
| codegen | 引擎通用生成物 |
| build | 默认 modules 宿主的 TS 和初始配置包 |
| build:runtime:debug | 不带游戏 Native 的 Rust 宿主 |
| modules:link -- --source <模块> --modules-dir <目录> --name <名称> | 安装外部模块根 |
| modules:prepare -- --modules-dir <目录> | 编辑器路径与声明发现 |
| modules:typecheck -- --modules-dir <目录> | 检查模块类型和直接依赖 |
| codegen:module-protocol | 模块自有 protobuf/SDK |
| codegen:module-config | 模块自有 Luban 配置 |
| codegen:module-native | 模块自有 Native 接口 |
| codegen:module-systems -- --module <id> --modules-dir <目录> | 模块 System 方法声明与 bootstrap |
| build:module-native -- --modules-dir <目录> | 含所选 Native 模块的独立二进制 |
| modules:inspect -- --modules-dir <目录> --json | 结构导航，供终端和插件共用 |
| verify:quick | 框架快速矩阵，不含固定拓扑游戏测试 |
| test:game-project、test:game-project-dev | 中立脚手架真实启动/热更验收 |
| test:unit:coverage | 调用 Examples 的联合覆盖率，保持原 Core 门槛 |
| verify:release | 发布前严格检查版本、协议与 API 锁 |

上表命令均使用 npm run。完整当前脚本清单以根 package.json 为准。旧 --host-profile demo 已移除，默认 modules；不通过兼容别名偷偷装配 MMORPG。

配套组件生成：module:new-component -- --project ../MyGame --module org.example.game --name Inventory --feature inventory --dry-run；去掉 dry-run 才写入。生成器不替开发者决定组件所有者。

## MMORPG / 客户端示例

在同级 TiangZ-Examples 使用：

```powershell
npm run server:build
npm run server:native-build
npm run codegen:sdk
npm run sdk:sync
npm run check
npm test
npm run test:native
npm run test:runtime
```

server:start 启动原有本地端口配置；test:runtime 则启动随机端口的隔离内存进程，不操作既有服务。hello 会构建并启动服务，不是只读检查。

verify:server-assets 验证部署和可观测性资产。历史长稳/故障工具不再作为引擎的日常命令，见 Examples/legacy/README.md。

Cocos 编辑器构建、真实数据库验收、生产发布与大规模压测需要明确选择对应工程和环境，不包含在普通快速检查内。

## 部署根

运行 TiangZ 时传 --runtime-root=<游戏目录> 和游戏配置；该目录包含 dist/ 与 configs/。显式路径无效直接失败，不回退主工程。Native 模块资源也相对此根解析；二进制、Model、Hotfix、配置包及所需地图资源必须成套部署。
# Rust 模块脚手架（2026-09-16）

在宿主执行 `npm run project:create -- --path ../MyRustGame --id org.example.game --with-rust` 创建含 TS/Rust 调用示例的教学工程；`npm run modules:create -- --path ../MyModules/native --id org.example.native --with-rust` 只创建模块输入。参见生成的 RUST.md。

在教学工程执行 setup → host-build → build → smoke（均为 npm run 命令）；check 包含 Cargo check，start 使用匹配的组合二进制，dev 暂不支持 Native。`npm run test:module-native-scaffold` 验证脚手架/生成/TS 构建与拒绝路径；`npm run test:module-native-scaffold-runtime` 额外编译组合宿主并运行真实 RPC、正常停机与过期二进制拒绝。测试只使用自身临时工程，不访问数据库。
