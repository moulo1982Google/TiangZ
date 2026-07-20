# 架构与快速启动

## 目标

先建立运行时世界观，再运行 Demo。这里最重要的不是类名，而是每一层承担什么边界。

## 五层模型

```text
Machine
  -> Process
      -> EntryScene
          -> Scene
              -> Actor
                  -> Component
```

### Process

Process 就是 OS 进程，也是一个 V8、一个 TS 全局空间、一个 TS 业务线程和一个 Inspector。Tokio 可以多线程处理网络，但业务 Handler 不会同时在多个线程执行。

### EntryScene

配置创建、可通过 name/type 寻址的顶层 Scene。`LoginMgr`、`Login`、`Gate`、`MapHost` 都是 EntryScene。它决定业务边界，不决定必须独占一个进程。

同一份配置可以让一个 Process 承载多个 EntryScene；也可以把它们拆到多个 Process，调用代码不变。

### Scene

进程内的业务容器，适合地图、动态副本、社交域等。`MapHostScene` 可以创建多个 `MapScene`，这才是“一个线程承载多个低负载地图”。玩家变多后，再通过配置和路由把地图分散到更多 Process。

### Actor 与 Component

Actor 是可寻址 mailbox owner，例如玩家。Component 是 Actor/Scene 上的状态与能力，例如位置、移动、背包。Handler 可以协调多个 Component，不需要从属于某一个 Component。

## 与 skynet、ET 的关系

- 与 skynet 相似：消息隔离、异步 RPC、小核心、部署可拆分。
- 与 ET 相似：业务顶层使用 Scene，实体使用 Actor/Component，mailbox 决定串行范围。
- 与旧原型不同：不再一个 Service 一个 V8，也不再把 Service 当成 Process 和业务边界的混合物。

## 线程与 await

```text
Tokio 多线程：accept/read/write/分帧/跨进程连接
TS 单线程：Tick/protobuf/Handler/Scene/Actor/Component
```

`await` 会把当前异步函数挂起，让同一 V8 执行其他可运行任务。ordered mailbox 会阻止同一目标的下一条消息进入 Handler；unordered mailbox 允许重叠，但并不会得到另一个 CPU 线程。

## 启动

```powershell
npm install
npm run build
cargo run --bin TiangZ -- configs/local/all.json
```

日志应出现：

```text
starting process all with one V8 and 6 scene(s)
[process:all] one V8 started with 6 scene(s)
```

完整验证：

```powershell
npm run test:runtime
```

该命令先验证 `all.json` 的单进程多 Scene，再验证六个拆分进程。两者都会完成登录、GateSession、地图进入、移动和多人可见性。

## 阅读入口

1. `src/main.rs`：选择普通进程或 StartMachine。
2. `src/process.rs`：一个事件队列、一个 V8、多个 Scene Listener。
3. `app/main.ts`：Rust 到 TS 的全局入口。
4. `app/core/process/ProcessRuntime.ts`：创建并路由 EntryScene。
5. `app/core/runtime/host.ts`：动态 Scene/Actor/Component。
