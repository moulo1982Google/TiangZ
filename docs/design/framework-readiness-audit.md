# Phase 4 前框架成熟度审计

审计日期：2026-07-26。审计基线：`0.3.10-alpha.4`。

本审计回答一个问题：在继续扩展 MMORPG 业务前，TiangZ 还缺少哪些可以被自动验证的框架能力。业务功能只作为验收夹具，不以增加玩法数量表示框架成熟。

## 结论

Phase 3.10.1 至 3.10.4 已经建立公共 API、RPC/Actor 正确性、故障注入和可观测性基础。R1、R3 与 R4 已于 2026-07-26 完成；Phase 4 准入目前只被 R2 TypeScript 热更闭环阻塞。

1. Developer Tools 的架构规则与仓库约定不一致；已完成。
2. TypeScript 热更没有形成可回滚的进程级闭环；待实现。
3. 性能测试能生成报告，但不能自动判定回归；已完成 Windows/Linux 基线与门禁。
4. 完整质量门和 Release 流程尚未同时覆盖 Windows 与 Linux；已完成。

完成这些工作并发布 `0.3.10` 后，再进入 Phase 4。AOI、动态副本、角色业务和生产级监控运维不属于本轮准入。

## 已确认基础

- 一个 OS Process 拥有一个 V8 和一个 TS 业务线程，可承载多个 EntryScene。
- Core、Generated、Demo 的运行时依赖方向正确，Stable API 由 `app/core/public.ts` 和 API lock 管理。
- codegen manifest 与项目版本检查通过。
- RPC id、多路复用、mailbox、Actor 生命周期、断线清理、背压和故障注入已有确定性测试。
- Prometheus/Grafana 已能按 Process 采集 Runtime、Scene、队列、延迟和 NativeData 指标。
- 200 玩家、每玩家 5Hz Move 的拆分进程链路完成过 10 小时长稳；该结果是稳定性证据，不是业务容量承诺。

## 阻塞项 R1：开发工具规则一致性

### 当前事实

状态：完成（2026-07-26）。Developer Tools `v0.8.1` 已在共享规则核心表达 `bench -> demo` 单向依赖和 `app/main*.ts` 组合入口，反向依赖仍会报错。主仓库已升级依赖，`npm run check:project` 检查 226 个文件，结果为 0 错误、0 警告，并已接入 `verify:quick`。

这不是通过忽略规则解决的问题。VS Code 诊断与 CLI 使用同一规则核心，错误模型会直接影响开发者对目录边界的理解。

### 验收条件

- Developer Tools Core 明确表达 `bench -> demo` 单向依赖和 `main*.ts` 组合入口。
- `demo -> bench` 继续被拒绝。
- VS Code Problems 与 `npm run check:project` 对同一文件给出相同结论。
- 规则仓库增加正反例测试，主仓库升级依赖后 `npm run check:project` 通过。
- `check:project` 接入 `verify:quick`，架构规则不能只是开发者手工执行的旁路检查。
- 不在 TiangZ 主仓库增加路径白名单来掩盖工具模型错误。

## 阻塞项 R2：TypeScript 热更闭环

### 世界观

热更粒度是整个 Process 的 TS 世界，不是单个 Scene。一个 Process 内的 EntryScene、进程级 Singleton、Timer、mailbox 和异步任务共同属于同一 Bundle 版本；不允许同一个 V8 中长期存在半新半旧的业务定义。

Rust `NativeEntityStore` 当前是 V8 线程上的持久权威存储。它可以成为热更后保留状态的基础，但目前没有版本、所有权、重绑定和迁移契约。仅仅重新执行 `dist/main.js` 不构成热更。

### 必须冻结的语义

1. **候选自检**：新 Bundle 在隔离 V8 中以无副作用注册模式完成语法、入口、协议指纹、Stable API 和 Native schema 兼容检查。
2. **稳定类型**：可热更类型拥有稳定 typeId；新 generation 通过 staging registry 提交 prototype 方法补丁，现有 Entity/Component 不重建。
3. **切换屏障**：Rust 短暂停止投递新业务帧，同时保持宿主队列有界；外部连接不因切换断开。
4. **异步排空**：已进入 Handler 的旧 Promise 继续完成并持有旧 generation；新消息只进入新 Handler 表。
5. **生命周期归属**：Scene、Entity、Component、Timer、Update target 和异步任务都能归属到 Bundle generation；长期 Timer 不保存无法追踪的旧闭包。
6. **原子切换与回滚**：prototype、migration 和 Handler 表作为一次事务提交；失败时恢复旧描述符和注册表。
7. **可观测性**：日志和指标携带 Bundle 版本、切换阶段、耗时、在途 generation 数和失败原因。

### 验收条件

- 无连接和有连接两种热更均有自动化测试。
- 覆盖同步 Handler、等待远程 RPC、重复 Timer、Entity/Component、Rust Native Entity 和切换失败回滚。
- 热更前后 Session、Unit、Component 实例与 Rust handle 保持不变，现有实例能调用新 prototype 方法。
- 热更期间队列不越界、RPC 不错配、单向 Message 不重复。
- 同一 Bundle 连续切换 100 次后，V8 Heap、Rust Entity 数、Timer 数和 pending operation 回到稳定区间。

完整决策和限制见[Process级TypeScript热更设计](typescript-hot-reload.md)。

## 阻塞项 R3：性能回归门

### 当前事实

状态：完成（2026-07-26）。`perf/gate` 已统一 RPC payload、local/remote Inner RPC 与三类状态复制，默认三轮取中位数；基线按平台、架构、CPU 与参数保存，机器不匹配会拒绝比较。Windows i7-13700F 与 Linux VMware 16 vCPU 均已建立独立基线并通过比较模式。`npm run verify:perf` 在吞吐或 p99 越界、错误非零时返回非零退出码，基线只能通过携带 `--reason` 的显式命令更新。

### 分层门槛

| 层级 | 用途 | 默认执行位置 |
|---|---|---|
| 微基准 | Binary、bridge、protobuf、Native dirty replication | 普通 CI，固定短时参数 |
| 框架链路 | local/remote Inner RPC、ordered/unordered mailbox、状态复制 | 专用性能任务，至少三轮取中位数 |
| 完整链路 | 登录、Gate、Map、移动、Push | 专用空闲机器，不作为普通提交的快速门 |
| 长稳 | 错误、积压、RSS/V8 Heap 趋势 | 人工或夜间任务，不进入日常 CI |

### 验收条件

- 基线按 OS、CPU 标识、Runtime profile 和关键参数保存，不跨机器直接比较吞吐。
- 性能 comparator 检查吞吐、p99 和错误；错误零容忍。队列上限与背压等待由 `test:backpressure` 的故意过载夹具验收，RSS/V8 Heap 趋势由长稳测试验收，不能用短时性能样本替代。
- 噪声较大的链路至少三轮取中位数，阈值保存在版本化配置中，不硬编码散落在 runner。
- 更新基线必须使用显式命令并生成旧值、新值、变化百分比和原因模板。
- 提供 `verify:perf` 单一入口，回归时返回非零退出码。
- AOI 可见性和具体玩法吞吐不作为框架门；只测试框架能够稳定复现的通信与状态复制能力。

## 阻塞项 R4：发布与跨平台收口

### 当前事实

状态：完成（2026-07-26）。Runtime smoke、mailbox 和背压已改为跨平台 Node runner；Rust 固定为 1.97.1，Node/npm 固定主版本并使用 lockfile。Windows 与 Ubuntu Linux 均通过同名 `npm run verify`。Release 脚本在两平台生成 Runtime、TS bundle、配置、版本信息和 SHA-256，并在最终制品目录完成真实客户端 smoke。依赖审计在两平台均为 0 advisory，漏洞例外必须声明负责人、原因和到期日期。

干净 Linux 环境还验证了 Cocos 检查边界：Client SDK 始终执行完整 TypeScript 检查；Cocos Demo 在有编辑器类型时执行完整 tsc，在 CI 无编辑器缓存时执行显式 tsconfig 的入口 bundle 检查，不提交或伪造 `cc` 类型。

### 验收条件

- Windows 与 Linux 都能执行同名的 `verify:quick` 和 `verify`；平台差异只存在于 Backend 专项测试。
- 用跨平台 Node/Rust runner 替换核心验收路径中的 PowerShell，PowerShell 仅保留为可选人工包装。
- 固定 Rust channel、Node 主版本和 npm 版本；构建使用 lockfile 与 `--locked`/`npm ci`。
- CI 至少覆盖 Windows、Linux：codegen 漂移、Stable API、TS typecheck、Clippy、Rust test、Runtime smoke、mailbox、背压和故障注入。
- Release 一键生成 Windows/Linux 制品、默认配置、必要文档、版本信息和 SHA-256 校验和，并在解压目录执行 smoke。
- 建立依赖与许可证审计策略；漏洞例外必须带到期时间和原因。
- `0.3.10-rc.1` 完成全矩阵后才能发布 `0.3.10` Tag。

## 非阻塞维护项

以下问题需要治理，但不能为了“文件行数好看”进行机械重构：

- `app/core/process/types.ts` 同时承载配置类型、EntryScene、mailbox 和协议分发，热更实现前应按责任拆分 Internal 模块，保持 Stable 导出不变。
- `src/health.rs`、`src/process.rs`、`src/transport.rs` 和 `src/native_data.rs` 责任密度较高。只在新增行为需要修改对应边界时拆分，并先补行为测试。
- Demo 中应优先使用 Scene/Entity/Component 所有权 API 创建 Timer，不直接持有进程级 Timer，作为热更生命周期夹具。
- 根目录临时日志已被 `.gitignore` 和 clean 命令覆盖，不是源码问题；发布任务必须从干净复制目录构建。

## 执行顺序

1. 修复 R1，让架构检查重新可信并全绿。
2. 设计并实现 R2；热更会触碰生命周期，是风险最高的框架改造。
3. 在热更前后运行相同基准，完成 R3，防止稳定化工作引入隐性性能退化。
4. 完成 R4，以 Windows/Linux Release 候选验收整个 `0.3.10`。
5. 发布 `0.3.10` 后再开始 Phase 4。

每个阻塞项独立提交、独立验收。涉及架构、目录边界、数据所有权或业务开发流程时，必须同时更新 `docs/ai/project-context.md` 与 `docs/ai/business-development-manual.md`。
