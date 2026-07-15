# TiangZ
天工

基于ECS模式(伪)，Rust语言编写的的游戏服务器，正在开发中，尚未发布可运行的0.1版本。

灵感来源：ET，github地址：https://github.com/egametang/ET 感谢猫大的开源作品。感谢字母哥的教学。

# 分支：ets_runtime

`ets_runtime` 是一个 Rust + deno_core + TypeScript 的 MMORPG 服务端实验框架。Rust/Tokio 负责网络、分帧、背压和跨进程连接；一个操作系统进程只创建一个 V8，TypeScript 业务线程在其中承载多个 Scene、Actor 和 Component。

## 当前架构

```text
Machine
  -> OS Process（一个 V8、一个 TS 业务线程）
      -> EntityRoot（InstanceId -> Entity）
      -> EntryScene（配置启动，可通过 name/type 寻址）
          -> Scene（动态业务场景，例如地图实例）
              -> UnitComponent（地图全部 Unit 的业务集合）
                  -> Unit/Actor（玩家、怪物、NPC 等消息目标）
                      -> Component（状态与领域能力）
```

- `Process` 是部署、V8、线程、Inspector 和故障隔离边界。
- `EntryScene` 是顶层业务边界，例如 `LoginMgr`、`Login`、`Gate`、`MapHost`。
- 普通 `Scene` 是进程内动态业务容器，例如 `map:1`、副本实例。
- `Actor` 是带 `Id/InstanceId` 和 MailBoxComponent 的消息目标；地图 Actor 统一继承 Unit。
- `ProcessHost.Root` 按 InstanceId 定位当前生命周期 Entity，MapScene.UnitComponent 按 UnitId 管理地图实体。
- `Component` 组织状态与能力，不要求 Handler 绑定到单一 Component。
- 同进程 Scene 调用直接进入目标 Scene mailbox；跨进程调用走持久 Inner TCP。业务代码不判断本地或远程。

这套模型借鉴 ET 的 Scene/Actor/Component 心智模型，同时保留 skynet 式消息隔离和小运行时。框架不再把 Skynet Service 与 OS Process 混为一层。

## 目录

```text
src/                         Rust 宿主、Process 运行时、网络与 Inspector
app/core/                    框架代码
app/core/process/            ProcessRuntime、EntryScene、Scene 路由
app/core/runtime/            EntityRoot、动态 Scene、Unit/Actor、Component、mailbox
app/demo/                    MMORPG Demo 业务
app/demo/scenes/             配置启动的 Demo EntryScene
app/generated/               全部自动生成代码
app/generated/hotfix/        自动生成的 Scene/Handler 模块入口
proto/                       protobuf 源文件
configs/<environment>/       环境启动配置
docs/tutorials/              从零学习手册
docs/reference/              配置、API、命令参考
docs/design/                 维护者实现文档
```

## 快速启动

```powershell
cd E:\VsCode\skynet\ets_runtime
npm install
npm run build
cargo run --bin ets_runtime -- configs/local/all.json
```

`all.json` 在一个 OS 进程、一个 V8 中启动六个入口 Scene，但保留各自客户端/Inner Listener：

```text
log       Log       127.0.0.1:7100
login_mgr LoginMgr  127.0.0.1:7000
login_1   Login     127.0.0.1:7001
login_2   Login     127.0.0.1:7002
gate_1    Gate      127.0.0.1:7201
map_1     MapHost   127.0.0.1:7301
```

完整冒烟测试会验证单进程和拆分进程具有相同业务行为：

```powershell
npm run test:runtime
```

Demo 协议仍保留 `GetLoginServiceAddr` 这个产品层名字，含义是“获取登录服务器地址”，不是框架中的 Service 类型。

## 配置模型

```json
{
  "process": { "name": "all" },
  "scenes": [
    { "name": "login_mgr", "sceneType": "LoginMgr", "ip": "127.0.0.1", "port": 7000 },
    { "name": "login_1", "sceneType": "Login", "ip": "127.0.0.1", "port": 7001 }
  ],
  "knownScenes": [
    { "name": "login_mgr", "sceneType": "LoginMgr", "ip": "127.0.0.1", "port": 7000 },
    { "name": "login_1", "sceneType": "Login", "ip": "127.0.0.1", "port": 7001 }
  ]
}
```

- `process`：当前 OS 进程，一个配置文件只描述一个 Process/V8。
- `scenes`：当前进程实际创建的入口 Scene。
- `knownScenes`：当前进程可路由的 Scene 目录，目标可以在其他进程。
- `debug`：属于 `process`，因为一个进程只有一个 V8/Inspector。
- `StartMachine.json`：按机器 IP 启动多个进程配置文件。

把 `all.json` 拆成多个配置时，只改变 `scenes` 的部署归属；`knownScenes` 中目标的 name/type/ip/port 保持一致，业务调用代码不改。

## 编写入口 Scene

```ts
import { entryScene } from "../../core/process/registry";
import { EntryScene } from "../../core/process/types";
import { rpc } from "../../core/protocol/rpc";

@entryScene() // LoginMgrScene 默认注册为 SceneType "LoginMgr"
export class LoginMgrScene extends EntryScene {
  @rpc(LoginMgrProtocol.GetLoginServiceAddr)
  private getLoginServiceAddr(
    request: C2S_GetLoginServiceAddr,
  ): S2C_GetLoginServiceAddr {
    const loginScenes = this.scenes.many("Login");
    const selected = loginScenes[request.rpcId! % loginScenes.length];
    return { name: selected.name, ip: selected.ip, port: selected.port };
  }
}
```

运行 `npm run codegen` 后，`tools/codegen_scenes.mjs` 扫描 Scene 与 handlers 目录，并生成 `app/generated/hotfix/scenes.ts`、`handlers.ts`。无需手工维护 Scene 类型表或 msgcode-to-handler 表。

## Scene 调用

```ts
await this.scenes.callOne("Rank", RankProtocol.Query, request);

const gates = this.scenes.many("Gate");
const gate = chooseGate(gates, account);
await this.scenes.call(gate, GateProtocol.Bind, request);

await this.scenes.send(
  this.scenes.byName(player.gateName),
  GateMessages.MapReady,
  message,
);
```

- `callOne(type, ...)`：该 SceneType 必须恰好一个实例。
- `many(type)`：返回多个实例，由业务做负载均衡或一致性选择。
- `call(scene, ...)`：已经选定具体 `SceneConfig`。
- `send(...)`：单向消息；成功表示已被本地 mailbox 接受或已进入远程发送队列，不等待目标 Handler 完成。

同 V8 的调用由 `ProcessRuntime` 直接路由；跨进程调用由 Rust 复用 TCP 连接，并按 protobuf payload 中的 `rpcId` 多路复用。RPC 头仍只有 `[msgcode]`，`rpcId` 属于 IRequest/IResponse payload。

## Mailbox

- `EntryScene` 默认 `ordered`：一个 Handler 跨越 `await` 时，同 Scene 后续消息等待。
- `unordered` 允许不同消息异步重叠，CPU 代码仍运行在同一个 TS 线程。
- 动态 Scene 和 Actor 也拥有独立 mailbox。
- Actor 消息通过 InstanceId 在 EntityRoot 中 O(1) 定位，再进入目标 MailBoxComponent。
- `LoginScene` 使用 unordered，把同账号消息路由到 ordered `LoginActor`。
- 单向本地 `send` 只排入目标 mailbox，不等待执行，从而避免 `Gate call Map -> Map send Gate` 形成调用环死锁。

## 协议与代码生成

网络帧：

```text
[length: u32 big-endian][msgcode: u16 big-endian][protobuf payload]
```

Rust 去除 length-prefix 后把 `Uint8Array` 批量交给 TS；TS 完成 msgcode、protobuf、Handler 和响应编码。生成代码全部位于 `app/generated`，不要手工编辑。

## 调试与验证

```powershell
npm run build:debug
cargo run --bin ets_runtime -- configs/local/login1.debug.json
```

一个 Process 对应一个 Inspector。详见 [TypeScript 调试](docs/typescript_debugging.md)。常用验证：

```powershell
npm run check
cargo test --all-targets
npm run test:runtime
npm run test:mailbox-parity
npm run test:backpressure
```

## 跨平台 RPC 性能基线

复制前先清除所有可重新生成的编译产物、依赖和测试报告：

```bash
npm run clean:copy:dry-run
npm run clean:copy
```

`clean:copy:dry-run` 只预览；`clean:copy` 会删除 Rust `target`、TS `dist`、各级 `node_modules`、Cocos `library/temp/build/native` 等缓存以及 `perf/results`。源码、配置、proto、`tools` 和 Cocos `assets/settings` 不会删除。

将整个工程复制到 Linux 后，可以直接执行：

```bash
cd ets_runtime
npm ci
npm run perf:rpc-baseline
```

使用 nvm 安装 Node 时不要加 `sudo`。`sudo` 默认看不到用户目录中的 npm，并会产生 root 所有权的构建文件。压测入口会自动识别缺失或来自其他操作系统的 `node_modules`，并通过 `npm ci` 重建。

命令会自动构建 Release、启动 `BenchScene`、完成 64B 到 16KB 的 RPC 测试、关闭 Runtime，并在 `perf/results` 生成 Markdown、JSON 和服务日志。Windows 使用同一条 `npm run perf:rpc-baseline` 命令。

自定义长时间测试：

```bash
npm run perf:rpc-baseline -- \
  --warmup 10 --duration 60 \
  --connections 8 --concurrency 512 \
  --payloads 64,256,1024,4096,16384
```

完整环境要求、参数和指标口径见 [跨平台 RPC 基线测试](perf/rpc_baseline/README.md)。

学习顺序从 [文档入口](docs/README.md) 开始。
