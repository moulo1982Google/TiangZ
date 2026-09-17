# Process级TypeScript热更设计

## 最终边界

TiangZ保持“一Process一V8、多EntryScene”。Process是V8、TS业务线程、部署版本和热更事务的原子边界；EntryScene是业务边界，不拥有独立V8。

服务端TypeScript被明确拆成两部分：

```text
Model Bundle                     Hotfix Bundle
  状态、字段、构造、继承           Handler与领域方法实现
  Scene/Entity/Component身份       @systemFor(ModelType)业务System
  Core与协议稳定形状               可重复构建的业务行为
  Process启动后永久冻结            兼容时允许在线替换
```

**Model不能热更。** 这不是建议，也不是暂时限制。Runtime没有Model reload API；Model源码、Core Stable API、协议锁或Native schema发生变化时，必须完整部署并重启Process。

这个约束主动放弃在线字段迁移，换取更低的业务心智负担和更可靠的回滚：不用判断旧对象有哪些字段，不用让新构造器补初始化，也不用让两个状态结构同时存在。

## 目录与依赖

- `app/model`：不可热更的Scene、Entity、Component、状态、稳定类型和启动结构。
- `app/hotfix`：可热更的Handler和领域方法实现。
- `app/model/public.ts`：Hotfix唯一允许导入的Model入口，对外包名是`#tiangz/model`。
- `app/generated/bootstrap`：Model启动注册表。
- `app/generated/hotfix`：Hotfix Handler与System注册入口。
- `app/generated/bootstrap/systems`：从System公开方法生成并合并到Model的类型声明；禁止手改。

Hotfix不得深层导入Model或Core。Model/Core不得反向依赖业务Hotfix。`verify:hotfix-boundary`与Developer Tools共同检查这条依赖方向。

## 双Bundle与指纹

完整构建输出：

```text
dist/model.js
dist/model.manifest.json
dist/hotfix.js
dist/hotfix.manifest.json
```

Model manifest冻结以下内容：

- Model实际Bundle SHA-256；
- Model/Core/Generated bootstrap源文件指纹；
- protocol opcode/schema指纹；
- Stable Core API指纹；
- Native schema指纹；
- 外置游戏模块依赖图指纹；
- demo或bench构建模式。

Hotfix manifest必须逐项匹配这些冻结值。`npm run build:hotfix`重建完整 Hotfix 并打包配对配置，不重建 Model；只要Model源指纹改变就立即失败，并要求完整构建、部署和Process重启。没有忽略兼容检查的参数。Hotfix-only构建不会覆盖正在服务的`dist/hotfix.js`，而是输出`dist/hotfix-candidates/<内容哈希>/hotfix.js`与 manifest，以及 `game-config/` 完整配置目录，避免 Runtime 读到写了一半的候选。

外置模块通过构建期稳定拓扑顺序进入同一Model/Hotfix双Bundle。模块集合、版本、依赖、manifest或Model变化都会改变`moduleGraphHash`或Model源指纹，因此只能完整部署并重启；同一模块图中已有System/Handler的纯行为变化仍复用本章的排空、预检、事务提交和回滚。模块不能获得独立V8，也没有绕过Process原子边界的Reload入口。

## 业务System

Model中的类型拥有真实实例和状态，不再手写只会抛错的方法空壳。Hotfix System提供生命周期和领域方法：

```ts
// app/model/mmorpg/login/LoginComponent.ts
export class LoginComponent extends Component {
  protected loginCount = 0;
}

// app/hotfix/mmorpg/login/LoginComponentSystem.ts
@systemFor(LoginComponent)
export class LoginComponentSystem extends LoginComponent {
  protected override Awake(): void {
    this.loginCount = 0;
  }

  Login(account: string): LoginResult {
    this.loginCount += 1;
    return { account, loginCount: this.loginCount };
  }
}
```

`LoginComponentSystem`永远不会被实例化。codegen读取其公开方法，为Model生成声明，因此调用方仍写`component.Login(account)`；运行时直接把System的prototype描述符安装到Model prototype，不增加每次调用的Registry查找。`Awake`、`OnDestroy`等受保护生命周期同样由System提供，但不会生成公开API。

System在第一代安装后成为必需项。后续候选漏掉任意必需System，整次提交都会被拒绝并保留旧generation，不能让生命周期悄悄退回Model基类的空实现。Reload不会给现有对象重跑`Awake`；新对象使用新System的`Awake`，现有对象的普通方法和未来`OnDestroy`使用当前generation。

同步生命周期不只检查`async`语法。仓库静态门会拒绝`Awake/OnDestroy/Deserialize/CaptureTransfer/RestoreTransfer`的Promise返回类型；`Commit()`在安装任何prototype描述符或切换Handler槽之前遍历全部候选方法并拒绝异步保留钩子。运行时返回值检查仍保留为纵深防御，并观察意外Promise的拒绝以留下日志，但不能把它当作撤销已经开始的异步副作用。

实现类禁止声明：

- 实例字段和字段初始化器；
- 构造函数；
- 静态初始化块；
- 新的继承关系或状态形状。

这些内容属于Model。需要它们时，修改Model并重启Process。

## Handler切换

Scene、Session和ActorUnit的外置Handler保存在身份稳定的绑定槽中。路由不会永久捕获启动时的Handler函数，而是在调用时读取当前槽：

- 新Hotfix可以替换Handler构造器；
- 现有Scene、Session、普通Unit和ActorUnit都不重建；
- 提交失败时槽对象恢复旧描述符；
- `rpcId`和RPC多路复用不受generation影响。

第一代候选负责建立Handler key基线；从第二代开始，提交前会双向比较当前generation与暂存候选的完整key集合。漏掉、删除、重命名或新增任意Handler都会在修改prototype和绑定槽之前拒绝，旧generation继续服务。运行中的Scene不会重建Registry，因此Handler路由集合变化属于Model/协议注册变化，必须完整构建并重启Process；Hotfix只允许替换既有key的实现。

Handler实例可能在一个Scene内被复用，Event或Entity Extension Handler还可能被多个实例复用。因此所有`@messageHandler/@rpcHandler`、Session/Unit Handler、同步/Veto Event Handler和`@entityExtensionHandler`类都必须无实例字段、无构造函数、无静态初始化块和可变静态成员。状态归属于Scene、Session、Unit或Component；`verify:hotfix-boundary`通过TypeScript符号解析识别直接名、import别名与namespace写法，不能用重命名导入绕过约束。

方法装饰器形式的Scene内Handler也在每次调用时解析当前方法，因此prototype提交后会进入新实现。

## Hotfix 与配置的联合发布（2026-09-17）

每个 Process 仍只有一套完整 Hotfix，不按模块拆分运行时 generation。在线发布的最小单位改为 **完整 Hotfix + 完整 Luban 服务端配置快照**。只改代码、只改配置、两者一起改，都生成同样的候选目录：

```text
dist/hotfix-candidates/<releaseId 前16位>/
  hotfix.js
  hotfix.manifest.json
  game-config/
    game-config.manifest.json
    server.json / server.hot.json / server.cold.json
    client.json / client.hot.json / client.cold.json
```

Hotfix manifest 的 `gameConfigHash` 绑定配置 manifest 的实际字节，配置 manifest 再绑定所有数据文件及模块配置 payload。`releaseId` 对宿主版本、代码哈希、配置哈希及完整冻结契约按固定顺序取 SHA-256；顺序见 `tools/atomic_release_identity.mjs`，Rust 独立复核。`bundleVersion` 为宿主版本加完整 releaseId。因此配置单改也有不同发布身份，Model 基线或包版本不同也不会碰撞不可变候选目录；运维 `plan` 先检查契约兼容，再判断是否已经安装。

正常入口：`npm run build:hotfix` 构建联合候选；`npm run build:game-config` 是同一构建的便利入口。构建使用当前工作树的代码与配置，不会猜测线上正在使用的配置；生产构建必须检出明确的发布源码。Watcher 的 `reload <联合候选>` 和 `npm run hotfix -- plan/apply/status/rollback` 继续使用。`reload-config` 仅保留为联合加载别名，只接受同样的完整候选，旧的纯配置目录会拒绝。

低层 `build_game_config_data.mjs` 仅供构建器生成中间配置包；它的输出不可直接在线加载。`build:game-config:startup` 改为完整构建，避免独立覆盖启动配置破坏配对。完整构建同时建立配对启动包。首次升级此机制必须重建宿主与 Model 并重启，旧的未配对制品会明确拒绝。

联合提交固定发生在两个 Update 之间。保留原有 `pendingAsync/pendingIngress` 条件，帧结束不等于跨帧 `await` 已完成。候选在线准备完成后主动暂停新业务入口，主循环以排空模式继续推进；准备阶段不暂停玩家。3秒窗口内无法排空则放弃本次候选、恢复旧版本服务。网络队列不需要清空，切换也不需要重建 Process、玩家或连接。

业务硬约束：禁止以 `await sleep/delay/TimerSystem.WaitAsync` 或任何计时 Promise 维持跨倒计时调用栈。延迟、到期和周期事件必须走所有者 Timer 的方法名回调，届时解析当前 Hotfix。Developer Tools/模块构建对此报错，详见[时间调度模式](../patterns/timer-update-and-action.md)。这能消除业务人为等待时间造成的长期任务，但数据库/RPC 的跨帧等待仍存在；本次规则更新不改变上述热更安全条件，也不保证持续负载必然排空。

Runtime 先读取并验证整套制品，再在隔离 V8 预检。正式 V8 的 Begin 阶段解析全部模块配置，执行冻结的 Luban schema 和模块 validator，但不修改活动快照；随后暂存所有 System 与 Handler。Commit 同步安装方法和绑定，最后提交预备好的配置快照，再推进 Hotfix generation，期间不执行下一帧。

配置提交闭包只能在交换前检查代次，交换后仅进行不可抛出的内部赋值，不允许业务回调、Promise 或 I/O。配置校验失败、Hotfix 求值失败、Handler/生命周期预检失败都不发布配置；方法或绑定提交失败恢复旧行为；配置提交前检查失败也恢复本次已修改的方法和绑定。回滚时重新加载上一整个候选，代码与配置一起恢复并产生新 generation。内部回滚本身异常仍需告警与人工介入，不能把内存恢复失败宣称为成功。

服务端配置指标的 `data_fingerprint` 在此路径表示整个配置 manifest 的 SHA-256（含所有模块）；发布日志还记录 `configFingerprint`。启动与在线切换使用同一配置身份。`bundleVersion` 标识完整配对，不再仅代表 JS 哈希。

这个原子性只覆盖一个 Process 的行为和当前配置目录，不覆盖客户端资源、数据库写入、已经创建的升级任务或全部 Pod。长期任务需由模块明确冻结已接受的成本、结束时间等语义；回退发布不会撤销已扣款、发奖或迁移。Pod 重启仍加载部署的配对启动包；控制器持久化目标版本并在新 Pod 就绪前落实该版本，属于后续部署工作，当前没有完成跨 Pod 发布平台。

Model、协议、Native、模块图、Luban schema 或冷配置变化仍需完整构建重启。模块冷数据限制由其 validator 比较 previous 快照实施，不能将 MMORPG 的表策略当作所有模块天然具有的规则。客户端导出独立分发，不能把整个含服务端数据的候选放到客户端公开下载地址。

### 联合加载的回归验证

- `npm run test:unit`：覆盖暂存不提前生效、提交阶段失败恢复方法与 Handler、缺失 Handler、配置校验失败和整套回滚。
- `npm run test:game-project-dev`：临时脚手架与真实 Rust/V8 进程，验证同一连接的 Hotfix 更新、Luban 数据单改、发布身份变化、管理接口整套回滚、无效配置及纯配置目录拒绝，确认业务计数不回退。
- `npm run test:hotfix`：构建边界与不可变候选复用，确认代码、配置、包版本与每项冻结契约都参与发布身份。
- `npm run verify`：包含以上主要路径及 Native 模块组合宿主、生成脚手架的完整引擎矩阵。这些测试不代表已完成多 Pod 灰度、线上容量或客户端同步验收。

## 加载、提交与回滚

一次候选安装按以下顺序执行：

1. **离线构建**：codegen、typecheck、边界检查和指纹生成通过。
2. **在线准备**：独立线程读取并校验完整候选，在没有 Process 实例的临时 V8 中预检 Model、Hotfix 与配对配置。此时主 V8 正常服务；后续提交使用这份已校验字节，不再次读可能变动的候选文件。每 Process 同时最多一个准备任务。
3. **主动短窗口**：准备完成后暂停新业务帧进入 TS；玩家帧留在 Rust 原有有界队列，已进 TS 的帧和在途任务继续排空。业务 Timer/固定帧 Update 暂缓触发，时钟、微任务、宿主操作完成通知继续推进。Scene 和 Actor 安全条件不放宽，在两次 Update 间切换。
4. **在线暂存**：当前 V8 先验证并预备完整配置快照，再建立 staging generation 并求值 Hotfix；不发布任何候选配置。
5. **原子提交**：同步安装完整 prototype 方法集、Handler 绑定和预备配置快照，再进入下一帧。
6. **失败回滚**：任一步异常都恢复旧prototype描述符与旧Handler槽，旧版本继续服务。

第一版选择“排空到零再切换”，不让旧 Promise 和新 Handler 长期并存。`lifecycle.hotfixReloadTimeoutMs`默认3秒（3000ms），从准备完成、入口暂停开始计时，预留最多100ms（不超过窗口的10%）给同步提交。超时只放弃候选、恢复旧版本入口；不强杀在途 Promise、不修改调用方 RPC 超时配置。通用 TS 客户端 SDK 默认是5秒，业务若显式配置30秒则保持30秒，不能混为统一默认值。同步预备配置、候选求值和提交仍不能被这个预算强行中断，因此这是控制预算，不是端到端停顿硬保证。

内部 RPC **请求**也可能开启新业务，暂停期间从控制通道取出后暂存，最多128条，达到上限立即放弃本次热更并恢复投递；内部 RPC/DB 的宿主完成通知不被这份暂存阻塞。本地已开始任务产生的调用继续按原 mailbox 排空。若已有任务依赖新的远端业务请求才能结束，短窗口可能超时；首版选择安全退出，不做跨进程调用链追踪。网络连接类型由实际端点确定，客户端不能靠携带 rpcId 冒充内部控制消息。

暂停期间收到断线仍按原框架规则处理，已断线连接的剩余请求会被丢弃。其他请求使用原有有界队列/传输背压，满载可能触发原有过载或断线策略，不是无限缓存。现有客户端 RPC 协议未携带通用绝对 deadline/取消传播：客户端本地超时不等于服务器撤销，因此不能承诺所有超时请求都不会晚执行；经济业务必须依靠任务ID/请求幂等防重，不能通过自动重试修补。超过预算的更新建议转维护发布。

恢复后一次性 Timer 按到期规则触发，固定帧按已有追帧上限推进，不回放无限积压。`report.pauseMs`记录排空和实际同步安装的总窗口，`barrierWaitMs`记录排空等待，`preflightMs`单独记录预检；成功、失败均有入口恢复日志。首次升级此机制需重建 Rust 与 Model 并重启。单 Process 原子性不意味着多个 Pod 同时切换。

### 持续负载与换机复测

本轮实际条件、结果及下一步24小时命令见[主动暂停与联合加载验收记录](hotfix-pause-acceptance-20260917.md)。历史热更数据不能替代新机制验收。

跨进程、500请求积压、内部暂存满、断线/退出及真实DBProxy迟回包补测见[热更故障矩阵](hotfix-fault-acceptance-20260917.md)。`npm run test:hotfix-faults`不连接数据库，已纳入完整回归；真实DB需显式指定本机测试端点。用户已明确24小时暂不进行，不因脚本支持而自动启动。

```powershell
# 先完成主工程正式构建和完整回归
npm run verify
# 小规模冒烟，默认20客户端、60秒
node tools/hotfix_load_soak.mjs
# 500个无头WebSocket客户端，每个每秒2次请求，持续1小时，约每10分钟切换一次
node tools/hotfix_load_soak.mjs --seconds 3600 --clients 500 --reload-seconds 600 --requests-per-second 2
# 测试驱动默认显式使用30秒RPC超时；也可用 --rpc-timeout-ms 5000 做更紧预算测试
```

脚本使用正式脚手架、Luban/协议/SDK生成器，在 `temp/hotfix-load-*` 独立目录构建两套配对制品并启动本地进程；只停止自己启动的进程，保留 `report.json` 与 `server.log`。不需要真实玩家、数据库或SLG业务。先验证真实未完成 Promise 导致3秒退出及错误配置拒绝，再持续发请求，校验序号无缺口/重复、响应无混合配对，交替发布并回滚。最后一次计划更新提前约1秒，确保仍有客户端负载。

报告记录显式RPC超时、二进制哈希、请求数、错误数、最大延迟、延迟分桶、发布分段耗时和定期状态。单个客户端最多一条在途请求，这测的是并发持续业务和热更正确性，不是无界洪峰极限。长稳授权需单独确认；脚本支持 `--seconds 86400`，但一小时通过不等于24小时已验收。容量、DBProxy真实慢IO、跨Pod发布和不同游戏业务需要额外测试。Windows PowerShell 若禁止执行 npm.ps1，使用 `npm.cmd`，无需修改系统执行策略。

## 启动与当前实现状态

Runtime启动时先验证两个manifest和实际文件SHA-256，再进行隔离预检。正式V8只加载一次Model ESM，并通过不可写全局桥提供`#tiangz/model`稳定导出；Hotfix是完整IIFE脚本，以固定脚本名求值并安装generation 1，最后才启动Process并开放服务端口。Hotfix不进入ESM ModuleMap，也不为每代生成新的脚本URL。

基础实现与历史验证如下。涉及5个Process、8秒慢RPC、100代和3000玩家的数据属于早期0.3.10阶段，不是本次3秒主动暂停与配置联合加载的验收结果；新机制必须按上文持续负载脚本复测。

- Model/Hotfix目录与双Bundle；
- Model源码和四类兼容指纹；
- 隔离V8预检；
- staging、prototype/Handler事务提交与失败回滚；
- 现有实例原地获得新方法；
- Hotfix-only构建拒绝Model变化；
- Watcher通过跨平台stdin控制协议广播`reload <候选目录>`；
- Process独立复核候选，在现有帧间安全点提交，超时或失败保留旧generation；
- `/metrics`发布active generation、成功/失败次数及validation/preflight/barrier/eval/commit/total耗时；
- 5个拆分Process连续切换100次至generation 101并拒绝损坏候选的运行时自测；
- 现有PlayerUnit在不改变InstanceId和Native handle时获得上下反转Move实现；
- 8秒慢异步RPC使帧间 Reload 的安全条件等待约7.7秒，完成后正常提交且RPC没有错配；
- Component/Actor一次性与重复Timer只保存owner和方法名，现有Timer切换后调用新prototype；
- 100代资源测试先预热10代，再测量后90代：Timer、Native实体和pending均无漂移，5个Process的V8 Heap/RSS增长通过4MB/16MB硬门槛；
- 边界与事务自测。

历史3000玩家基线与1Hz Reload A/B记录为90/90次切换成功且Move吞吐无可见下降，但Probe尾延迟约增加三成。这些数字不代表当前版本容量。当前3秒窗口遇到8秒未完成RPC应放弃候选，不再沿用旧测试的等待约7.7秒后提交预期。Reload仍然不能直接覆盖`dist/hotfix.js`；必须构建不可变候选目录并通过运维入口提交。

## Timer、Update与状态

Model对象和字段在Process生命周期内不变，热更只替换其方法。Timer与Update仍需遵守所有权规则：

- 业务Timer归属于Scene、Entity或Component，owner销毁时自动取消；
- Component/Actor的一次性与重复Timer都传入Hotfix方法名，框架触发时解析当前prototype；不要绕过owner API把业务闭包直接交给进程级Timer；
- 热更提交前必须等在途业务任务归零；
- 模块级可变状态不属于任何Model对象，禁止用它保存业务状态。

Rust Native Entity是权威状态时同样不迁移schema。`.native`变化意味着Model版本变化，必须重启Process并按持久化协议处理兼容。

## 开发流程

本地日常开发优先使用源码模式：

```powershell
npm run dev -- configs/local/cluster/StartMachine.json
```

开发宿主先执行一次完整构建并启动Watcher，之后监听`app/hotfix/**/*.ts`、`game_config`的Excel/定义源，以及`TIANGZ_MODULES_DIR`中每个已校验模块声明的Hotfix源码根。Hotfix保存会串行执行入口生成、主工程与模块独立类型检查、不可变候选构建和Watcher `reload`；纯配置数据变化也会构建完整 Hotfix + 配置候选并执行 `reload`。连续保存会合并，构建失败时不发送切换命令，旧 generation 与旧配置快照一起继续运行。它不监听Model、Core、模块Model/manifest、Proto或`.native`；配置表结构变化也会被schema门拒绝，这些边界变化仍要求开发人员停止、完整构建并重新启动。源码模式只是隐藏构建步骤，不会让V8直接执行TypeScript，也不得用于正式部署。

需要边调试边Reload时使用：

```powershell
npm run dev:debug
# 默认启动 configs/local/debug/StartMachine.json，并连接 all-in-one 的 9231 Inspector
```

Debug模式让初始Model/Hotfix和后续每个Hotfix候选都携带内联sourcemap与`sourcesContent`。Process和V8不重启，VS Code保持同一Inspector连接；候选求值时发布新的`scriptParsed`，原TS源码断点会重新绑定到新脚本。它不是Edit-and-Continue：已经在栈上的函数继续执行旧代码；V8停在断点时帧间 Reload 的安全条件也无法推进，必须先Resume，之后的新调用才进入新generation。

只改行为：

```powershell
npm run build:hotfix
# 命令会打印 output=dist/hotfix-candidates/<hash>

# Watcher运行期间，在它的终端输入：
reload dist/hotfix-candidates/<hash>
```

修改字段、类型、协议、Core或`.native`：

```powershell
npm run build
cargo build --bin TiangZ
# 部署完整Model/Hotfix配对并重启Process
```

普通业务开发者只需记住：状态写在Model，行为写在Hotfix System；System没有字段和构造；公开方法签名变化会改变生成的Model声明，因此必须完整构建并重启。`build:hotfix`拒绝时不要绕过，它是在告诉你这次变更已经越过纯行为边界。

正式服发布只传输`dist/hotfix-candidates/<hash>`完整目录。候选必须先上传到临时目录，完成后原子重命名到目标hash目录；不得逐文件覆盖`dist/hotfix.js`。目标Process需要显式配置`process.lifecycle.hotfixOperations`并通过环境变量提供令牌，然后使用正式入口：

```powershell
npm run hotfix -- plan --startup configs/<env>/StartMachine.json --candidate dist/hotfix-candidates/<hash>
npm run hotfix -- apply --startup configs/<env>/StartMachine.json --candidate dist/hotfix-candidates/<hash>
npm run hotfix -- status --startup configs/<env>/StartMachine.json
npm run hotfix -- rollback --startup configs/<env>/StartMachine.json
```

`plan`先核对候选文件哈希和冻结Model契约，再读取每个目标的当前generation；`apply`支持重复`--target <process>`灰度选择，并在多目标部分失败时回滚本次已经成功的目标；`status`返回active/previous候选和最后操作；`rollback`重新提交previous候选，因此也会生成新的generation。每次命令写入忽略Git的`temp/hotfix-operations/audit.jsonl`，Process日志同步记录operationId，但两处都不记录令牌。管理路由复用健康端口、默认关闭，只接受回环连接和Bearer令牌；它不能经Nginx或公网暴露。

当前CLI协调一台机器本地可达的Process。跨机器部署应先把同一不可变候选分发到每台机器，再在各机执行`--machine`或目标选择；尚未实现跨机器Prepare/Commit，所以不能把多机补偿回滚描述为全局原子事务。

## 最小验收矩阵

- 同步与异步Scene/Session/Unit Handler替换。
- 现存Component实例调用新prototype方法。
- 候选语法错误、绑定冲突和提交异常恢复旧版本。
- protocol/Core API/Native schema/Model指纹不兼容时拒绝。
- 切换期间队列有界、RPC不错配、Message不重复。
- 有连接Process切换后连接不重建、状态不丢失。
- 连续多次切换后Timer、pending operation和V8 Heap保持在门槛内。
- 正式入口的鉴权、plan、apply、status、rollback、错误候选拒绝和Inspector脚本重绑。
