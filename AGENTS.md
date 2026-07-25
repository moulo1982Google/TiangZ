# TiangZ AI 协作入口

本文件是进入 TiangZ 仓库的 AI 编码助手必须先读的规则。它只保存高优先级约束；完整架构背景见 [AI 项目上下文](docs/ai/project-context.md)，业务开发流程见 [AI 业务开发手册](docs/ai/business-development-manual.md)。

## 开始工作前

1. 执行 `git status --short`，保留用户已有修改、未跟踪文件和本地配置，不得擅自还原、删除或覆盖。
2. 先判断请求属于业务、协议、客户端、框架、Rust Runtime、生成器还是性能工具。
3. 业务需求优先查找 `app/demo` 中最接近的现有实现，再阅读对应教程和测试。
4. 当前事实的可信顺序是：运行中的代码与测试 > `README.md`、`docs/tutorials`、`docs/reference`、`docs/design/maintainer-guide.md` > `docs/roadmap.md` > 历史 `phase*_plan/acceptance` 和旧性能报告。
5. 用户说“讨论”“先看”或“先别改”时，只检查和说明，不修改文件。

## 架构世界观

```text
Machine
  -> OS Process（一个 V8、一个 TS 业务线程）
      -> EntryScene（配置启动的顶层业务边界）
          -> Scene（动态地图、副本等业务容器）
              -> Unit/Actor（玩家、怪物、NPC 等消息目标）
                  -> Component（状态与领域能力）
```

- Rust/Tokio负责网络、分帧、背压、跨进程连接、宿主能力和Rust权威实体数据。
- TypeScript负责Scene、Actor、Component、Handler和可热更业务编排。
- 一个Process内可以启动多个EntryScene；同进程调用进入目标mailbox，跨进程调用走Inner TCP，业务代码不判断本地或远程。
- Actor通过`InstanceId`直接定位并进入自己的mailbox。不得收到玩家消息后遍历地图寻找玩家。
- `ordered` mailbox在Handler跨越`await`时仍保持同一Actor/Scene串行；`unordered`允许异步重叠，但不会获得多线程CPU并行。

## 默认修改边界

| 路径 | 职责 | 业务需求默认是否修改 |
|---|---|---|
| `app/demo` | 服务端示例业务 | 是 |
| `proto` | 协议源文件 | 需要新消息时 |
| `cocos_client2D/assets/scripts/Demo` | Cocos业务和表现 | 需要客户端行为时 |
| `pixi_client/src` | Pixi/H5验收业务 | 需要跨客户端验收时 |
| `configs` | Process/Scene部署配置 | 需要新增实例或环境时 |
| `native_data` | Rust权威数据原型与Native op声明 | 只有明确的数据下沉需求时 |
| `app/core` | TypeScript框架 | 默认不修改 |
| `src` | Rust Runtime、网络和宿主 | 默认不修改 |
| `tools` | codegen、检查和维护工具 | 默认不修改 |
| `app/generated`、`src/generated`、客户端`Generated` | 自动生成物 | 永远不手工修改 |

如果业务可以通过现有Scene、Actor、Component、协议和广播能力完成，不得为了该业务新增Core抽象或Rust特殊分支。确实缺少通用能力时，先说明现有机制为什么无法表达、影响范围和最小扩展方案，再修改框架。

业务只能从`app/core/public.ts`导入Core能力。该文件及`public-api.lock.json`定义Stable API；其他Core路径默认是Internal。公共API分级和变更流程见[公共API与版本稳定性](docs/reference/api-stability.md)。

## 业务代码形状

推荐调用链：

```text
协议 Handler（薄适配）
  -> Unit/Scene 领域方法（功能胶水）
      -> 一个或多个 Component（状态和领域能力）
```

- 一个协议入口一个独立Handler文件；小型EntryScene可继续使用方法装饰器。
- Handler可协调多个Component，不要求绑定到单一Component。
- 不增加只转发一次调用的`Sink`、`Delegate`、`Manager`或事件层。
- 在Factory中使用`AddComponent`确定Entity能力；运行时使用`GetComponent`访问必需能力。
- `Awake`必须同步。数据库、RPC等异步初始化由Factory在发布Entity前显式等待。
- 业务日志使用注入的`Logger`或`scene.logger`，不得新增`console.log`。
- 业务状态归属Scene、Actor或Component；不得用模块级可变变量或全局单例替代正确所有权。

## 协议与状态同步

- 网络帧固定为`[length:u32 BE][msgcode:u16 BE][protobuf payload]`。
- `rpcId`属于`IRequest/IResponse` payload，不属于公共帧头，业务代码不手工处理。
- RPC使用生成的descriptor和强类型Client，不手写msgcode、codec或请求响应关联表。
- Snapshot用于进入、重连和主动全量同步；Delta用于可覆盖状态；Event用于技能、道具、掉落等不可丢失事实。
- `latest`只用于相同稳定key可覆盖的状态；`event`不得静默覆盖。
- Audience决定“发给谁”，descriptor决定“如何排队和合并”，两者不得耦合。
- 修改proto后不要静默更新opcode/schema锁。新增或变更协议必须在说明契约影响后显式执行`npm run codegen:proto:update-lock`。

## Rust权威数据

- 当前跨帧高频Entity数据可存放在Rust实体存储中，TS只持有generation handle。
- “Rust Arena”在本项目中指Rust侧集中管理Entity的存储，不是业务开发者需要直接操作的特殊语言功能。
- 普通业务数据默认先使用TS Component。只有数据量、访问频率、批量编码或热更状态所有权存在明确收益，并且用户同意后，才增加`.native`原型或Native op。
- 数据下沉后固定为`TS -> generated Fast Op -> Rust Entity Store`；Rust不得回调TS读取权威状态。
- 不在Update中默认逐实体逐字段跨边界扫描；需要批量处理时设计粗粒度op。但标量getter/setter仍是允许的API，由开发者根据指标决定是否使用。

## 代码和文档约定

- 手写`app/core`、`app/demo`和`src`函数注释遵循[代码注释约定](docs/reference/coding-conventions.md)：中文在前、英文在后，重点说明副作用、生命周期、顺序和错误语义。
- 新增文档以中文为主；公共术语可保留英文对照。
- 任何架构、目录边界、数据所有权、协议语义或业务开发流程的设计变更，都必须在同一改动中同步更新[AI项目上下文](docs/ai/project-context.md)和[AI业务开发手册](docs/ai/business-development-manual.md)。不能只改代码或只更新其中一份。
- 不修改Generated文件；修改其输入后运行codegen。
- 不做无关重构，不改无关性能参数，不清理用户文件。
- 长稳和大规模性能测试会长时间占用机器，未经用户明确许可不运行。

## 最低验证

```powershell
# 普通业务和文档之外的代码修改
npm run verify:quick

# 协议、进程通信、mailbox、背压或生命周期边界
npm run verify
```

小范围业务修改可以先执行针对性测试，具体矩阵见[AI业务开发手册](docs/ai/business-development-manual.md)。最终回复必须说明修改文件、codegen情况、实际执行的验证以及未执行的验证。

## 当前技术方向

- TypeScript是唯一主业务语言，Rust是Runtime和权威数据层。
- Wasm只作为未来重计算模块的候选，例如确定性战斗核心；当前不接入。
- Rhai只作为未来脚本后端候选；当前不为它增加兼容层。
- Phase 4开始前的质量门已完成；当前业务路线从账号/角色、地图传送、AOI、怪物和社交域继续。
