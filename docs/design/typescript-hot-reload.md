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
- demo或bench构建模式。

Hotfix manifest必须逐项匹配这些冻结值。`npm run build:hotfix`只重建Hotfix；只要Model源指纹改变就立即失败，并要求完整构建、部署和Process重启。没有忽略兼容检查的参数。Hotfix-only构建不会覆盖正在服务的`dist/hotfix.js`，而是输出`dist/hotfix-candidates/<内容哈希>/hotfix.js`与manifest，避免Runtime读到写了一半的候选。

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

Handler实例可能在一个Scene内被复用，Event Handler还可能被多个Scene复用。因此所有`@messageHandler/@rpcHandler`、Session/Unit Handler和同步/Veto Event Handler类都必须无实例字段、无构造函数、无静态初始化块和可变静态成员。状态归属于Scene、Session、Unit或Component；`verify:hotfix-boundary`通过TypeScript符号解析识别直接名、import别名与namespace写法，不能用重命名导入绕过约束。

方法装饰器形式的Scene内Handler也在每次调用时解析当前方法，因此prototype提交后会进入新实现。

## 加载、提交与回滚

一次候选安装按以下顺序执行：

1. **离线构建**：codegen、typecheck、边界检查和指纹生成通过。
2. **切换屏障**：Process停止从Rust业务队列取新帧，并等待Scene入口队列与在途异步任务归零；网络线程仍可写入有界队列。
3. **隔离预检**：Rust在没有Process实例的临时V8中加载Model和候选Hotfix，检查语法、入口和无副作用注册。
4. **在线暂存**：当前V8建立staging generation，求值候选Hotfix；装饰器只写暂存区。
5. **原子提交**：同步安装完整prototype方法集与Handler绑定，然后恢复投递。
6. **失败回滚**：任一步异常都恢复旧prototype描述符与旧Handler槽，旧版本继续服务。

第一版选择“排空到零再切换”，不让旧Promise和新Handler长期并存。这会让切换等待正在执行的慢RPC，但显著简化generation、Timer和闭包所有权。`lifecycle.hotfixReloadTimeoutMs`默认30秒；超时只拒绝候选，不关闭Process。当前隔离预检也位于停止取新业务帧的窗口内，后续由性能测试决定是否值得迁到独立工作线程。以后只有真实指标证明停顿不可接受时，才考虑双generation排空。

## 启动与当前实现状态

Runtime启动时先验证两个manifest和实际文件SHA-256，再进行隔离预检。正式V8只加载一次Model ESM，并通过不可写全局桥提供`#tiangz/model`稳定导出；Hotfix是完整IIFE脚本，以固定脚本名求值并安装generation 1，最后才启动Process并开放服务端口。Hotfix不进入ESM ModuleMap，也不为每代生成新的脚本URL。

当前已经完成：

- Model/Hotfix目录与双Bundle；
- Model源码和四类兼容指纹；
- 隔离V8预检；
- staging、prototype/Handler事务提交与失败回滚；
- 现有实例原地获得新方法；
- Hotfix-only构建拒绝Model变化；
- Watcher通过跨平台stdin控制协议广播`reload <候选目录>`；
- Process独立复核候选，在安全屏障提交，超时或失败保留旧generation；
- `/metrics`发布active generation、成功/失败次数及validation/preflight/barrier/eval/commit/total耗时；
- 5个拆分Process连续切换100次至generation 101并拒绝损坏候选的运行时自测；
- 现有PlayerUnit在不改变InstanceId和Native handle时获得上下反转Move实现；
- 8秒慢异步RPC使Reload屏障等待约7.7秒，完成后正常提交且RPC没有错配；
- Component/Actor一次性与重复Timer只保存owner和方法名，现有Timer切换后调用新prototype；
- 100代资源测试先预热10代，再测量后90代：Timer、Native实体和pending均无漂移，5个Process的V8 Heap/RSS增长通过4MB/16MB硬门槛；
- 边界与事务自测。

3000玩家基线与1Hz Reload A/B已经完成，90/90次切换成功且Move吞吐无可见下降，但Probe尾延迟约增加三成。慢RPC、Timer与连续100 generation专项验收也已完成。Reload仍然不能直接覆盖`dist/hotfix.js`；必须构建不可变候选目录并通过Watcher命令提交。进入Phase 4前只剩`0.3.10` Release候选全矩阵与正式发布流程，不再增加热更语义。

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

开发宿主先执行一次完整构建并启动Watcher，之后监听`app/hotfix/**/*.ts`以及`game_config`的Excel/定义源。Hotfix保存会串行执行入口生成、类型检查、不可变候选构建和Watcher `reload`；纯配置数据变化会构建独立数据候选并执行`reload-config`。连续保存会合并，构建失败时不发送切换命令，旧generation或旧配置快照继续运行。它不监听Model、Core、Proto或`.native`；配置表结构变化也会被schema门拒绝，这些边界变化仍要求开发人员停止、完整构建并重新启动。源码模式只是隐藏构建步骤，不会让V8直接执行TypeScript，也不得用于正式部署。

需要边调试边Reload时使用：

```powershell
npm run dev:debug
# 默认启动 configs/local/debug/StartMachine.json，并连接 all-in-one 的 9231 Inspector
```

Debug模式让初始Model/Hotfix和后续每个Hotfix候选都携带内联sourcemap与`sourcesContent`。Process和V8不重启，VS Code保持同一Inspector连接；候选求值时发布新的`scriptParsed`，原TS源码断点会重新绑定到新脚本。它不是Edit-and-Continue：已经在栈上的函数继续执行旧代码；V8停在断点时Reload屏障也无法推进，必须先Resume，之后的新调用才进入新generation。

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
