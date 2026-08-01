# TiangZ
天工，一个正在开发中的 MMORPG 服务端框架。

当前开发版本为 `0.4.0`，Phase 4.0空间契约已经完成；`0.3.10`是框架能力的首个稳定基线。Demo 已可完成登录、选服、进入地图、多人移动、状态广播，以及 WebSocket/Cocos Web 和 KCP/Cocos Native 链路；Phase 4将继续建设Rust AOI、3D导航、持久化和MMORPG业务样例。

架构借鉴 [ET](https://github.com/egametang/ET) 的 Scene、Actor、Entity 和 Component 模型，也吸收了 Skynet 的消息隔离思想。感谢猫大的开源作品与字母哥的教学。

## 当前开发分支：`ets_runtime`

TiangZ 使用 Rust + deno_core + TypeScript。Rust/Tokio 负责网络、分帧、背压、跨进程连接和 Native Entity 权威数据；一个操作系统进程只创建一个 V8，TypeScript 业务线程在其中承载多个 Scene、Actor 和 Component。

## 当前架构

```text
Machine
  -> OS Process（一个 V8、一个 TS 业务线程）
      -> EntityRoot（InstanceId -> Entity）
      -> 配置 Scene / EntryScene（可通过 name/type 寻址）
          -> 动态 Scene（例如地图实例）
          -> Session（网络连接）
              -> UnitComponent（地图全部 Unit 的业务集合）
                  -> Unit（玩家、怪物、NPC）
                      -> Component（状态与领域能力）
                          -> ChildEntity（Item、Buff、动态Quest等本地子实例）
```

- `Process` 是部署、V8、线程、Inspector 和故障隔离边界。
- 配置 Scene 是顶层业务边界，例如 `LoginMgr`、`Login`、`Gate`、`MapHost`；代码中的 `EntryScene` 只是这类 Scene 的运行时基类。
- 动态 Scene 是进程内业务容器，例如 `map:1`、副本实例。
- `Session` 表示一条网络连接，`Unit` 表示玩家、怪物、NPC。它们和 Scene 都可拥有 MailBoxComponent，因此都属于 Actor 消息目标；业务不创建泛化的 `XxxActor` 类。
- Gate中的`GatePlayerRoute`不是Actor：它把跨重连的玩家位置与一次性`GateSession`分离。普通socket断开保留Map Unit，30秒宽限结束后才由Gate请求Map执行最终下线。
- `ProcessHost.Root` 按 InstanceId 定位当前生命周期 Entity，MapScene.UnitComponent 按 UnitId 管理地图实体。
- `Component` 组织状态与能力，不要求 Handler 绑定到单一 Component。
- `ChildEntity` 由 Component 唯一拥有，具备稳定身份和生命周期但没有 mailbox；它不会成为网络 Actor。
- 同进程 Scene 调用直接进入目标 Scene mailbox；跨进程调用走持久 Inner TCP。业务代码不判断本地或远程。
- 高频跨帧 Entity 数据可以保存在 Rust Arena，TypeScript 只持有 generation handle；Handler、mailbox 和业务组合仍保留在 TypeScript。

这套模型借鉴 ET 的 Scene/Actor/Component 心智模型，同时保留 skynet 式消息隔离和小运行时。框架不再把 Skynet Service 与 OS Process 混为一层。

## 目录

```text
src/                         Rust 宿主、Process 运行时、网络与 Inspector
app/core/                    框架代码
app/core/public.ts           业务唯一 Stable Core API 入口
app/core/process/            ProcessRuntime、EntryScene、Scene 路由
app/core/runtime/            EntityRoot、动态 Scene、Session、Unit、Component、mailbox
app/model/                   不可热更的状态、稳定类型与启动结构
app/model/demo/              MMORPG Demo 的 Scene、Entity、Component 状态
app/model/bench/             仅由 build:bench 装配的稳定基准结构
app/hotfix/                  可热更的 Handler 与领域方法实现
app/hotfix/demo/             Demo 可热更行为
app/hotfix/bench/            仅由 build:bench 装配的压测 Handler
app/generated/               服务端与 Native 自动生成代码
app/generated/bootstrap/     自动生成的 Model Scene 启动入口
app/generated/hotfix/        自动生成的 Hotfix Handler/补丁入口
proto/                       protobuf 源文件
game_config/                 Luban Excel游戏配置唯一源文件
native_data/core/            框架内置 Rust Entity op 原型
native_data/demo/            Demo Entity 与粗粒度 Native op 原型
configs/<environment>/       环境启动配置
client_sdk/typescript/       TypeScript Client SDK 唯一源码
cocos_client2D/              Cocos Creator 2D Demo 客户端
cocos_client3D/              Cocos Creator 3D Demo 客户端（Phase 4.3空项目骨架）
pixi_client/                 PixiJS/H5 SDK 通用性验收客户端
perf/                        RPC、完整链路与地图容量测试
tools/                       codegen、冒烟测试和维护脚本
tools-projects/              本机独立工具仓库，不属于 TiangZ 主仓库
docs/tutorials/              从零学习手册
docs/patterns/               MMORPG领域设计模式与稳定规则编号
docs/reference/              配置、API、命令参考
docs/design/                 维护者实现文档
```

地图运行时已接入Rust AOI：`MapConfig`引用冷配置`AoiConfig`，分别定义AOI Grid大小、Enter范围、Detach迟滞范围和独立同步档位。同步档位只节流已经可见的可覆盖状态，不会提前建立视野；业务只在阵营、隐身、位面改变时通过`MapAoiComponent.Invalidate*`通知重算。开发约束见[业务开发手册](docs/ai/business-development-manual.md)和[地图空间契约](docs/design/spatial-world.md)。

## 快速启动

```powershell
cd E:\gitee\TiangZ
npm install
npm run build
cargo run -- configs/local/all.json
```

`all.json` 在一个 OS 进程、一个 V8 中启动八个入口 Scene，但保留各自客户端/Inner Listener：

```text
login_mgr LoginMgr  127.0.0.1:7000
map_manager MapManager 127.0.0.1:7100
login_1   Login     127.0.0.1:7001
login_2   Login     127.0.0.1:7002
gate_1    Gate      127.0.0.1:7201
map_1     MapHost   127.0.0.1:7301
map_2     MapHost   127.0.0.1:7302
location_1 Location 127.0.0.1:7401
```

完整冒烟测试会验证单进程和拆分进程具有相同业务行为：

```powershell
npm run test:runtime
```

Demo 协议仍保留 `GetLoginServiceAddr` 这个产品层名字，含义是“获取登录服务器地址”，不是框架中的 Service 类型。

## 客户端 SDK

公共 TypeScript SDK 位于 `client_sdk/typescript/`。`Core` 只包含引擎无关的帧、RPC、Push、Update 队列、错误和 Transport 抽象；客户端协议生成代码只位于 SDK 的 `Generated/Model`。执行 `npm run codegen` 后，正式 SDK 会分发到 Cocos 与 Pixi 的 `Generated/SDK`，Bench 协议只留在规范 SDK 供压测工具使用，两个客户端不维护私有网络 Core。

```powershell
# 公共 SDK 真实 WebSocket 登录到进图
npm run smoke:client-sdk -- websocket 127.0.0.1 7000

# PixiJS/H5
npm run build:pixi
npm run serve:pixi
npm run smoke:pixi
```

RPC 使用生成的 `LoginMgrClient`、`LoginClient`、`GateClient` 和 `MapClient`；业务不手写 msgcode、rpcId 或 codec。服务端 Push 使用独立的 `@clientMessageHandler`，由 codegen 自动生成 Handler 导入入口。详细规则见 `client_sdk/typescript/README.md` 与 `docs/client_sdk_plan.md`。

## 游戏配置

`game_config/`是策划数值的唯一源目录，使用固定版本的[Luban](https://github.com/focus-creative-games/luban)从Excel生成服务端与客户端强类型配置。它和`configs/<environment>/`的Process、Scene、端口部署配置是两套完全不同的东西。

第一批表包括`ItemConfig`、`MapConfig`和`PlayerConfig`。修改Excel后执行：

```powershell
npm run build:game-config
npm run test:game-config
```

服务端从`app/generated/model/config`读取，客户端通过公共SDK的`Generated/Config`读取；业务统一使用`GameConfigs.XxxConfig.Get(id)`，不得解析Excel、JSON或手工编辑Generated。表结构属于不可热更Model；只修改数据时，`build:game-config`会产生内容寻址候选，运行中的Watcher可执行`reload-config <候选目录>`让各Process原子切换。`npm run dev`会自动完成这一步。客户端配置仍随SDK发布，不会被服务端Reload远程替换。详见[游戏配置教程](docs/tutorials/10-game-config.md)。

## 配置模型

```json
{
  "process": {
    "name": "all",
    "logging": {
      "level": "info",
      "format": "pretty",
      "console": true
    },
    "network": {
      "ioBackend": "epoll"
    },
    "game": {
      "fixedUpdateMs": 50,
      "maxCatchUpSteps": 2
    },
    "nativeData": {
      "debugScalarAccess": false,
      "scalarAccessWarnThreshold": 10000
    },
    "scheduling": {
      "mode": "adaptive"
    },
    "debug": {
      "inspectorIp": "127.0.0.1",
      "inspectorPort": 9231,
      "breakOnStart": false,
      "allowRemote": false
    },
    "observability": {
      "latency": {
        "enabled": true,
        "sampleRate": 1
      }
    }
  },
  "scenes": [
    {
      "name": "login_mgr",
      "sceneType": "LoginMgr",
      "ip": "127.0.0.1",
      "port": 7000,
      "protocol": "auto",
      "audience": "mixed"
    }
  ],
  "knownScenes": [
    { "name": "login_mgr", "sceneType": "LoginMgr", "ip": "127.0.0.1", "port": 7000 },
    { "name": "login_1", "sceneType": "Login", "ip": "127.0.0.1", "port": 7001 }
  ]
}
```

- `process.name`：当前 OS 进程名称，一个配置文件只描述一个 Process/V8。
- `process.logging`：统一 Rust/TS 日志的级别、文本或 JSON 格式、控制台和滚动文件输出；默认 INFO 文本控制台。
- `process.network`：I/O Backend；默认 `epoll`，Linux 可显式选择实验性的 `io-uring`。
- `process.game`：固定游戏帧和最大补帧数；默认 `50ms/20Hz`、最多补跑 2 帧。
- `process.nativeData`：Demo 的 Rust Native Entity 诊断配置，只观测标量访问，不控制数据是否下沉。
- `process.scheduling`：Runtime Pump 调度模式及队列参数；默认 `adaptive`。
- `process.lifecycle.stopTimeoutMs`：优雅停机等待上限，默认 10000ms。
- `process.lifecycle.hotfixReloadTimeoutMs`：Hotfix等待安全屏障的上限，默认30000ms；超时保留旧generation。
- `process.debug`：V8 Inspector 配置。该对象可省略；存在时必须设置 `inspectorPort`。远程监听还必须显式设置 `allowRemote: true`。
- `process.observability`：延迟采样等可观测性配置；不需要时可以省略。
- `scenes`：当前进程实际创建的入口 Scene。
- `knownScenes`：当前进程可路由的 Scene 目录，目标可以在其他进程；省略或为空时默认等于 `scenes`。
- `knownSceneFiles`：相对当前进程配置引用共享稳定Scene目录；本地拆分部署统一使用`configs/local/cluster.known-scenes.json`，避免每个进程复制`knownScenes`。
- `staticMapIds`：只写在实际承载地图的`MapHost`的`scenes`项中；启动时创建这些静态地图，且静态`MapInstanceId`等于配置ID。`knownScenes`路由副本不重复填写。
- `acceptDynamicMaps`：MapHost是否向MapManager注册并接受动态副本；默认false。空载副本Host使用空`staticMapIds`和true。
- `MapManager`：动态地图单例调度Scene。各MapHost把它加入`knownScenes`后主动注册；Manager不需要静态列出将来扩容的MapHost。
- `scene.protocol`：`auto`、`tcp`、`websocket` 或 `kcp`；默认 `auto`。
- `scene.audience`：`mixed`、`inner` 或 `outer`；默认 `mixed`。
- `StartMachine.json`：按机器 IP 启动多个进程配置文件。正式环境放在 `configs/<environment>`；压测、自动测试和传输实验分别放在 `configs/bench`、`configs/tests`、`configs/experiments`。

把 `all.json` 拆成多个配置时，只改变 `scenes` 的部署归属；`knownScenes` 中目标的 name/type/ip/port 保持一致，业务调用代码不改。

Scene 生命周期和玩家下线保存约定见 [生命周期与玩家下线](docs/reference/lifecycle.md)。

静态地图配置、动态副本创建、统一`TransferToMap`、安全销毁与重登回退流程见[地图实例与动态副本](docs/tutorials/11-map-instance-and-dungeon.md)。

## 编写入口 Scene

```ts
import {
  EntryScene,
  entryScene,
  rpc,
  type RuntimeEntrySceneConfig,
  type SceneConfig,
} from "../../core/public";

@entryScene() // LoginMgrScene 默认注册为 SceneType "LoginMgr"
export class LoginMgrScene extends EntryScene {
  private readonly loginScenes: SceneConfig[];
  private next = 0;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.loginScenes = this.scenes.many("Login");
    if (this.loginScenes.length === 0) {
      throw new Error("LoginMgrScene needs at least one known LoginScene");
    }
  }

  @rpc(LoginMgrProtocol.GetLoginServiceAddr)
  private getLoginServiceAddr(
    _request: C2S_GetLoginServiceAddr,
  ): S2C_GetLoginServiceAddr {
    const selected = this.loginScenes[this.next % this.loginScenes.length];
    this.next += 1;
    return { name: selected.name, ip: selected.ip, port: selected.port };
  }
}
```

运行`npm run codegen`后，生成器按照`codegen.config.json`扫描Model入口Scene、Hotfix Handler和`@systemFor`业务System，生成Model启动入口、Hotfix入口以及`app/generated/bootstrap/systems/*.d.ts`方法声明。Model只写状态，调用方仍可直接使用`player.Move()`，无需手工维护类型表、Handler表、补丁入口或空方法。

## Model与Hotfix

服务端TS固定拆成两个Bundle：`dist/model.js`是只加载一次的ESM，`dist/hotfix.js`是可重复求值的IIFE脚本。Model拥有字段、构造、继承、Scene/Entity/Component身份和稳定类型，Process启动后永久冻结；Hotfix只拥有Handler和方法实现。固定脚本名避免连续Reload把每代候选积累到V8模块表或调试元数据中。

```powershell
# Model/Core/协议/Native schema有变化：完整构建并重启Process
npm run build

# 只修改app/hotfix行为：只重建Hotfix候选
npm run build:hotfix

# 开发模式：初次构建后监听Hotfix源码，保存即自动构建候选并Reload
npm run dev -- configs/local/StartMachine.json
```

Hotfix只能从`#tiangz/model`导入稳定类型。`build:hotfix`会比较Model源码、协议锁、Stable Core API和Native schema指纹；任何一项变化都直接拒绝，不支持强制绕过。命令输出按内容哈希命名的`dist/hotfix-candidates/<hash>`目录，不覆盖当前Bundle。Watcher运行时输入`reload <候选目录>`会让每个Process独立预检并在安全屏障提交；失败或超时继续使用旧generation。`npm run dev`只是把codegen、类型检查、候选构建和Reload自动化，V8仍只执行生成的JavaScript；该命令只用于本地开发，正式部署必须传输完整不可变候选目录。3000玩家1Hz Reload、8秒慢RPC屏障和100代资源长稳均已有自动化或版本化报告；仍不能直接替换`dist/hotfix.js`。详见[Process级TypeScript热更设计](docs/design/typescript-hot-reload.md)。

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
- `LoginScene` 使用 unordered，不同连接可以并行；每条连接由 ordered `Session` 保证跨 `await` 串行。账号级互斥属于账号业务域，不通过虚构 `LoginActor` 获得。
- 单向本地 `send` 只排入目标 mailbox，不等待执行，从而避免 `Gate call Map -> Map send Gate` 形成调用环死锁。

## 协议与代码生成

网络帧：

```text
[length: u32 big-endian][msgcode: u16 big-endian][protobuf payload]
```

Rust 去除 length-prefix 后把 `Uint8Array` 批量交给 TS；TS 完成 msgcode、protobuf、Handler 和响应编码。Endpoint 当前支持 TCP、二进制 WebSocket、KCP，以及开发期自动识别的 `auto`。

生成代码包括：

- `app/generated`：服务端协议、Native handle、Model bootstrap和Hotfix入口。
- `src/generated`：Rust Native op 注册与 bootstrap。
- `cocos_client2D/assets/scripts/Generated`：Cocos 客户端协议和 Handler 入口。

所有 Generated 文件都不应手工编辑。`npm run codegen` 会同步更新根目录 `codegen.manifest.json`；Developer Tools 使用该文件检查生成结果是否过期、缺失、遗留或被修改。

## VS Code 开发工具

TiangZ 目前有两个职责独立的 VS Code 插件，均尚未发布到 Marketplace：

- [TiangZ Native Language](https://gitee.com/eblard_admin/tiangz-native-language)：为 `.native` 提供高亮、诊断、补全、Hover、跳转、格式化与 codegen 命令。语言核心和无文件系统依赖的 codegen-core 也由该仓库提供；主工程当前使用 `v0.12.0`。
- [TiangZ Developer Tools](https://gitee.com/eblard_admin/tiangz-developer-tools)：索引Environment、Machine、Process、Scene、Session、Unit、Component、System与Handler，在资源管理器显示“TiangZ工程”，提供源码跳转、Problems诊断、CI工程检查和定向代码生成。主工程固定使用`v0.14.0`，并通过`verify:design-rules`确保设计核心与`docs/patterns`规则ID、归属文档保持一致。

两个插件分开维护，未来可以通过 Extension Pack 一键安装。当前需分别克隆仓库，执行 `npm install`、`npm run check` 和 `npm run package:extension`，再从各仓库 `dist` 目录安装 VSIX。

Developer Tools 的工程检查器已经作为固定 Git Tag 依赖接入主仓库。编辑器 Problems 与命令行共用同一套规则：

```powershell
npm run check:project
npm run check:project -- --format json
```

设计Item、Buff、Quest、Achievement、Numeric或自定义业务系统时，先阅读[`docs/patterns`](docs/patterns/README.md)，也可以在Developer Tools执行“TiangZ：设计业务系统”或输入`@tiangz /design buff`。规则库先确定所有权、Entity形态、生命周期、Audience和同步语义，AI只负责解释；最终仍以当前代码、项目检查和测试为准。

## 调试与验证

```powershell
npm run build:debug
cargo run -- configs/local/login1.debug.json
```

一个 Process 对应一个 Inspector。详见 [TypeScript 调试](docs/typescript_debugging.md)。日常开发使用快速质量门：

```powershell
npm run verify:quick
```

修改协议、进程通信、mailbox、背压或生命周期后，合并前执行完整质量门：

```powershell
npm run verify
```

`verify:codegen` 根据 `codegen.manifest.json` 只读校验输入、输出哈希和生成文件集合。新增 protobuf 消息评审编号后执行 `npm run codegen:proto:update-lock`；普通 codegen 不会静默接受新 opcode。手写函数的注释要求见 [代码注释约定](docs/reference/coding-conventions.md)。

## 跨平台 RPC 性能基线

复制前先清除所有可重新生成的编译产物、依赖和测试报告：

```bash
npm run clean:copy:dry-run
npm run clean:copy
```

`clean:copy:dry-run` 只预览；`clean:copy` 会删除 Rust `target`、TS `dist`、各级 `node_modules`、Cocos `library/temp/build/native` 等缓存，以及 `perf/results` 中除 `*_latest.json/md` 外的临时报告。源码、配置、proto、`tools` 和最近一次基准摘要不会删除。

将整个工程复制到 Linux 后，可以直接执行：

```bash
cd TiangZ
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

学习顺序从 [文档入口](docs/README.md) 开始。已经完成的版本变更、验证结果和设计取舍记录在 [开发日志](docs/development-log.md)，未来计划仍以 [路线图](docs/roadmap.md) 为准。

使用 AI 协作开发时，先阅读根目录 [AGENTS.md](AGENTS.md)、[AI 项目上下文](docs/ai/project-context.md)和[AI 业务开发手册](docs/ai/business-development-manual.md)。三份文档分别保存高优先级规则、可迁移的架构记忆和业务层默认开发方式，避免新的 AI 从 Rust Runtime 或 TypeScript Core 开始实现普通业务需求。
