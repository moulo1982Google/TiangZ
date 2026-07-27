# 运行时维护者指南

## 核心不变量

1. 一个 OS Process 只有一个 V8、一个 TS 全局空间和一个 TS 业务线程。
2. 一个 Process 可以承载多个可寻址 EntryScene。
3. EntryScene 是业务边界，Process 是部署和故障边界。
4. 同进程与跨进程调用使用相同协议、rpcId、错误和 mailbox 语义。
5. Rust 热路径不引入 base64 或逐帧 JSON。

## Rust 启动链

`src/main.rs` 读取单进程配置或进入 Watcher。`src/config.rs` 校验 Process、Scene 名称、endpoint 和 Inspector。`src/process.rs`：

1. 为每个配置 Scene 绑定 Listener。
2. 创建一个有界 ProcessEvent queue 和共享 writer map。
3. 创建一个 current-thread Tokio runtime 与一个 V8。
4. 把 `process/scenes/knownScenes` 交给 `__etsStartProcess`。
5. Listener frame、连接断开和内部 RPC completion 统一进入有界 ProcessEvent queue，并打成一个连续二进制包送入 TS。completion 本身就是唤醒事件，不允许再维护第二条 completion queue 或独立 Wake 标记。

连接 ID 在 Process 内全局分配，因为多个 Listener 共享 writer map。

应用脚本加载后，Rust 会缓存 `__etsStartProcess`、`__etsPushHostEventsBinary` 和 `__etsUpdateBinary` 的 V8 Function 句柄。热路径必须直接调用缓存句柄，禁止每个 update 通过 `execute_script` 动态生成调用脚本。

入站事件批包使用小端整数：

```text
[eventCount:u32]
  repeated [eventType:u8][id:u32][sceneIndex:u32][payloadLen:u32][payload]
```

一个批包只跨一次 Host Op。TS 使用 `subarray` 读取各 payload，不再为每个 frame 调用一次 `__hostTakeBinaryArg`。

## TS 启动链

`app/main.ts` 暴露 `__etsStartProcess`、`__etsPushHostEventsBinary`、`__etsUpdateBinary`。`ProcessRuntime` 创建共享 `ProcessHost` 和多个 EntryScene，并按 sceneIndex 路由外部帧。

EntryScene 保有独立协议 Registry、mailbox、ingress、outbound 和 metrics；动态 Scene/Actor 共用 ProcessHost。子 Scene ID 必须使用入口 Scene 命名空间。

EntryScene 同样是 Component 容器。入口 Scene class 负责声明业务边界、mailbox 和组件装配；所有业务组件统一继承 `Component`；独立 Handler class 负责协议适配，并可通过 `scene.GetComponent(...)` 协调多个组件。Handler 拆文件不创建新 mailbox，也不改变调度线程。

禁止重新引入 `EntrySceneComponent/SceneComponent/ActorComponent` 这种按宿主类型拆分的业务基类。组件属于谁由 `AddComponent` 的调用位置决定。也不要添加只调用另一个对象同名方法的 Sink、Delegate、EventComponent 或 Adapter；业务行为应落在真正拥有状态和规则的 Entity/Component 上。

`ProcessHost.Root` 维护进程级 `InstanceId -> Entity` 索引。动态 Scene/Actor 创建后注册，销毁前移除。ActorRef 必须同时校验 sceneId、业务 actorId 和 InstanceId，禁止只凭可复用业务 ID 调度旧引用。

地图实体统一使用 `Unit`，连接统一使用`Session`。二者在Core内部复用mailbox实体实现，但泛化`Actor`不是Stable业务基类。MapScene的UnitComponent是UnitId业务集合；SessionComponent是connectionId集合；Root是InstanceId生命周期集合，三者职责不能混用。

## 批量下行 Bridge

`sendClient` 和 `sendClientMany` 都进入 `OutboundBatch`。群发只编码一次协议帧；`app/main.ts` 在每次 update 结束时把当帧全部批次打成一个紧凑二进制包，通过一次 `__hostPushOutboundPacked` 交给 Rust。禁止重新展开成逐连接或逐批次 Host Op。

批包格式固定为小端整数：

```text
[batchCount:u32]
  repeated [targetCount:u32][targetIds:u32...][frameLen:u32][frame]
```

Rust 把整个 V8 批包复制为一次 `Bytes`，各批次 frame 使用 `Bytes::slice` 共享同一块 backing storage，向各连接 writer 投递时继续使用引用计数克隆。每个客户端的帧数、逻辑字节、队列上限和慢连接断开仍独立计算；共享物理内存不能改变背压语义。同一批次和不同批次按产生顺序入队，必须保持单连接消息顺序。

Raw TCP writer 每次最多聚合 64 帧或 256KB，使用 `write_vectored` 直接发送 length-prefix 与共享 `Bytes`，不重新拼接大 `Vec`。WebSocket writer 使用多次 `feed` 加一次 `flush`。这两条路径都必须在写完后按逻辑帧字节扣减连接队列水位。

进程指标区分 `outbound_batches`、`outbound_recipients`、`outbound_bridge_bytes` 和 `outbound_logical_bytes`。全地图广播中 recipients 可以是 batches 的数十倍，这是预期扇出，不应被当作漏发。

## 本地与远程 RPC

`SceneCallContext` 先询问 LocalSceneRouter：

- 本地 call：直接进入目标 EntryScene mailbox，等待目标响应。
- 本地 send：投递目标 mailbox 后立即返回，不等待 Handler。
- 远程：进入 `HostSceneTransport`，由每次 update 的一次 packed Host Op 提交给 `src/transport.rs`。

远程连接按来源 Scene/目标地址复用。多个 pending RPC 共享 TCP，由 protobuf payload rpcId 唤醒各自 oneshot；缺失响应不会阻塞其他 rpcId。

内部操作批包格式为：

```text
[operationCount:u32]
  repeated [operationId:u32][routeId:u32][kind:u8][timeoutMs:u32][frameLen:u32][frame]
```

Rust 对整包只复制一次，各 operation frame 使用 `Bytes::slice`。每个批包只创建一个 Tokio 调度任务，批内最多并行推进 256 个操作；内部 TCP writer 同样使用 vectored write。RPC call 与 timer 会产生 completion，单向 Message send 提交后立即返回，发送失败只进入 Rust 日志和 transport 指标，禁止为每条 Message 回送“发送成功” completion。

Gate 转发 ActorLocation RPC 时使用 Core 原始帧路径：只扫描并替换 protobuf 顶层 `rpcId`，以进程内唯一 rpcId 完成内部多路复用，响应返回时再恢复客户端 rpcId。该路径禁止把业务请求完整 decode 成对象后再 encode；同时必须保留 response msgcode 和内部 rpcId 校验。

ActorLocation 外层不是 protobuf，固定为：

```text
[msgcode:u16 BE][instanceId:u64 LE][rpcId:u32 LE][inner frame]
```

`rpcId=0` 表示单向 Message。业务 `rpcId` 仍属于内层 protobuf Request/Response；外层 rpcId 只供 Rust transport 在不解析业务 payload 的情况下完成多路复用。

不要让本地调用绕过 mailbox，也不要把本地调用送回 Rust queue 后等待同一个 V8，那会自锁。

## Mailbox 调度

EntryScene 和 Actor mailbox scheduler 都保留同步快路径。ordered Handler 返回 Promise 后保持 busy，后续任务排队；同步 Actor Handler 在 mailbox 空闲时直接返回，不强制创建 Promise；unordered 直接启动。单向 send 不向发送方等待。

方法级`@rpc/@message`与class级`@rpcHandler/@messageHandler`注册到Scene ProtocolRegistry。`@sessionRpcHandler/@sessionMessageHandler`先按connectionId取得Session，再进入Session MailBoxComponent。`@unitRpcHandler/@unitMessageHandler`注册到内部ActorLocation ProtocolRegistry，先由Root按InstanceId定位Unit，再进入Unit MailBoxComponent。业务API不暴露泛化Actor Handler。

动态 Scene/Actor mailbox 位于 `app/core/runtime`。修改任一层时必须运行 mailbox parity 测试。

## Process 调度模式

运行时有两种节奏，不能合并成一个模糊的 Tick：

1. **Runtime Pump**：网络 frame、Inner completion 到达就立即唤醒；空闲时由 Rust 超时唤醒。它负责降低消息延迟和推进 Promise。
2. **Game.Update**：由 `process.game.fixedUpdateMs` 控制的固定业务帧，默认 50ms/20Hz。实现 `IUpdate` 的 Component 只在这里执行。

单次 TS Pump 顺序固定为：更新时间并触发到期 Timer -> 处理 EntryScene mailbox -> 补跑有限个固定 Game.Update -> 汇总 outbound。这样网络消息不必等待下一固定帧，而 Game.Update 产生的下行也能在当前 Pump 发出。

`TimerSystem` 使用单调时间和最小堆。重复定时器遇到长暂停只执行一次并推进到下一未来时间；`Game` 只补跑 `maxCatchUpSteps` 帧，其他帧计入 skipped 指标。两者都禁止无上限追帧。

Actor/Actor Component 的定时器必须通过 `ProcessHost.runActorMailbox` 调度，并在 InstanceId 生命周期结束时取消。Scene/普通 Component 的定时回调直接运行，因此异步回调可能与下一次触发重叠；需要实体串行不重入时应把状态放到 Actor 上。

`process.scheduling.mode` 支持：

- `low-latency`：默认每批最多 64 个事件，不主动聚合，适合低流量且强调单条延迟的入口。
- `throughput`：默认每批最多 1024 个事件，并允许 1000 微秒聚合窗口，适合离线任务或明确追求吞吐的进程。
- `adaptive`：默认模式；低队列最多 64 个事件，高队列最多 512 个事件，队列已有压力时最多用 250 微秒 `yield` 聚合。这里不能使用 Windows 亚毫秒 `sleep/recv_timeout`，实测会被放大到约 15ms。

`idleTickMs`、`maxEventsPerUpdate`、`coalesceMicros` 可以覆盖模式默认值。空闲等待会被 `fixedUpdateMs` 限制上界。聚合使用 `thread::yield_now`，只在 adaptive 队列已有至少 8 个事件时启用；不要用忙等替换，也不要在没有同口径 p95/p99 数据时提高默认窗口。

## 背压

- Process Rust 入站队列：4096 事件，所有 Scene 共享。
- 每连接出站：帧数与字节数双限制。
- 批量下行共享帧内存，但每个目标连接仍按完整帧长增加逻辑排队字节。
- Inner transport：全局和每目标连接都有界队列。
- 慢客户端只关闭自身。

TS metrics 按 EntryScene 输出，Rust queue/transport metrics 按 Process 输出。

Scene metrics 只在 5 秒日志采样点创建并 JSON 序列化；普通 update 只返回单字符 pending 状态。禁止恢复每 tick `JSON.stringify(metrics)` 和 Rust `serde_json` 解析。

`[process-metrics]` 同时输出 `inbound_frames`、`host_completions`、`disconnects`、`runtime_updates`、`runtime_events` 和 `max_runtime_batch`。排查桥接停滞时，先比较 Rust 已收 frame、已注入 runtime event 和 TS `processed` 三个累计值，不要只看 CPU。

`[game-metrics]` 输出固定帧间隔、累计帧数、跳帧数、Update 组件数/调用数/失败数和存活 Timer 数。`skipped_fixed_updates` 持续增长说明单线程业务帧无法按配置频率完成，需要看 CPU Profile 或降低 Tick 频率。

## 代码生成与双Bundle

`tools/codegen_proto.mjs`负责协议模型和TS输出。`tools/codegen_scenes.mjs`分别扫描Model Scene、Hotfix Handler与`@systemFor`业务System，生成：

- `app/generated/bootstrap/scenes.ts`：Model启动注册入口；
- `app/generated/hotfix/handlers.ts`：正式Hotfix Handler入口；
- `app/generated/hotfix/patches.ts`：正式Hotfix行为补丁入口；
- `app/generated/bootstrap/systems/*.d.ts`：System公开方法合并到Model类型的声明；
- `app/generated/hotfix/handlers.bench.ts`：Bench专用Handler入口。

`tools/build_runtime_bundles.mjs`把两层构建为`dist/model.js`与`dist/hotfix.js`，并写入各自manifest。Model ESM由Rust正式V8加载一次，并以只读全局桥暴露`app/model/public.ts`；Hotfix构建为IIFE脚本，经固定脚本名重复求值，不进入ESM ModuleMap。`--hotfix-only`必须复用现有Model manifest，并在Model源码指纹变化时失败。不得恢复执行`dist/main.js`、为每代脚本制造新URL，或把两层重新合并。

Model启动后没有重载入口。Hotfix安装由Rust先验证实际SHA-256和四类兼容指纹，再在隔离V8预检，最后通过`HotfixSystem`暂存和提交。生产在线触发完成前，维护脚本不得通过覆盖文件并重复执行模块来模拟热更。

## Inspector

`src/inspector.rs` 为 Process 创建一个 InspectorServer。`debug` 属于 Process；debug build 使用内联 sourcemap。`tests/inspector_debug.rs` 验证发现、连接、启动暂停和映射。

## 必跑验证

```powershell
npm run check
npm run test:scene-handler
cargo test --all-targets
npm run test:runtime
npm run test:mailbox-parity
npm run test:backpressure
```
