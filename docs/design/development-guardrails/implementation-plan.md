# 实施计划：AI 开发规则、工程检查与领域复用

> **实施状态：P0/T1/T2/T3/P1/G1/G2/M1 实现完成；游戏远端 smoke 收尾中。** 2026-10-13 需求方明确“可以，请继续推进直到完成”，覆盖完整剩余设计，不再等待分组开工。独立评审、框架代码 CI、本机工具与五阶段实库已完成；下方计划命令不是运行成绩，实际结果登记在文末与[交付记录](delivery-report.md)。设计依据：[README.md](README.md)；验收依据：[validation-matrix.md](validation-matrix.md)。

## 1. 批次与依赖

| 批次 | 内容 | 所有者 | 前置 | 当前状态 |
| --- | --- | --- | --- | --- |
| D0 | 设计、代码基线与文档检查 | TiangZ 文档 | 无 | 本轮完成；无产品改动 |
| P0 | 通用规则正文、引用和场景样例 | TiangZ AI 维护源 | 已通知推进 | 源与产物完成；九场景核心判断通过，完整行为评估部分关闭 |
| T1 | 真实 Model 导出预检与默认检查接入 | TiangZ tools / 内部 Core 诊断 | 已通知推进 | 实现与本地验收完成 |
| T2 | 协议合并反例、冲突诊断与生成检查接入核对 | TiangZ tools / 游戏验收入口 | 已通知推进 | 实现与本地验收完成 |
| T3 | 阶段结果、失败收尾与检查矩阵接入 | TiangZ tools | T1、T2 | 实现、十项反例与独立评审通过；最终 quick 39/39 |
| P1 | 设计工具规则同步、技能与插件分发验证 | Developer Tools、TiangZ、AI Plugins | P0；实际 Developer Tools 版本对齐 | 源/分发/MCP 验证完成；Developer Tools CI 全通过 |
| G1 | 领域覆盖检查与公共事务装配 | 苟道三国游戏模块 | 已明确纳入；T1/T2 | 十域实现和独立兼容性评审完成；工具1551通过、五阶段DB21 PASS；远端smoke收尾中 |
| G2 | 公共夹具与失败场景复用 | 苟道三国 tools | G1 | 实现、旧字节对照和独立评审完成；12次真实Host启动与恢复验收通过；远端smoke收尾中 |
| M1 | 实际开发效果记录 | 游戏功能文档 | 适用实施批次 | 记录机制及本次接线减少、失败类别、发现阶段完成；工时未知，新功能可比采样留待后续 |

建议分三组交付：第一组 P0/T1/T2；第二组 T3/P1；第三组 G1/G2/M1。通知某一组开工不能自动推进其他组。合并、推送、发布与安装另核授权范围。

2026-10-13 补充：需求方现已明确授权完整剩余实施；上述分组仅用于交付与验证顺序，不再作为等待许可的理由。客户端正式安装、长稳/性能和生产操作仍按实际请求范围区分。

## 2. 开工共通准入

1. 重新读取相关仓库状态、规则、版本、目标分支与宿主解析依赖；保留其他人的改动。
2. 沿用或新建适合该批的独立工作树，不把代码写入游戏的 TiangZ 框架副本。
3. 将本计划中的拟新增文件与最新树核对；若已有等效能力，接入/补反例，不重复建立。
4. Developer Tools 需要定位宿主锁定版本对应源码；当前本地 0.15.2 不是 0.16.2。未对齐前不实施包侧规则变化。
5. 在当前提交建立正例与反例，核对实际数量；失败保留首轮记录。新的测试期望依据现有运行语义，不凭设计假设修改历史冻结期望。
6. 实现批次记录提交树、文件范围、实际运行检查与未执行理由；执行当次明确范围和目标工程现行约定，不复制其他任务的角色配置或数据库操作流程。

## 3. P0：AI 规则维护源

### 文件责任

- 修改 TiangZ `docs/ai/skill-development-contract.md`：五项新增判断，既有 mailbox/幂等/验证条款消重、修订。
- 修改 `tools/ai-assistants/skill/SKILL.md`：按触发条件给出短入口与当前命令；不复制所有故障历史。
- 修改 `tools/ai-assistants/cindy/main.js`：对应通用规则 ID 与文案；不新增运行权限。
- 修改相关 `docs/patterns/*.md`、`docs/ai/project-context.md`、`docs/ai/business-development-manual.md`：权威规则、边界和工具入口一致。
- 修改 `tools/ai-assistants/check.mjs`：缺规则/重复 ID/引用与分发一致性反例。
- 拟新增 `docs/ai/development-guardrails-scenarios.md`：AI 场景输入、应读文档、判断和应要求的证据，供行为评估。

### 约束

拟新增 ID 要核对当前 design/Cindy 目录，已存在的更新原条目。Developer Tools 尚未同步时，源状态明确标为待同步，不发布声称三入口已一致的插件包。

场景至少包括：冻结 Set 导出与合法实例 Set；不变操作遇到 pending；重建后历史 operationId；ordered 玩家与混合 Directory 两种场景；跨端推算参数缺失；Node 测试通过但目标客户端失败；未知宿主版本。

### 以后运行的验证

```text
node tools/ai-assistants/build.mjs
node tools/ai-assistants/check.mjs
node tools/ai-assistants/build.mjs --check
```

补充源与生成引用检查；场景评估单独记录实际模型/插件身份、输入和输出，不把字符串断言当行为通过。实际模型对话评估需在后续任务范围中明确安排，不默认使用 API 或创建客户端会话。

## 4. T1：Model 导出预检

### 文件责任

| 路径 | 改动 |
| --- | --- |
| `tools/check_module_model_exports.mjs`（拟新增） | CLI 编排、临时目录、子进程期限、JSON/人类诊断 |
| `tools/module_model_export_probe.mjs`（拟新增） | 一次性实际登记加载、seal 和检查桥 |
| `tools/module_model_build_support.mjs`（拟新增） | 从构建器提取必要的内部 Model 解析/边界 helper，无额外公共 API |
| `tools/build_runtime_bundles.mjs` | 仅复用提取 helper，构建语义与内容保持 |
| `app/core/modules/GameModuleSystem.ts` | 内部错误附模块和路径；原判定及错误前缀不变 |
| `tools/game_project_build.mjs` | 类型检查后执行预检，明确完整 check 的支持范围 |
| `tools/module_model_exports_self_test.mjs`（拟新增） | 正例、非法值、Native 检查桥、期限/收尾、无改写 |
| `tools/game_module_system_self_test.ts` | 原运行期检查与新诊断上下文一致 |
| `tools/run_test_matrix.mjs`、项目检查相关 self-test | 接入窄检查，不加入长稳/性能流程 |

### 实现次序

1. 提取共享解析器并核对原 bundler 输出与行为不变。
2. 给真实 Core 错误添加位置上下文，运行期与预检使用同一校验。
3. 实现模块图登记探针与显式 Native 占位桥。非法 Native 调用给 unavailable，不伪造计算结果。
4. 先作为独立工具证明 Starter、Native 示例和当前游戏的兼容范围；修复工具支持问题后才接入默认 check。
5. 接入现有受信任 CLI/IDE 显式检查。实时 worker 继续静态分析，不执行 Model 顶层代码。

### 以后运行的验证

```text
node tools/module_model_exports_self_test.mjs
node tools/game_module_build_self_test.mjs
node tools/module_typecheck_host_self_test.mjs
node tools/check_module_model_exports.mjs --modules-dir <实际模块目录> --host-profile modules --json
npm run verify:quick
```

前四项为拟新增/已有窄入口；最后一项按当时矩阵核对，不能只看退出码。真实 Model 加载与真正 Native/Process 启动分别报告。没有改 Rust，不安排 Rust 全量重编作为本批默认验收。

## 5. T2：协议与生成检查

### 文件责任

- `tools/module_protocol_codegen_self_test.mjs`：补合并无文本冲突和跨模块碰撞反例，保留现有输出不改写测试。
- `tools/codegen_module_protocol.mjs`、`tools/codegen_proto.mjs`：必要时增强现有冲突诊断/无协议分支；不新建分配器。
- `tools/game_project_build.mjs`、现有项目检查 self-test：验证公共 check 真正调用协议/配置/Native 检查。
- `docs/reference/commands.md`、业务开发手册：最终合并树检查与显式修复步骤。
- 游戏目标同步检查继续由已声明同步目标及现有工具负责；不在宿主写死 Cocos 路径。
- CI 修改定位实际 `.github/workflows/verify.yml` / `starter.yml` 和游戏真实流水线后再作最小接入，不猜测其他仓库的 `ci.yml`。

### 以后运行的验证

```text
node tools/module_protocol_codegen_self_test.mjs
node tools/module_generated_outputs_self_test.mjs
node tools/module_game_config_codegen_self_test.mjs
node tools/codegen_module_protocol.mjs --modules-dir <实际模块目录> --host-profile modules --check
node tools/game_project.mjs check --project <实际独立工程>
```

针对性反例实际触发重复号，正例重新生成后通过。记录检查前后锁/输出/SDK 的字节与 mtime；临时 staging 可写但最终输入/输出不能改。工具不得为绿色结果自动分配编号、删锁或重写配置。

## 6. T3：结果与矩阵接入

### 文件责任

- 现有 `tools/test_step_runner.mjs`、`tools/run_test_matrix.mjs`：复用结果和进程回收，补预检步骤；已有行为能满足时仅接入，不重写。
- `tools/game_project_build.mjs` / `game_project.mjs`：检查阶段清晰说明结果与未执行服务层验证。
- 当前项目检查相关 self-test：完整运行/失败停止/后续 skipped/资源回收反例。
- 游戏 `tools/tiangz.mjs`、真实同步检查入口：仅当试点范围包含该游戏时接入，沿用声明宿主。
- 不修改 Developer Tools 的旧工程分析器以强行扫描独立模块；模块通过声明宿主入口。

### 验收

将 validation-matrix 每行与一个实际命令、提交身份和产物关联；带服务/库/UI 的步骤不能由静态结果代填。中止后未运行项明确 skipped。检查失败不得执行自动修复、发布或服务启动。

## 7. P1：规则工具与插件分发

### 文件责任

- Developer Tools 对齐版本后的 `packages/design-core/src/rules.ts`、相关推荐/格式化及 `test/design-core.test.mjs`；保持当前请求/响应格式，增加有依据的通用条目。
- TiangZ `docs/patterns` 与 `tools/verify_design_rules.mjs`：规则 ID/文档对应一致；优先沿用现有验证。
- TiangZ `tools/ai-assistants/build.mjs` / `distribute.py`：一般沿用；如需适配新增文件，显式更新产物清单与完整性检查。
- AI Plugins：版本、release note、distribution-manifest、Codex/Claude/Cindy 产物、MCP build-info 和许可证；仅通过维护源和正式生成分发处理。

### 以后运行的验证

```text
# Developer Tools 对齐的实际工作树
npm run test:design
npm run test:design-cli
npm run test:design-mcp

# TiangZ 对齐依赖之后
node tools/verify_design_rules.mjs
node tools/ai-assistants/build.mjs
node tools/ai-assistants/check.mjs
node tools/ai-assistants/build.mjs --check
```

分发使用 `distribute.py --repository <显式插件工作树>`，必要时带 `--developer-tools <实际已构建包>`；先确认本机有效 Python 路径，不假定 `python` 可用。该步骤改变分发产物，只有后续明确包含时执行。

归档提取后核对实际工具、规则集合、文件哈希与包身份，保留现有工具/请求兼容性。客户端安装与真实新会话评估若未执行，列为未执行，不报告已生效。

## 8. G1/G2：游戏试点

### G1 文件责任

- 拟新增 `modules/starter/src/model/PlayerData/PlayerDomainRegistry.ts`：封闭领域键、映射和冻结顺序清单；导出受真实 Model 检查。
- 拟新增 `modules/starter/src/hotfix/PlayerData/PlayerDomainAdapters.ts`：运行期装配与行为，无模块级可变状态。
- 调整 `PlayerDataModel.ts`、`PlayerDataRecords.ts`、Model 入口与 Hotfix 入口：保持既有类型/稳定签名兼容，新增签名需完整构建重启。
- 调整 `PlayerDataUnitSystem.ts`、`PlayerDataDbStoreSystem.ts` 与实际内存 Store：复用读写/回执/Apply 装配，业务方法及其错误次序保持。
- 新增 `tools/player-domain-registry.test.mjs`，扩展既有玩家数据/领域测试；具体内存 Store 文件以开工时搜索实际实现为准。
- 更新游戏对应 docs/features 设计与实施计划，保留现有功能的 TODO；本设计文件不代替游戏试点的具体代码依据。

### G2 文件责任

- 拟新增 `tools/test-support/player-domain-fixture.mjs`，各规则/领域/生命周期用例按需要使用；不把所有测试改成一种集成测试。
- 新增通用故障场景驱动，业务输入/期望仍由各功能定义；每用例独立状态，失效依赖不能自动填补。
- 复用 `model-exports.test.mjs`、真实持久化探针、客户端网络与目标客户端验证；用例身份不互相代替。

### 以后运行的验证

```text
# 游戏工作树；拟新增入口必须先实现
node --test GouDaoSanGuo/tools/player-domain-registry.test.mjs
node --test GouDaoSanGuo/tools/model-exports.test.mjs
npm --prefix GouDaoSanGuo run check
npm --prefix GouDaoSanGuo run client:check
npm --prefix GouDaoSanGuo run config:check
node --test --test-concurrency=1 GouDaoSanGuo/tools/*.test.mjs
```

多进程冒烟、真实数据库、浏览器/Creator 由游戏的实际验收入口与当轮明确范围决定。数据库目标、凭据、互斥和停止归属在开工时从现行游戏约定确认，不照搬其他任务的环境。资产/提交后回复丢失等风险只在有这些运行证据后才关闭。

## 9. M1：效果观察

在实际获准的新功能实施计划添加轻量记录：范围、有效投入时间（阶段分项）、机器等待、手写接入点/文件、缺陷类别、发现阶段、返修提交、检查耗时。数据缺失写未知。

连续两次适用扩展后评估接线减少与缺陷提前发现；不要求为量化效果自动启动额外玩法、压测或性能实验。无法建立可比基线时仅报告观察，不能填节省百分比。

## 10. 风险与批次回退

| 风险 | 处理与退出条件 |
| --- | --- |
| Node 检查桥掩盖真实 Native 问题 | 报告验证范围；Native 调用明确 unavailable；真实宿主独立验证 |
| 默认 Model 预检破坏合法消费方 | 先验证消费方兼容；不兼容先修工具/重设计，不提供成功跳过 |
| 提取 helper 改 bundler 行为 | 单独提交、既有构建自测及输出核对；差异未解释不推进 |
| 消费旧版 Developer Tools | 核对真实锁/包与目标源码；未对齐暂停 P1，保留其他独立批次 |
| 游戏登记改变存档/回执顺序 | 原字节和原错误次序回归；不一致退出该批，不自动清库 |
| 夹具过度统一降低隔离性 | 规则测试独立，故障注入显式，真实加载层单独 |
| 插件规则增加但模型未使用 | 区分产物检查与实际场景评估；未评估不报告行为改进 |

每批先可审查提交，回退只覆盖该批拥有的文件/语义。不得清理他人缓存、改开发环境或让失败检查静默成功。

## 11. 进度与授权记录

| 日期 | 阶段 | 已做 | 未做 |
| --- | --- | --- | --- |
| 2026-10-13 | D0 | 当前代码/版本只读核对；完整设计、实施计划、验收矩阵；本地文档链接/状态检查结果在本轮交付核对 | 产品代码、规则源修改、生成/分发、服务/数据库、实现测试、独立实现评审、发布/安装/合并/推送全部未执行 |

后续通知到来时在此登记原话、准入范围、批次和实际结果。没有通知，不将任何实施批次改成进行中。

### 2026-10-13 第一组实际交付

基线为 TiangZ 主仓库 `fbd60780bcb974d705d8abe894459ad3a84b8703`，独立分支 `codex/development-guardrails`。游戏、Developer Tools 源码与 AI Plugins 分发仓库没有写入。本轮只调整 Core 内部导出错误上下文，稳定声明与基线完全相同；Rust、依赖锁、协议锁均未修改。官方 `npm run codegen` 更新 `codegen.manifest.json` 的源指纹。

P0 新增五项规则与九个评估场景；Codex/Claude/Cindy 生成及一致性检查通过，规则缺失、重复 ID、断引用反例通过，技能格式检查通过。场景文档是评估输入，不是实际 AI 对话成绩。P1 仍需处理维护源 Cindy 0.3.1 与已分发插件 0.3.2 的身份对齐，以及宿主安装 Developer Tools 0.16.2 与本地源码 0.15.2 的版本差异；本轮未分发、安装或降版本。

| 实际检查 | 结果与证据范围 |
| --- | --- |
| `npm run verify:quick` | 39/39 步通过，failed/skipped/timedOut 均 0；180121ms；含 235 项既有单元测试、真实模块宿主、Rust fmt/Clippy/all-targets tests |
| `npm run test:module-model-exports` | 27/27 测试通过：真实 Core 导出、Public API/依赖边界、Native 声明桥、期限/中止/超输出、输入字节与 mtime、工程入口失败停止 |
| `npm run test:module-protocol-merge` | 1/1：真实 Git 无文本冲突合并得到撞号；正式 `--check` 明确失败且无改写；只撤回夹具未发布编号后显式生成恢复 |
| `npm run test:ai-assistants` | 正式生成、检查、`--check` 与 1 项产物反例测试通过 |
| 构建 helper 提取前后核对 | 两个 bundler 均使用本轮相同 Core 与同一模块夹具，18 个输出逐字节相同；含 Model/Hotfix JS、manifest 与配置 |
| 苟道三国当前 Model 兼容 | 从游戏提交 `08c335749ed2528d7bfab9aaa813ae121c7b2561` 只读归档模块，在隔离副本用当前宿主生成 402 个协议消息，真实 Model 预检 passed；原游戏文件未改，未验证数据库、UI 或 Native 运算 |
| `node tools/verify_core_api.mjs --strict-lock` | failed；主分支基线与本轮均出现同样五个声明图文件漂移。隔离副本导出完整声明快照逐字节相同，证明本轮没有新增漂移；没有更新原发布锁 |

原始日志保留在本工作树忽略目录 `temp/guardrails-validation/`：`quick-first.log`/`quick-first.json` 是首轮，`quick-host-ready.log`/`quick-host-ready.json` 是完整补验；另有 `bundler-extraction.json`、`core-api-baseline-comparison.json` 与 `game-copy-model-first.json`。本地时间为 10-13，完整补验报告 UTC 为 2026-10-14T00:03:40.869Z 至 00:06:40.990Z。原始链接器警告保留，不宣称所有日志零警告。

首轮失败分别记录：Model 夹具漏 Native 抽象 Entity 根且依赖版本写成非清单形态；断言曾期待改写后的锁错误文案，而原校验已正确拒绝；快速矩阵 38/39 的唯一失败是新工作树没有调试宿主。修正夹具并保证 finally 恢复、匹配既有错误语义、在自有工作树构建宿主后独立补验，未删测试或放宽标准。技能检查的 PyYAML 依赖仅装入本轮临时目录。

发布锁漂移属于已证明存在于基线的遗留，后续发布前需独立审查签名兼容性；不得直接用更新锁掩盖。本轮没有运行 `verify:release`、完整长稳/性能、真实 Godot（未配置 GODOT_BIN）、实际 AI 对话、插件安装或游戏领域/事务重构，也没有独立实现评审结果。GitHub CI 与 PR 合并状态须按后续实际结果记录，不由本地通过代填。

### 2026-10-13 完整剩余实施记录

需求方随后明确“可以，请继续推进直到完成”。本段更新当前结果，上一段保留第一组当时的历史事实。所有代码使用各主仓库独立工作树；没有开发游戏的 TiangZ 副本。

| 项目 | 实际结果与边界 |
| --- | --- |
| T3 工程检查 | 十项测试通过：真实 CLI、失败停止/skipped、Native 失败、内层 unavailable/timeout/abort、两种输出模式统一预算、输入字节及依赖身份、无限身份探针超时和运行中止回收。身份目录加载与哈希一起在首阶段有界子进程执行，最多 60 秒；没有在父进程先做无界采集 |
| 输入身份 | 四个实际解析工具包的路径/版本/内容哈希、模块声明源与 Native Rust 源/工具链纳入 SHA256；明确源码根优先于缓存排除。嵌套合法 dist/temp 源保留，缓存目录可跳过，指向根外的链接失败，根内链接绑定纳入身份；不以同版本号代表同字节 |
| 独立框架评审 | 两轮真实发现的问题修正后复核通过，无必须修复项；Core Stable exports 212、apiSurface 和 public/protected 成员兼容。内部 private/#private 声明图确实更新，官方更新锁后 strict-lock 通过，签名 9f6da82c6b9c |
| Developer Tools | 从远端真实 0.16.2 实施为 Core 0.16.3，五规则同步为 29，既有三个 MCP 工具/text JSON 合同不变；完整 check 157 passed、3 既有平台 skipped、0 failed。提交 16c05c9，GitHub PR 6 的 Windows/Linux 检查及 package 全通过；VSIX 0.16.4 历史身份未改，未发布新 npm 包 |
| 宿主依赖 | 正式 npm 安装并锁定 Developer Tools Git SHA 16c05c9ca68c530464aced4d85257e3d608736f3，不覆盖旧 tag；安装包实际 0.16.3，规则/文档核对 29/7 通过 |
| AI 分发 | 源正式生成、显式分发及 --check 通过（13 产物、0 stale）；12 项 SHA、Cindy CRC、两技能格式、源/分发字节核对及提取 MCP 0.16.3 握手、三只读工具、29规则/Quest 建议通过。插件候选 0.3.3，分发提交 9a0ecb4，GitHub PR 4；未安装生产配置或发布 Marketplace |
| AI 行为 | 两个真实 fresh Codex CLI 0.162.0-alpha.17.2 会话实际调用随包 MCP。首轮策略拒绝文件读取，未绕过；后续提供实际技能/reference 原文与主会话真实 Model JSON，独立评审确认九场景核心判断正确。模型后端身份 unknown，独立文件读/命令执行及部分下一步证据未验证，A07 仅部分关闭 |
| 游戏 G1/G2 | 基线 fee4e32，实施224b767、检查维护0acca01、SG2源错误码补齐af9eab3；封闭十域登记、两 Store/Unit/Factory 接线及真实状态夹具完成，独立评审16/16及Unit 99方法/旧字节轨迹兼容。af9全工具1551 pass/0 fail/1历史归档skip、7801五阶段21 PASS/12次真实Host启动，源/生成物原字节恢复。4d1633d仅修既有T4 smoke合同的3文件，1818生产文件与af9相同；远端新tag等待正式门禁，不提前关闭 |
| M1 | 记录十域重复接线与两主要测试消费者的真实减少；生命周期整块移动不计玩法算法减少。有效工时未知，无两次新领域可比扩展，不填写节省百分比或可靠性提升比例 |

候选归档 SHA256 `5559169063fe40bc4bc00de7920127e25e838fee400212530d93bae113bb1660`，MCP bundle SHA256 `cb7afb57e7089cfbda1fa6717e07c50031cf4ec0ad66d7e3fd9b09fed76b148b`。原始日志位于忽略目录 `temp/guardrails-validation/`，包括 `t3-identity-bounded-first.log`、`p1-artifact-identity.json`、两次 AI 事件/结果和真实 Model 正反例；测试结果不含凭据，原失败不替换。

GitHub 依赖审计发现 quinn-proto 0.11.17 三项新安全公告：[RUSTSEC-2026-0343](https://rustsec.org/advisories/RUSTSEC-2026-0343.html)、[RUSTSEC-2026-0340](https://rustsec.org/advisories/RUSTSEC-2026-0340.html)、[RUSTSEC-2026-0338](https://rustsec.org/advisories/RUSTSEC-2026-0338.html)。正式 Cargo 更新锁到修复版 0.11.18 并重新构建本轮宿主；没有新增审计例外或改 Rust 业务源。当地未安装 cargo-audit，审计通过状态以新提交的 GitHub CI 为准。

首失败另外保留：T3 误列 protobufjs（非本宿主工具依赖）、MCP 测试误读 structuredContent、评估 harness 的相对路径与 Windows 过长参数问题。均修夹具/调用方式，未改工具合同、放宽检查或抹除失败。

最终 `npm run verify:quick` 为 **39/39**，failed/skipped=0，239563ms；UTC 2026-10-14T01:15:19.851Z 至 01:19:19.414Z，包含 Model/工程检查35项、TS既有单元235项及Rust全目标测试。此轮使用 quinn-proto 补丁后本工作树新构建宿主；`node tools/verify_core_api.mjs --strict-lock` 再验通过。原始记录为 `final-verify-quick.log`/`.json`。没有运行 release/full资格、Godot、长稳/性能或目标UI，CI审计与游戏V1另记。
