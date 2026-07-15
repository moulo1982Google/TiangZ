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
5. Listener 事件携带 `eventType + connectionId + sceneIndex`，批量送入 TS。

连接 ID 在 Process 内全局分配，因为多个 Listener 共享 writer map。

## TS 启动链

`app/main.ts` 暴露 `__etsStartProcess`、`__etsPushHostEventsBinary`、`__etsUpdateBinary`。`ProcessRuntime` 创建共享 `ProcessHost` 和多个 EntryScene，并按 sceneIndex 路由外部帧。

EntryScene 保有独立协议 Registry、mailbox、ingress、outbound 和 metrics；动态 Scene/Actor 共用 ProcessHost。子 Scene ID 必须使用入口 Scene 命名空间。

EntryScene 同样是 Component 容器。入口 Scene class 负责声明业务边界、mailbox 和组件装配；所有业务组件统一继承 `Component`；独立 Handler class 负责协议适配，并可通过 `scene.GetComponent(...)` 协调多个组件。Handler 拆文件不创建新 mailbox，也不改变调度线程。

禁止重新引入 `EntrySceneComponent/SceneComponent/ActorComponent` 这种按宿主类型拆分的业务基类。组件属于谁由 `AddComponent` 的调用位置决定。也不要添加只调用另一个对象同名方法的 Sink、Delegate、EventComponent 或 Adapter；业务行为应落在真正拥有状态和规则的 Entity/Component 上。

`ProcessHost.Root` 维护进程级 `InstanceId -> Entity` 索引。动态 Scene/Actor 创建后注册，销毁前移除。ActorRef 必须同时校验 sceneId、业务 actorId 和 InstanceId，禁止只凭可复用业务 ID 调度旧引用。

地图实体统一使用 `Unit extends Actor`。MapScene 的 UnitComponent 是 UnitId 业务集合；Root 是 InstanceId 生命周期集合；二者职责不能混用。Unit.Parent 指向 UnitComponent，Unit.DomainScene() 指向 MapScene。

## 批量下行 Bridge

`sendClient` 和 `sendClientMany` 都进入 `OutboundBatch`。群发只编码一次协议帧，并把小端 uint32 connectionId 列表和一份 `Uint8Array` 通过 `__hostPushOutboundBatch` 交给 Rust。禁止在 `app/main.ts` 中重新展开成逐连接 Host Op。

Rust 只把 V8 帧复制为一次 `Bytes`，向各连接 writer 投递时使用引用计数克隆。每个客户端的帧数、逻辑字节、队列上限和慢连接断开仍独立计算；共享物理内存不能改变背压语义。同一批次和不同批次按产生顺序入队，必须保持单连接消息顺序。

进程指标区分 `outbound_batches`、`outbound_recipients`、`outbound_bridge_bytes` 和 `outbound_logical_bytes`。全地图广播中 recipients 可以是 batches 的数十倍，这是预期扇出，不应被当作漏发。

## 本地与远程 RPC

`SceneCallContext` 先询问 LocalSceneRouter：

- 本地 call：直接进入目标 EntryScene mailbox，等待目标响应。
- 本地 send：投递目标 mailbox 后立即返回，不等待 Handler。
- 远程：调用 `__hostSceneCall/__hostSceneSend`，进入 `src/transport.rs`。

远程连接按来源 Scene/目标地址复用。多个 pending RPC 共享 TCP，由 protobuf payload rpcId 唤醒各自 oneshot；缺失响应不会阻塞其他 rpcId。

不要让本地调用绕过 mailbox，也不要把本地调用送回 Rust queue 后等待同一个 V8，那会自锁。

## Mailbox 调度

EntryScene 的 mailbox scheduler 保留同步快路径。ordered Handler 返回 Promise 后保持 busy，后续任务排队；unordered 直接启动。单向本地 send 的 queued Promise 由 runtime 记录异常，不向发送方等待。

方法级 `@rpc/@message` 与 class 级 `@rpcHandler/@messageHandler` 最终注册到 EntryScene ProtocolRegistry。`@actorRpcHandler/@actorMessageHandler` 注册到独立 Actor ProtocolRegistry，对应 ET 的 ActorMessageDispatcher；Actor Handler 先由 Root 定位 Entity，再进入实体 MailBoxComponent。两类 Registry 不互相占用 msgcode。

动态 Scene/Actor mailbox 位于 `app/core/runtime`。修改任一层时必须运行 mailbox parity 测试。

## 背压

- Process Rust 入站队列：4096 事件，所有 Scene 共享。
- 每连接出站：帧数与字节数双限制。
- 批量下行共享帧内存，但每个目标连接仍按完整帧长增加逻辑排队字节。
- Inner transport：全局和每目标连接都有界队列。
- 慢客户端只关闭自身。

TS metrics 按 EntryScene 输出，Rust queue/transport metrics 按 Process 输出。

## 代码生成

`tools/codegen_proto.mjs` 负责协议模型和 TS 输出；`tools/codegen_scenes.mjs` 扫描 `sceneSearchRoots` 下的 `*/scenes/*.ts`，并扫描 `handlerSearchRoots` 下所有 `handlers` 目录，分别生成 `app/generated/hotfix/scenes.ts` 与 `handlers.ts`。生成物只放 `app/generated`。

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
