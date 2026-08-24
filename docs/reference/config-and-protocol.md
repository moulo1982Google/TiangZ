# 配置与协议参考

本页的`RuntimeConfig`描述机器、Process、Scene、端口和运行参数。策划维护的道具、地图、玩家基础数值位于`game_config/`，由Luban生成，不能写进Runtime JSON。完整流程见[游戏配置教程](../tutorials/10-game-config.md)。

## RuntimeConfig

| 字段 | 类型 | 含义 |
|---|---|---|
| `process` | `ProcessConfig` | 当前 OS 进程/V8 |
| `scenes` | `SceneConfig[]` | 当前进程实际启动的入口 Scene，至少一个 |
| `knownScenes` | `SceneConfig[]` | 路由目录；省略或为空时默认等于 `scenes` |
| `knownSceneFiles` | `string[]` | 相对当前配置文件的共享稳定路由目录；Rust启动时合并并校验冲突 |

Runtime配置使用严格字段校验。根对象、`process`和各嵌套配置出现未知字段时会拒绝启动，因此`hotfixReloadTimoutMs`一类拼写错误不会静默退回默认值。TS业务看到的`ProcessConfig`只是宿主投影；完整JSON契约以本页、配置Schema和`src/config.rs`为准。

## ProcessConfig

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | string | Process 唯一名称，也作为 ProcessHost ID |
| `identity` | object? | 全局持久ID来源身份；包含`originServerId`和`workerId` |
| `logging` | object? | 日志级别、格式和输出目标；默认 INFO 文本控制台 |
| `network` | object? | 操作系统 I/O Backend；默认 `epoll`，Linux 可实验性选择 `io-uring` |
| `game` | object? | 固定 Game.Update 与掉帧补偿策略，默认 20Hz |
| `scheduling` | object? | Process 事件批处理与空闲 Tick 策略，默认 `adaptive` |
| `lifecycle` | object? | 进程优雅停机配置；默认最多等待 10000ms |
| `persistence` | object? | Process持久化连接；当前可选配置独立DBProxy |
| `observability` | object? | 延迟采样、健康检查、分布式追踪和Native Store诊断配置 |
| `debug` | object? | 该 V8 的 Inspector 配置 |

`debug` 支持 `inspectorIp`、`inspectorPort`、`breakOnStart`、`allowRemote`。

`persistence.dbProxy`显式启用独立DBProxy：

```json
{
  "persistence": {
    "dbProxy": {
      "endpoint": "127.0.0.1:7800",
      "failoverEndpoints": ["127.0.0.1:7801"],
      "authTokenEnv": "TIANGZ_DBPROXY_AUTH_TOKEN",
      "clientPoolSize": 4,
      "connectTimeoutMs": 5000,
      "requestTimeoutMs": 5000,
      "maxFrameBytes": 8388608
    }
  }
}
```

- `endpoint`：DBProxy内网TCP地址，不应填写客户端公网地址。
- `failoverEndpoints`：可选的有序备用内网地址；首地址仍由`endpoint`指定。网络不可用时Rust客户端按顺序切换，并保留原`requestId/operationId`重试；业务拒绝、Revision冲突、鉴权失败和协议不匹配不会换节点。旧配置也兼容别名`endpoints`，新配置统一使用`failoverEndpoints`。
- `authTokenEnv`：保存令牌的环境变量名；JSON中禁止填写令牌值，默认`TIANGZ_DBPROXY_AUTH_TOKEN`。
- `clientPoolSize`：当前Process的Rust连接池大小，范围1到64。
- `connectTimeoutMs/requestTimeoutMs`：连接和单RPC超时，范围100到120000毫秒。
- `maxFrameBytes`：协议帧上限，范围1 KiB到64 MiB，必须与DBProxy一致。

省略该配置时，Demo使用内存Repository并保持日常开发无数据库依赖。该配置不可热更；启用后缺少令牌、握手失败或连接失败都会明确阻止持久化调用，不会静默回退到内存。完整运行和恢复流程见[DBProxy玩家快照持久化](../tutorials/19-dbproxy-player-persistence.md)。

`identity.originServerId`范围为1到16383，表示永久来源服；上线后不得修改或复用。`identity.workerId`范围为0到127，表示同一来源服内生成持久ID的Process。Watcher会加载整套`StartMachine`并拒绝重复组合；直接启动单进程配置时由运维保证唯一。详细布局见[运行时基础能力](../design/runtime-foundations.md)。

`observability.health` 可选配置独立的进程健康检查端点：

```json
{
  "observability": {
    "health": {
      "ip": "127.0.0.1",
      "port": 7600,
      "staleAfterMs": 15000
    }
  }
}
```

- `GET /live`：V8 业务线程仍存活时返回 HTTP 200；线程退出后返回 503。
- `GET /ready`：全部业务端点绑定成功、全部 TS Scene 完成 `onStart/onReady`，并且 V8 Runtime 心跳未超过 `staleAfterMs` 时返回 HTTP 200；启动中、停机中、Runtime 退出或业务线程停止推进时返回 503。
- 未配置 `health` 时不启动 HTTP 监听。每个拆分进程应配置不同端口，健康端口不得与该进程的 Scene 或 Inspector 端口冲突。

`staleAfterMs` 默认 `15000`，应至少覆盖两个 5 秒指标采样周期。单机 Docker Desktop 可以继续绑定 `127.0.0.1`；远程 Prometheus 抓取时必须绑定机器管理 IP 或 `0.0.0.0`，并通过防火墙只允许监控网段访问。`StartMachine.json` 写远程 `innerIp` 但 Process 仍绑定 loopback 时，Target 生成器会拒绝生成错误配置。

健康检查继续表达生命周期状态；`/metrics` 提供基础生命周期指标，不承载业务级依赖状态，也不能代替业务级健康策略。

`observability.tracing`可选配置跨Process Trace导出：

```json
{
  "observability": {
    "tracing": {
      "enabled": true,
      "sampleRate": 10,
      "otlpEndpoint": "http://127.0.0.1:4318/v1/traces"
    }
  }
}
```

`sampleRate`表示每N条根链路采样一条Span，范围为1到1000000；默认100。`otlpEndpoint`必须是完整的HTTP或HTTPS OTLP trace路径。该配置不可热更；Core通过内部Trace Envelope传播上下文，不改变业务Protobuf与客户端SDK。完整观测栈和验收方式见[可观测性与链路耗时](observability.md)。

正式Hotfix操作入口通过生命周期配置显式启用：

```json
{
  "lifecycle": {
    "hotfixReloadTimeoutMs": 30000,
    "hotfixOperations": {
      "authTokenEnv": "TIANGZ_HOTFIX_ADMIN_TOKEN"
    }
  }
}
```

启用后必须同时配置`observability.health`，并在Process环境中提供非空令牌；缺少令牌会阻止启动。管理路由为`GET /admin/hotfix/status`、`POST /admin/hotfix/apply`和`POST /admin/hotfix/rollback`，只接受回环来源与Bearer令牌。健康端口仍可按监控需要绑定管理地址或通配地址，但Hotfix管理请求不能从远端进入；运维应登录目标机器运行`npm run hotfix`，不得把这些路由交给Nginx或公网负载均衡。

`logging` 支持：

```json
{
  "level": "info",
  "format": "json",
  "console": true,
  "filter": "TiangZ=info,tokio=warn",
  "file": {
    "enabled": true,
    "directory": "logs",
    "rotation": "daily"
  }
}
```

- `level`：`trace/debug/info/warn/error`，默认 `info`。
- `format`：开发使用 `pretty`，生产建议使用一行一个事件的 `json`。
- `console`：是否输出到 stdout，默认开启。
- `filter`：可选的 `tracing-subscriber` 过滤表达式；环境变量 `RUST_LOG` 的优先级更高。若配置为 `debug` 却看不到 INFO/DEBUG，请先检查操作系统是否预设了 `RUST_LOG=warn` 等覆盖值。
- `file`：可选的非阻塞滚动文件输出；相对目录以工程根目录为基准，轮转支持 `hourly/daily/never`。

控制台和文件都使用有界非阻塞队列。队列耗尽时普通日志允许丢弃，保护网络和游戏线程；因此普通 Logger 不能用于充值、货币、道具发放等可靠审计记录。

当 `level`、`filter` 或 `RUST_LOG` 是单一日志级别时，Runtime 会把最低级别同步给 V8，TS 在字段合并和序列化之前直接过滤。复杂 target filter 无法用单个级别精确表达，TS 会保守放行，再由 Rust `tracing` 完成最终过滤。

`network` 支持 `ioBackend`、`uringEntries` 和 `uringReadBufferBytes`。`ioBackend` 只决定 epoll/io_uring，不决定 TCP/WebSocket。io_uring 的约束、构建方法和性能验收见 [传输与 I/O 分层](transport-backend.md)。

`game` 支持：

```json
{
  "fixedUpdateMs": 50,
  "maxCatchUpSteps": 2
}
```

- `fixedUpdateMs`：业务 `Game.Update` 固定间隔，默认 50ms，即 20Hz；范围为 1 到 10000ms。
- `maxCatchUpSteps`：Process 短暂停顿后单次 Pump 最多补跑多少帧，默认 2，范围为 1 到 100。超出的旧帧会计入 `skippedFixedUpdates`，不会形成死亡螺旋。

`lifecycle.stopTimeoutMs` 控制 TS `onStop`、玩家保存等停机工作的最长等待时间，默认 `10000`，允许范围为 `100` 到 `120000`。超时会让进程以错误退出，不能静默假装保存成功。

`lifecycle.hotfixReloadTimeoutMs`控制Reload等待Scene入口和异步Handler排空的最长时间，默认`30000`，范围同样为`100`到`120000`。超时只拒绝候选并保留旧generation，不会关闭Process或断开客户端。

`lifecycle.restart`是仅由Watcher消费的可选监管策略。省略时子进程退出会触发整组失败收束；配置`maxAttempts/windowMs/backoffMs`后，Watcher只在预算内重启该进程，预算耗尽仍关闭整组。自动重启不是数据恢复开关：只有具备持久化、所有权代次和路由恢复契约的进程才应启用。

`observability.nativeData` 只控制 Rust 权威实体数据的诊断输出：

```json
{
  "observability": {
    "nativeData": {
      "debugScalarAccess": true,
      "scalarAccessWarnThreshold": 10000
    }
  }
}
```

- `debugScalarAccess`：采样窗口内标量 Get/Set 达到阈值时输出警告。
- `scalarAccessWarnThreshold`：标量访问日志提醒阈值，必须大于 0；仅在开启 `debugScalarAccess` 时观测，不会限流或阻止 fast op。

Rust Core使用强类型`NativeDataObservabilityConfig`负责字段默认值、未知字段拒绝和阈值校验，再把只读配置投影交给TS记录告警。旧的根级`process.nativeData`会被明确拒绝，不能与新路径并存。Unit 始终存放在 Rust Arena，Handler、Actor mailbox、Audience 决策和业务 Component 组合仍留在 TS。

`scheduling` 支持：

```json
{
  "mode": "adaptive",
  "idleTickMs": 50,
  "maxEventsPerUpdate": 512,
  "coalesceMicros": 250,
  "eventQueueCapacity": 4096
}
```

- `mode`：`low-latency`、`throughput` 或 `adaptive`。
- `idleTickMs`：没有网络事件时 Runtime Pump 的最长等待时间，必须大于 0。Rust 实际等待取它与 `fixedUpdateMs` 的较小值，保证固定帧和游戏定时器不会被饿住。
- `maxEventsPerUpdate`：单次注入 V8 的事件上限，范围为 1 到 4096。
- `coalesceMicros`：高负载下允许的微秒级聚合窗口，最大 10000；低延迟模式默认 0。
- `eventQueueCapacity`：Rust 到单 V8 业务线程的有界事件队列容量，默认 4096，允许 64 到 65536。生产环境通常保留默认值；小容量主要用于确定性背压验收，增大它只能吸收突发，不能解决消费者长期慢于生产者的问题。

这些字段都可省略并使用模式默认值。TS仍有入站积压时，Rust暂缓注入新的data批次，并把每轮control注入限制为128条，为TS保留排空旧队列的能力；新事件继续停留在有界`eventQueueCapacity`中接受背压，而不是在V8里无限积压。生产配置应按同一业务负载比较固定Tick、吞吐和p95/p99后再覆盖默认值。

## SceneConfig

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | string | Scene 实例唯一名 |
| `sceneType` | string | `@entryScene()` 注册类型 |
| `innerIp` | string | 服务间通信地址；旧配置的 `ip` 仍可读取，但新配置应使用 `innerIp` |
| `bindIp` | string? | 本机监听地址；省略时使用 `innerIp`。外网由 Nginx 代理时填写 `127.0.0.1`；只有服务直接暴露公网端口时才考虑 `0.0.0.0` |
| `outerIp` | string? | 客户端连接地址；LoginMgr/Login/Gate 返回该地址，省略时使用 `innerIp` |
| `outerPort` | u16? | 客户端连接端口；省略时使用 `port`。Nginx 或云 NAT 场景下通常与 `port` 不同 |
| `port` | u16 | TiangZ 实际监听及内网通信端口；可以和 `outerPort` 不同 |
| `protocol` | `auto`、`tcp`、`websocket`、`kcp`? | Endpoint 传输协议；默认 `auto`，KCP 需使用 `--features kcp` 构建 |
| `audience` | `mixed`、`inner`、`outer`? | Endpoint 面向的连接类型；默认 `mixed`，KCP 必须显式选择 `inner` 或 `outer` |
| `staticMapIds` | `u32[]`? | 仅MapHost使用；启动时通过统一CreateMap创建的静态地图配置ID |
| `acceptDynamicMaps` | bool? | 仅MapHost使用；是否注册到MapManager并接受动态实例，默认false |

同一进程内 Scene name 和 endpoint 必须唯一。Inspector 和健康检查端口都不能与任何 Scene 端口冲突。

监听地址、服务间地址和客户端地址是三个不同概念，不能把 `0.0.0.0` 写入 `knownScenes`、MapHost Endpoint 或登录响应。云服务器的公网 IP 通常是云厂商的 EIP/NAT，不会出现在虚机的 `ip addr` 中，因此必须通过部署配置显式填写，不要在 Runtime 中自动猜测公网 IP。

外网演示的登录链路如下：

```text
前端写死 LoginMgr 公网 IP:port
  -> LoginMgr.GetLoginServiceAddr()
     -> 返回 Login 配置中的 outerIp/outerPort
  -> Login.Login()
     -> 返回 Gate 配置中的 outerIp/outerPort
  -> Gate / MapHost
```

云服务器配置示例：

```json
{
  "scenes": [
    {
      "name": "login_1",
      "sceneType": "Login",
      "innerIp": "192.0.2.5",
      "bindIp": "0.0.0.0",
      "outerIp": "203.0.113.10",
      "port": 7001,
      "outerPort": 7001,
      "audience": "mixed"
    },
    {
      "name": "gate_1",
      "sceneType": "Gate",
      "innerIp": "192.0.2.5",
      "bindIp": "0.0.0.0",
      "outerIp": "203.0.113.10",
      "port": 7201,
      "outerPort": 7201,
      "audience": "mixed"
    }
  ]
}
```

`knownScenes` 中登记 `innerIp`，用于 Login、Gate、Location、MapHost 等服务间调用；`outerIp/outerPort` 需要同时出现在 LoginMgr 能看到的 Login 路由和 Login 能看到的 Gate 路由中。若公网端口经过映射，使用 `outerPort`，内网 `port` 保持服务实际监听端口。

`staticMapIds`只写在实际启动该MapHost的`scenes`条目，`knownScenes`中的路由副本不重复填写。静态地图实例号等于配置号；动态副本不进入Runtime JSON。部署一个单例`MapManager` Scene，并把它加入各MapHost的`knownScenes`；MapHost会主动注册，MapManager不需要在配置中预先列出MapHost。当前本地配置让`MapManager`与`LoginMgr`共享`mgr` Process，但两者是独立EntryScene，后续可直接拆Process。

进程配置可使用`knownSceneFiles`引用一个或多个共享目录，路径相对当前进程配置文件解析：

```json
{
  "knownSceneFiles": ["known-scenes.json"],
  "knownScenes": []
}
```

共享文件格式为`{"knownScenes": [...]}`。启动器按“本进程scenes、共享文件、本地knownScenes追加项”合并；同名同内网路由自动去重，缺失的`outerIp/outerPort`会从另一份描述补齐，双方都填写但不一致时拒绝启动；同名异路由或同内网地址异名直接拒绝启动。该机制只减少稳定启动目录的复制，不提供运行期服务发现。动态MapHost由MapManager注册并通过Location Endpoint路由，不应写入共享文件。

`auto` 用于当前同一端口兼容内部 TCP 和浏览器 WebSocket。只接受 Native/内部连接的 Scene 可以显式使用 `tcp`；只接受浏览器连接且不会承接内部 TCP 的 Endpoint 才能显式使用 `websocket`。未来支持一个 Scene 配置多个 Endpoint 后，Gate 才能分别显式暴露 Native TCP、WebSocket 和 KCP 端口，并取消生产配置对协议探测的依赖。

`audience` 与 `protocol` 是不同概念：前者决定这是服务器内网连接还是客户端外网连接，后者决定使用 TCP、WebSocket 还是 KCP。现有 TCP `mixed` Endpoint 在握手后仍会得到连接级 `ConnectionKind::Internal/External`；KCP 参数必须在会话创建时确定，因此不允许使用 `mixed`。当前 KCP 仅开放 `outer`，`inner` 会在配置校验阶段明确报错。

旧字段 `network.backend`、`scene.transport` 以及旧值 `raw` 暂时仍可读取，分别映射到 `ioBackend`、`protocol` 和 `tcp`。序列化与新文档只使用新名称。

## StartMachine

`machines[].innerIp` 匹配本机地址，`machines[].processes` 列出要启动的进程配置。每个配置文件仍只创建一个 Process/V8。

Watcher在启动子进程前读取所有机器引用的Process配置，并全局检查`process.identity`冲突。即使远端机器不由当前Watcher启动，它的配置也必须存在且可读取，避免跨机器复用ID生成槽位。

## 网络帧

```text
[length: u32 BE][msgcode: u16 BE][protobuf payload]
```

`length` 不进入 TS。RPC 的 `rpcId/error/message` 属于 protobuf payload，不是公共帧头。普通 Message 不要求 `rpcId`。

Outer TCP/WebSocket 只允许客户端消息号；Inner TCP 握手后只允许内部消息号。当前 Demo 的消息号范围由 proto 文件名起始 ID 和定义顺序生成。

## 业务代码扫描

`codegen.config.json`的`serverBundles.sceneSearchRoots`控制Model EntryScene扫描根目录，`handlerSearchRoots`控制Hotfix Handler，`patchSearchRoots`控制`@systemFor`业务System与兼容期`@hotfixFor`补丁。默认分别是`app/model`与`app/hotfix`；增加平级游戏时，把两层对应根目录加入数组即可，不登记Scene、Handler、System或补丁总表。
