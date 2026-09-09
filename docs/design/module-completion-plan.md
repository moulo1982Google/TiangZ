# 模块化能力推进与验收

本分支目标是改进 TiangZ 外置模块体系。独立游戏只作为一个消费方；新框架能力必须用游戏中立夹具验证。模块化能力优先，消费方接入发现的通用缺口应先修回框架。

## 工作顺序

1. 跨模块公开 API：manifest 声明 Model publicApi，直接依赖白名单，构建与类型检查使用同一解析规则，Hotfix 使用不可变 Model 桥。覆盖类型错误、越界导入、身份保持、API 变动拒绝 Hotfix-only。
2. 配置：模块 Luban 的服务端和客户端独立导出、构建接线、schema 指纹；运行时数据更新必须预检整个候选，再原子发布，失败保留旧版本。
3. 持久化：模块通过版本化 Codec 显式声明迁移链，未知版本拒绝，CAS 防止覆盖并发写；不执行模块 Shell/SQL 安装脚本。
4. Native：模块自有 .native 与 Rust crate 的确定性生成和组合编译，模块来源指纹进入 Hotfix 门禁；外部源码和输出保持隔离。
5. 部署：模块安装、升级、删除采用完整候选校验与重启部署，保留旧制品用于回滚。验证缺失依赖、图变化、schema 变化和兼容拒绝。

## 架构约束

AGENTS.md 的 Model/Hotfix 硬边界禁止 Model 在线重载。运行期增删冻结路由、Native ABI 或 Model 类型，必须通过进程替换完成。该约束不计作待实现的在线 Model 热更功能；不能为声明“全部完成”新增绕过检查的入口。

配置 payload 的 schema 和迁移规则由模块拥有；Core 仅承载版本、事务、目录和校验机制。运行中的 Scene/Entity 不自动更换已捕获的配置引用，配置消费者必须明确选择读取新快照的时间。

## 验收与状态

2026-09-10 补充：在 ModuleGame/Godot 4.7.2 中实际加载 SDK，发现旧验收仅验证了生成文件存在，漏掉示例全局 `TzProtoReader` 依赖。已将读取器迁至正式 `client_sdk/godot` 并内嵌进生成协议类，保留旧示例兼容入口。新增干净 Godot 工程实跑（两个生成 SDK 同时加载、Unicode/RPC 往返、读取器游标隔离），避免再次把“文件已生成”当作“独立 SDK 可运行”。协议字段和 opcode/schema 锁未变化。

该修复后重新执行完整 `npm run verify`：quick 25/25、full 10/10，耗时约 708 秒；本次设置 `GODOT_BIN` 执行了真实 SDK 检查，没有跳过 Godot。最终测试又单独复验了先验证无示例项目、再引入旧读取器兼容入口的两阶段场景。生成清单和宿主/模块 Godot 产物均已重新生成。

原有 Protobuf/SDK 生成提交为 `3af2aa6`。2026-09-10，本轮五项能力均已实现，实际验收如下：

| 能力 | 已执行的验收 |
| --- | --- |
| 模块 publicApi | 直接依赖导入、类型错误/深层路径拒绝、Model 身份保持、API 变化拒绝 Hotfix-only、完整升级后的新旧进程身份隔离、失败构建保留旧 Model |
| 模块配置 | 两个独立 Luban 工程；客户端排除服务端私有字段；完整 Model bundle 加载并更新两模块快照；无效数据/host schema 失败不推进模块代次；schema 改动拒绝热更；生成失败恢复目录与清除遗留生成文件 |
| 持久化迁移 | 内存与 DBProxy Codec 迁移、CAS 竞争、提交回执丢失时同 requestId 重试、最后一次 CAS 成功后权威重读；独立 DBProxy 容器实际落库、第二个 TiangZ 进程重读与旧 Codec 写入拒绝 |
| Native | 两模块自有 .native/Rust/TS 生成与类型检查；实际组合编译 TiangZ；同名 op/同实体编号在同一 V8 独立读写与释放；过期 handle 拒绝；Native 指纹不匹配拒绝 Model 启动及 Hotfix-only |
| 版本部署 | 独立开发制品打包；混用 Bundle、缺失模块配置、过期二进制、变化的 Cargo.lock 拒绝；已有制品不覆盖；制品 SHA256SUMS 复核及真实登录、进图、协议冒烟 |

最终 `npm run verify` 全部通过：quick 25/25，full 10/10，包含 Rust fmt/clippy/test 和多进程/热更/配置重载验收；Stable Core API 的 190 个导出也通过严格发布锁校验。新增 Native 运行与发布拒绝测试已纳入 full 矩阵；数据库实跑必须单独指定隔离 endpoint 和凭据，不会自动复用开发者的数据库。最终门禁报告位于忽略目录 `dist/test-results`。

复验入口：

```powershell
npm run verify
npm run test:module-native-runtime
npm run test:module-dbproxy-migration -- --endpoint <独立验收地址:端口> --env-file <环境文件>
node tools/release/package_release.mjs --smoke-existing <保留的开发制品目录>
```

本机验证使用 Windows/MSVC。全局 CC/CXX 原指向 GCC，完整验证在子进程环境中清除这两个设置；模块 Native 构建器会识别 MSVC 目标并忽略继承的 GCC 设置，不修改系统环境。V8 跨盘缓存使用目录联接，避免要求 Windows 符号链接特权。

本轮未执行 Linux/优化 release 配置构建、大规模压测与长稳测试；没有部署替换现有游戏进程。数据库测试仅保留独立 namespace 的小量验收记录。代码回滚不自动撤销持久化迁移，客户端内容也不由服务端热更自动推送。

Godot 补充验收的范围是生成 SDK 和独立消费方。旧 3D 示例整体在本机 Godot 4.7.2 导入时，其未修改的 `scripts/main.gd:1518–1520` 有 Vector3 类型推断错误；本次不计作该示例整体验收通过。SDK 及其旧读取器兼容入口已在单独的干净项目编译并实际解码成功。
