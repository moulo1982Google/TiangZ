# Process级TypeScript热更设计

## 最终边界

TiangZ保持“一Process一V8、多EntryScene”。Process是V8、TS业务线程、部署版本和热更事务的原子边界；EntryScene是业务边界，不拥有独立V8。

服务端TypeScript被明确拆成两部分：

```text
Model Bundle                     Hotfix Bundle
  状态、字段、构造、继承           Handler与领域方法实现
  Scene/Entity/Component身份       @hotfixFor(ModelType)行为补丁
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
- `app/generated/hotfix`：Hotfix Handler与行为补丁注册入口。

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

Hotfix manifest必须逐项匹配这些冻结值。`npm run build:hotfix`只重建Hotfix；只要Model源指纹改变就立即失败，并要求完整构建、部署和Process重启。没有忽略兼容检查的参数。

## 行为补丁

Model中的类型拥有真实实例和状态。Hotfix实现类只提供方法：

```ts
// app/model/demo/login/LoginComponent.ts
export class LoginComponent extends Component {
  protected loginCount = 0;

  Login(account: string): LoginResult {
    throw new Error("Login Hotfix is not installed");
  }
}

// app/hotfix/demo/login/LoginComponentHotfix.ts
@hotfixFor(LoginComponent)
export class LoginComponentHotfix extends LoginComponent {
  override Login(account: string): LoginResult {
    this.loginCount += 1;
    return { account, loginCount: this.loginCount };
  }
}
```

`LoginComponentHotfix`永远不会被实例化。提交时，框架只把它的prototype方法安装到Model的规范prototype上，因此已经存在的Component实例和Rust handle都不重建。

实现类禁止声明：

- 实例字段和字段初始化器；
- 构造函数；
- 静态初始化块；
- 新的继承关系或状态形状。

这些内容属于Model。需要它们时，修改Model并重启Process。

## Handler切换

Scene、Session和Unit的外置Handler保存在身份稳定的绑定槽中。路由不会永久捕获启动时的Handler函数，而是在调用时读取当前槽：

- 新Hotfix可以替换Handler构造器；
- 现有Scene、Session和Unit不重建；
- 提交失败时槽对象恢复旧描述符；
- `rpcId`和RPC多路复用不受generation影响。

方法装饰器形式的Scene内Handler也在每次调用时解析当前方法，因此prototype提交后会进入新实现。

## 加载、提交与回滚

一次候选安装按以下顺序执行：

1. **离线构建**：codegen、typecheck、边界检查和指纹生成通过。
2. **隔离预检**：Rust在没有Process实例的临时V8中加载Model和候选Hotfix，检查语法、入口和无副作用注册。
3. **在线暂存**：当前V8建立staging generation，求值候选Hotfix；装饰器只写暂存区。
4. **切换屏障**：暂停新业务帧进入，并等待Scene入口队列与在途异步任务归零。
5. **原子提交**：同步安装完整prototype方法集与Handler绑定，然后恢复投递。
6. **失败回滚**：任一步异常都恢复旧prototype描述符与旧Handler槽，旧版本继续服务。

第一版选择“排空到零再切换”，不让旧Promise和新Handler长期并存。这会让切换等待正在执行的慢RPC，但显著简化generation、Timer和闭包所有权。以后只有真实指标证明停顿不可接受时，才考虑双generation排空。

## 启动与当前实现状态

Runtime启动时先验证两个manifest和实际文件SHA-256，再进行隔离预检。正式V8只加载一次Model ESM，然后把Hotfix作为独立ESM安装为generation 1，最后才启动Process并开放服务端口。

当前已经完成：

- Model/Hotfix目录与双Bundle；
- Model源码和四类兼容指纹；
- 隔离V8预检；
- staging、prototype/Handler事务提交与失败回滚；
- 现有实例原地获得新方法；
- Hotfix-only构建拒绝Model变化；
- 边界与事务自测。

尚未完成：

- Watcher/管理命令触发运行中Process重新加载候选文件；
- Rust投递屏障与超时策略的生产化接线；
- 有连接、慢RPC、Timer、连续多generation的完整运行时验收；
- 热更阶段、耗时和失败原因的Prometheus/Grafana面板。

因此现在的双Bundle是可靠的热更基础和启动安装机制，但还不能宣传成“覆盖文件即可在线热更”。

## Timer、Update与状态

Model对象和字段在Process生命周期内不变，热更只替换其方法。Timer与Update仍需遵守所有权规则：

- 业务Timer归属于Scene、Entity或Component，owner销毁时自动取消；
- 长期Timer不要保存Hotfix匿名闭包作为不可追踪身份；
- 热更提交前必须等在途业务任务归零；
- 模块级可变状态不属于任何Model对象，禁止用它保存业务状态。

Rust Native Entity是权威状态时同样不迁移schema。`.native`变化意味着Model版本变化，必须重启Process并按持久化协议处理兼容。

## 开发流程

只改行为：

```powershell
npm run build:hotfix
```

修改字段、类型、协议、Core或`.native`：

```powershell
npm run build
cargo build --locked --bin TiangZ
# 部署完整Model/Hotfix配对并重启Process
```

普通业务开发者只需记住：状态写在Model，行为优先写在Hotfix；Hotfix实现类没有字段和构造；`build:hotfix`拒绝时不要绕过，它是在告诉你这次变更必须重启。

## 最小验收矩阵

- 同步与异步Scene/Session/Unit Handler替换。
- 现存Component实例调用新prototype方法。
- 候选语法错误、绑定冲突和提交异常恢复旧版本。
- protocol/Core API/Native schema/Model指纹不兼容时拒绝。
- 切换期间队列有界、RPC不错配、Message不重复。
- 有连接Process切换后连接不重建、状态不丢失。
- 连续多次切换后Timer、pending operation和V8 Heap保持在门槛内。
