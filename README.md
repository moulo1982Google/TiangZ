# TiangZ
[![verify](https://github.com/moulo1982Google/TiangZ/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/moulo1982Google/TiangZ/actions/workflows/verify.yml)

天工，一个正在开发中的 MMORPG 服务端框架。

当前开发版本为 `0.4.0`，Phase 4.0空间契约已经完成；`0.3.10`是框架能力的首个稳定基线。当前 Starter MMORPG 已经串起注册/登录、角色目录、NPC接取任务、怪物与技能战斗、Buff、掉落与尸体拾取、背包、货币、NPC商店、同地图玩家交易、动态Boss副本、经验升级和可选 DBProxy 重启恢复；最完整的可操作客户端是 Cocos3D。可复用领域契约与 MMORPG 适配边界见[能力归属表](docs/design/capability-ownership.md)。

## 5分钟启动

```powershell
npm install
npm run hello
```

看到 `Starter 已就绪` 后，用 Cocos3D/Pixi Demo 连接 `ws://127.0.0.1:7000`。完整的第一个 Handler 与 RPC 修改路径见 [5分钟跑通 TiangZ](docs/tutorials/00-quickstart.md)。

持久化边界位于独立的 [TiangZ-DBProxy](https://github.com/moulo1982Google/TiangZ-DBProxy) Rust 仓库。DBProxy 当前工作版本为 `v0.5.0`，提供 Player Snapshot Repository、Revision/CAS、幂等事务回执、多 Endpoint 故障切换和跨记录原子事务；TiangZ 主工程通过 Host Transport 接入，不直接连接 Redis/PostgreSQL。当前 Starter 已验证30秒周期快照、任务奖励、道具使用、商店交易、同地图双玩家原子交易，以及单个静态MapHost强杀后的有界重启和玩家重新路由；邮件、跨地图交易、动态副本现场恢复和完整生产高可用仍属于后续阶段。运行步骤见[DBProxy玩家快照持久化](docs/tutorials/19-dbproxy-player-persistence.md)，交易边界见[玩家交易设计](docs/design/player-trade.md)。

架构借鉴 [ET](https://github.com/egametang/ET) 的 Scene、Actor、Entity 和 Component 模型，也吸收了 Skynet 的消息隔离思想。感谢猫大的开源作品与字母哥的教学。

## 当前开发分支：`main`

TiangZ 使用 Rust + deno_core + TypeScript。Rust/Tokio 负责网络、分帧、背压、跨进程连接和 Native Entity 权威数据；一个操作系统进程只创建一个 V8，TypeScript 业务线程在其中承载多个 Scene、Actor 和 Component。

开发期允许版本号、依赖锁、协议锁和 Stable Core API 锁随契约演进；`npm run verify:locks:warn` 只报告漂移，不阻塞日常迭代。准备发布 Release 时必须执行 `npm run verify:release`，届时才强制版本、锁文件、协议指纹和 Core API 一致性。运行时协议指纹始终严格校验，避免客户端与服务端使用不兼容协议。

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
- `Session`表示一条网络连接，`Unit`表示玩家、怪物、NPC。普通`Unit`默认没有Mailbox；需要InstanceId路由和跨`await`串行的玩家等类型继承`ActorUnit`并显式声明`@actor`。Scene、Session和ActorUnit才是Actor消息目标，业务不创建泛化的`XxxActor`包装类。
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
src/game/                    开发者可编写的Rust游戏业务模块（需重新编译和重启）
app/core/                    框架代码
app/core/public.ts           业务唯一 Stable Core API 入口
app/core/process/            ProcessRuntime、EntryScene、Scene 路由
app/core/runtime/            EntityRoot、动态 Scene、Session、Unit、Component、mailbox
app/model/                   不可热更的状态、稳定类型与启动结构
app/model/domains/             跨游戏可复用的稳定领域契约与Component容器
app/model/mmorpg/              MMORPG 领域的 Scene、Entity、Component 状态与适配器
app/model/bench/             仅由 build:bench 装配的稳定基准结构
app/hotfix/                  可热更的 Handler 与领域方法实现
app/hotfix/mmorpg/             MMORPG 领域的可热更行为
app/hotfix/bench/            仅由 build:bench 装配的压测 Handler
app/generated/               服务端与 Native 自动生成代码
app/generated/bootstrap/     自动生成的 Model Scene 启动入口
app/generated/hotfix/        自动生成的 Hotfix Handler/补丁入口
proto/                       protobuf 源文件
game_config/                 Luban Excel游戏配置唯一源文件
native_data/core/            框架内置 Rust Entity op 原型
native_data/mmorpg/           MMORPG Entity 与粗粒度 Native op 原型
navigation/maps/             3D导航源网格、冷烘焙清单与生成资源
configs/<environment>/       环境启动配置
client_sdk/typescript/       TypeScript Client SDK 唯一源码
client_sdk/cpp/              引擎无关C++ Client SDK与生成协议
client_sdk/csharp/           引擎无关C# Client SDK唯一源码
client_demo/cocos_client2D_3.8.6/              Cocos Creator 2D Demo 客户端
client_demo/cocos_client3D_3.8.8/              Cocos Creator 3D NavMesh灰盒与公共SDK客户端
client_demo/ue_client3D_5.4.4/                 Unreal Engine 5.4.4 C++ SDK插件与3D灰盒客户端
client_demo/godot-3d-4.7.1/              Godot 4.7.1 GDScript WebSocket 3D灰盒客户端
client_demo/Unity2022.3.62f3c1_demo/     Unity 2022.3 C# SDK与3D灰盒客户端
client_demo/pixi_client_8.19.0/                 PixiJS/H5 SDK 通用性验收客户端
perf/                        RPC、完整链路与地图容量测试
tools/                       codegen、冒烟测试和维护脚本
tools-projects/              本机独立工具仓库，不属于 TiangZ 主仓库
docs/tutorials/              从零学习手册
docs/patterns/               MMORPG领域设计模式与稳定规则编号
docs/reference/              配置、API、命令参考
docs/design/                 维护者实现文档
```

Rust业务代码统一放在`src/game/<domain>/`或对应领域文件中，`.native`只负责数据和op契约。`src/native_data.rs`、`src/process.rs`、`src/host.rs`等仍属于框架Runtime，普通Rust业务不得把实现堆回这些文件。Rust模块不参与TS Hotfix；Actor消息仍先经过TS的Location、Unit定位和mailbox，再由生成或薄适配入口调用Rust。完整约束见[Rust业务模块](docs/tutorials/12-rust-business-modules.md)。

Numeric权威值统一使用Rust`i64`、protobuf`int64`和TypeScript`bigint`。派生结果编号固定在1000..9999，Base/Add/Pct按`result*10+1/+2/+3`约定，Rust按编号自动重算而不重复维护业务枚举。

地图运行时已接入Rust AOI：`MapConfig`引用冷配置`AoiConfig`，分别定义AOI Grid大小、Enter范围、Detach迟滞范围和独立同步档位。同步档位只节流已经可见的可覆盖状态，不会提前建立视野；业务只在阵营、隐身、位面改变时通过`MapAoiComponent.Invalidate*`通知重算。开发约束见[业务开发手册](docs/ai/business-development-manual.md)和[地图空间契约](docs/design/spatial-world.md)。

Phase 4.2.5已经把官方Recast/Detour `v1.6.0`资产、Rust权威移动、动态障碍和AOI下行接入Map Runtime：Map 100启动时校验SHA-256并共享只读高度层模板，每个MapInstance独占`dtNavMesh + dtTileCache + Query`、路径和AOI状态；TS通过粗粒度`ProjectPosition/FindPath/Raycast/SampleHeight/UpsertNavigationBoxObstacle/RemoveNavigationObstacle`调用，不接触Detour句柄。业务提交障碍真实尺寸，Rust按烘焙`agentRadius`扩张水平导航占用；障碍命令和受影响Tile按Tick限额处理，完成后正在行走的旧路径会自动重算。Cocos 3D和UE 5.4.4灰盒均支持`E`键通过同一权威RPC开关动态门，前端只在服务端接受后更新表现；Cocos只额外约束本地预测，UE继续插值权威位置。详见[NavMesh3D运行时与Cocos灰盒](docs/tutorials/13-navmesh3d.md)与[UE 5.4.4客户端教程](docs/tutorials/14-unreal-engine-client.md)。

## 快速启动

```powershell
# 先进入TiangZ仓库根目录
npm install
npm run build
cargo run -- configs/local/all-in-one.json
```

`all-in-one.json` 在一个 OS 进程、一个 V8 中启动十个入口 Scene，但保留各自客户端/Inner Listener：

```text
login_mgr LoginMgr  127.0.0.1:7000
map_manager MapManager 127.0.0.1:7100
login_1   Login     127.0.0.1:7001
login_2   Login     127.0.0.1:7002
gate_1    Gate      127.0.0.1:7201
gate_2    Gate      127.0.0.1:7202
map_1     MapHost   127.0.0.1:7301
map_2     MapHost   127.0.0.1:7302
dungeon_1 MapHost   127.0.0.1:7310
location_1 Location 127.0.0.1:7401
```

完整冒烟测试会验证单进程和拆分进程具有相同业务行为：

```powershell
npm run test:runtime
```

TiangZ的完整业务参考是[Starter MMORPG纵向切片](docs/tutorials/20-starter-mmorpg.md)，它把登录、主城、野外战斗、掉落、背包、任务、动态副本、重连和重启恢复串成一条可复制链路。详细验收项见[Starter验收矩阵](docs/starter/acceptance-matrix.md)。框架能力案例与Starter业务分开维护，Starter不得绕过Stable API。

Starter常用命令：`npm run starter:verify`做静态检查，`npm run starter:dev`编译并启动本地all-in-one，`npm run starter:smoke`验证all-in-one与split-process，`npm run starter:character-smoke`专门验证创建角色、选角和稳定`characterId`。完整验收使用`npm run starter:acceptance`；`starter:acceptance:persistent`会验证DBProxy重启后的玩家快照恢复，`starter:acceptance:faults`会额外运行独立DBProxy故障矩阵。这三个验收命令都会先重建`target/debug/TiangZ`，不会误用旧的Rust运行时。持久化和故障命令会写入/重启本地测试资源，执行前先确认PostgreSQL、Redis和DBProxy环境。以上命令不包含长时间容量压测。

Starter当前的战斗快捷栏包含寒冰箭、火焰冲击、惩击、真言术·盾、真言术·韧、精神鞭笞和恢复。读条、引导、公共CD、施法距离、法力消耗、Buff刷新与伤害类型由配置和领域规则共同决定；恢复技能通过 `恢复` Buff 每3秒治疗一次，共8次。怪物掉落按每行独立概率判定，玩家可以把杂物出售给杂货商换取铜币，再购买红药和法力药水；Cocos3D的`2/3/Q`分别使用小红、大红和蓝药，移动端直接点击同一快捷栏。Cocos3D还提供“进入Boss副本”入口：Gate幂等创建Map 200动态实例，击杀试炼守卫后获得120累计经验，并可从尸体领取小红、大红、蓝药各5个和150铜币。每个角色进入后产生10分钟个人CD，截止时间由`progression`领域持久化并显示在副本按钮上；等级、经验和CD与Boss拾取事务都先经DBProxy确认。背包、任务追踪、Buff栏、技能图标、NPC商店和副本按钮是这条链路的主要可视化验收入口。

登录界面不再自动创建游客账号：第一次使用请点击“注册”，输入用户名、密码和确认密码；用户名会直接作为初始角色名。`all-in-one.json`的注册目录只在当前进程内存中，调试界面可用但重启会丢失账号。需要落盘和重启恢复时，先启动独立DBProxy，再使用`npm run starter:dev:persistent`，详细令牌和Docker步骤见[DBProxy玩家快照持久化](docs/tutorials/19-dbproxy-player-persistence.md)。

Demo 协议仍保留 `GetLoginServiceAddr` 这个产品层名字，含义是“获取登录服务器地址”，不是框架中的 Service 类型。

## 客户端 SDK

公共 TypeScript SDK 位于 `client_sdk/typescript/`。`Core` 只包含引擎无关的帧、RPC、Push、Update 队列、错误和 Transport 抽象；客户端协议生成代码只位于 SDK 的 `Generated/Model`。执行 `npm run codegen` 后，正式 SDK 会分发到 Cocos 与 Pixi 的 `Generated/SDK`，Bench 协议只留在规范 SDK 供压测工具使用，两个客户端不维护私有网络 Core。

公共 C++ SDK 位于 `client_sdk/cpp/`，Proto会生成不依赖Google protobuf runtime的结构、Codec和类型化RPC描述符；`npm run codegen:cpp-client-sdk`把完整头文件副本分发到UE插件。UE 5.4.4只负责WebSocket Adapter、游戏线程Update、坐标换算和Actor表现。当前UE Demo可自动登录Map 100、接收AOI/Numeric、5秒Gate Ping，并支持点击寻路、WASD方向移动和`E`键权威动态门，详见[UE 5.4.4客户端教程](docs/tutorials/14-unreal-engine-client.md)。Godot 4.7.1 Demo使用引擎自带`WebSocketPeer`接入同一主链，覆盖登录、Map 100、权威寻路、动态门、Ping和基础AOI，详见[Godot 4.7.1客户端教程](docs/tutorials/15-godot-client.md)。

公共 C# SDK 位于 `client_sdk/csharp/`，面向 Unity 和普通 .NET 客户端，不依赖 `UnityEngine`。`npm run codegen:csharp-client-sdk`会从协议锁生成消息、Codec、RPC/Push描述符和类型化 Client，并复制到 `client_demo/Unity2022.3.62f3c1_demo/Assets/TiangZClient/Runtime`；Unity Demo 的 `Assets/TiangZClient/Demo/TiangZUnityDemo.cs`只负责场景、输入、相机和表现。当前 C# Adapter 只实现桌面 WebSocket，TCP/KCP 必须明确报错，不能静默降级，详见[Unity 3D客户端教程](docs/tutorials/17-unity-client.md)。

```powershell
# 公共 SDK 真实 WebSocket 登录到进图
npm run smoke:client-sdk -- websocket 127.0.0.1 7000

# 启动20个机器人进入Map 1持续遛弯，Ctrl+C停止
npm run robot:walk -- 20 --map 1

# PixiJS/H5
npm run build:pixi
npm run serve:pixi
npm run smoke:pixi
```

Cocos Creator Web 构建统一使用以下命令。默认是 Release 构建；脚本会匹配工程对应的
Creator 版本、清除 `ELECTRON_RUN_AS_NODE`、清理标准输出目录并检查完整产物：

```powershell
npm run build:cocos3d:web
npm run build:cocos3d:mobile
npm run build:cocos3d:external
npm run check:cocos-build
```

外网发布使用`npm run build:cocos3d:external`，它会把桌面版整理到
`client_demo/cocos_client3D_3.8.8/build/external/desktop`（网站根路径`/`），把横屏移动版整理到
`build/external/m`（网站`/m/`）。根路径不能使用移动包；只有`/m/`使用`web-mobile`横屏构建。

2D 工程对应 `npm run build:cocos2d:web` 和 `npm run build:cocos2d:mobile`。编辑器预览仍使用
本地配置，发布包再使用外网配置。需要 Debug 包时，在对应命令后增加 `:debug`，例如
`npm run build:cocos3d:web:debug`。Cocos Native 需要先生成原生工程，然后单独使用
CMake/Visual Studio 编译；不要把 Native 编译和 Web 包构建混成一步。

### 外网演示部署

外网演示不在服务器上编译源码。先在本机或 Linux Builder 生成后端发布包，再把发布目录和 Cocos3D 静态包传到服务器。当前 2C2G 演示使用 [`external-multiprocess`](configs/deploy/external-multiprocess/StartMachine.json)：

```text
1 x LoginMgr
2 x Login
2 x Gate
2 x MapHost（Map 1、Map 2，各自独立进程）
1 x Location
2 x DBProxy（7800 首选、7801 故障切换）
```

动态副本节点和 MapManager 暂停在外网演示配置中。所有 TiangZ 进程只监听服务器回环地址；公网入口由 Nginx 统一转发，桌面 Cocos3D 使用 `/`，移动横屏包使用 `/m/`。登录链路的公网端口是 `17000`、`17001`、`17002`、`17201`、`17202`，具体映射和 systemd 约束见[外网部署配置](configs/deploy/README.md)与[Nginx示例](configs/deploy/cocos3d-nginx.conf.example)。

本机生成发布制品：

```powershell
# 后端 Linux x64 制品；推荐使用复用的 tiangz-linux-builder
npm run release:linux

# Cocos3D 桌面版与手机横屏版一起生成
npm run build:cocos3d:external
```

上传时使用：

- `dist/release/TiangZ-<version>-linux-x64/`：后端可执行文件、`dist/`、`configs/`、`navigation/` 和校验文件。
- `client_demo/cocos_client3D_3.8.8/build/external/desktop/`：Nginx 根路径 `/`。
- `client_demo/cocos_client3D_3.8.8/build/external/m/`：Nginx `/m/` 路径。

服务器端只需停止旧 Watcher/DBProxy、替换制品、启动两个 DBProxy 和新的 `StartMachine.json`，再执行 `nginx -t && systemctl reload nginx`。Redis/PostgreSQL 只绑定 `127.0.0.1`，不直接暴露公网端口；测试环境数据结构发生不兼容时，开发阶段可以清空测试库后重新注册，不为演示库保留兼容迁移。

RPC 使用生成的 `LoginMgrClient`、`LoginClient`、`GateClient` 和 `MapClient`；业务不手写 msgcode、rpcId 或 codec。服务端 Push 使用独立的 `@clientMessageHandler`，由 codegen 自动生成 Handler 导入入口。详细规则见 `client_sdk/typescript/README.md` 与 `docs/client_sdk_plan.md`。

## 游戏配置

`game_config/`是策划数值的唯一源目录，使用固定版本的[Luban](https://github.com/focus-creative-games/luban)从Excel生成服务端与客户端强类型配置。它和`configs/<environment>/`的Process、Scene、端口部署配置是两套完全不同的东西。

当前业务表包括`ItemConfig`、`MapConfig`、`PlayerConfig`、`MonsterConfig`、`MonsterAreaConfig`、`DropTableConfig`、`BuffConfig`、`SkillConfig`、`SkillEffectConfig`、`QuestConfig`和`QuestObjectiveConfig`。修改Excel后，如果准备重启服务器使配置生效，执行：

```powershell
npm run build:game-config:startup
npm run test:game-config
```

服务端从`app/generated/model/config`读取，客户端通过公共SDK的`Generated/Config`读取；业务统一使用`GameConfigs.XxxConfig.Get(id)`，不得解析Excel、JSON或手工编辑Generated。表结构属于不可热更Model；`npm run build:game-config:startup`会重新生成配置并覆盖启动目录`dist/game-config`，服务器重启时读取这个目录。`npm run build:game-config`只产生内容寻址候选`dist/game-config-candidates/<指纹>`，用于运行中的Watcher执行`reload-config <候选目录>`，不会更新启动目录。`npm run test:game-config`只做验证，不负责复制运行时配置。`MapConfig`、AOI和刷怪点属于冷配置，修改后必须重启；怪物模板中的数值当前也按冷配置发布，避免地图运行中改变已出生怪物的身份和生命周期语义。`npm run dev`会自动完成开发期候选构建。客户端配置仍随SDK发布，不会被服务端Reload远程替换。详见[游戏配置教程](docs/tutorials/10-game-config.md)和[怪物模块教程](docs/tutorials/16-monster-module.md)。

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
      },
      "nativeData": {
        "debugScalarAccess": false,
        "scalarAccessWarnThreshold": 10000
      }
    }
  },
  "scenes": [
    {
      "name": "login_mgr",
      "sceneType": "LoginMgr",
      "innerIp": "127.0.0.1",
      "port": 7000,
      "protocol": "auto",
      "audience": "mixed"
    }
  ],
  "knownScenes": [
    { "name": "login_mgr", "sceneType": "LoginMgr", "innerIp": "127.0.0.1", "port": 7000 },
    { "name": "login_1", "sceneType": "Login", "innerIp": "127.0.0.1", "port": 7001 }
  ]
}
```

- `process.name`：当前 OS 进程名称，一个配置文件只描述一个 Process/V8。
- `process.logging`：统一 Rust/TS 日志的级别、文本或 JSON 格式、控制台和滚动文件输出；默认 INFO 文本控制台。
- `process.network`：I/O Backend；默认 `epoll`，Linux 可显式选择实验性的 `io-uring`。
- `process.game`：固定游戏帧和最大补帧数；默认 `50ms/20Hz`、最多补跑 2 帧。
- `process.scheduling`：Runtime Pump 调度模式及队列参数；默认 `adaptive`。
- `process.lifecycle.stopTimeoutMs`：优雅停机等待上限，默认 10000ms。
- `process.lifecycle.hotfixReloadTimeoutMs`：Hotfix等待安全屏障的上限，默认30000ms；超时保留旧generation。
- `process.debug`：V8 Inspector 配置。该对象可省略；存在时必须设置 `inspectorPort`。远程监听还必须显式设置 `allowRemote: true`。
- `process.observability`：延迟采样、健康检查和Native Store诊断配置；`nativeData`只观测标量访问，不控制数据是否下沉。
- `scenes`：当前进程实际创建的入口 Scene。
- `knownScenes`：当前进程可路由的 Scene 目录，目标可以在其他进程；省略或为空时默认等于 `scenes`。
- `scene.innerIp`：服务间通信地址；旧配置中的 `ip` 仍可读取，但新部署配置应使用 `innerIp`。
- `scene.bindIp`：本机监听地址；云服务器通常使用 `0.0.0.0`，不能把它返回给服务或客户端。
- `scene.outerIp/outerPort`：客户端连接地址和端口。前端初始写死 LoginMgr 的公网地址，LoginMgr 返回 Login 的外网地址，Login 返回 Gate 的外网地址。
- `knownSceneFiles`：相对当前进程配置引用共享稳定Scene目录；本地拆分部署统一使用`configs/local/cluster/known-scenes.json`，避免每个进程复制`knownScenes`。
- `staticMapIds`：只写在实际承载地图的`MapHost`的`scenes`项中；启动时创建这些静态地图，且静态`MapInstanceId`等于配置ID。`knownScenes`路由副本不重复填写。
- `acceptDynamicMaps`：MapHost是否向MapManager注册并接受动态副本；默认false。空载副本Host使用空`staticMapIds`和true。
- `MapManager`：动态地图单例调度Scene。各MapHost把它加入`knownScenes`后主动注册；Manager不需要静态列出将来扩容的MapHost。
- `scene.protocol`：`auto`、`tcp`、`websocket` 或 `kcp`；默认 `auto`。
- `scene.audience`：`mixed`、`inner` 或 `outer`；默认 `mixed`。
- `StartMachine.json`：按机器 IP 启动多个进程配置文件。正式环境放在 `configs/<environment>`；压测、自动测试和传输实验分别放在 `configs/bench`、`configs/tests`、`configs/experiments`。

把 `all-in-one.json` 拆成多个配置时，只改变 `scenes` 的部署归属；`knownScenes` 中目标的 name/type/innerIp/port 保持一致，业务调用代码不改。`bindIp` 只影响本地监听，`outerIp/outerPort` 只影响客户端登录链路。

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
npm run dev -- configs/local/cluster/StartMachine.json
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
- `client_demo/cocos_client2D_3.8.6/assets/scripts/Generated`：Cocos 客户端协议和 Handler 入口。

所有 Generated 文件都不应手工编辑。`npm run codegen` 会同步更新根目录 `codegen.manifest.json`；Developer Tools 使用该文件检查生成结果是否过期、缺失、遗留或被修改。

## VS Code 开发工具

TiangZ 目前有两个职责独立的 VS Code 插件，均尚未发布到 Marketplace：

- [TiangZ Native Language](https://github.com/moulo1982Google/tiangz-native-language)：为 `.native` 提供高亮、诊断、补全、Hover、跳转、格式化与 codegen 命令。语言核心和无文件系统依赖的 codegen-core 也由该仓库提供；主工程当前使用 `v0.15.0`。
- [TiangZ Developer Tools](https://github.com/moulo1982Google/tiangz-developer-tools)：索引Environment、Machine、Process、Scene、Session、Unit、Component、System与Handler，在资源管理器显示“TiangZ工程”，提供源码跳转、Problems诊断、CI工程检查和定向代码生成。主工程固定使用`v0.15.0`，并通过`verify:design-rules`确保设计核心与`docs/patterns`规则ID、归属文档保持一致。

两个插件分开维护，未来可以通过 Extension Pack 一键安装。当前需分别克隆仓库，执行 `npm install`、`npm run check` 和 `npm run package:extension`，再从各仓库 `dist` 目录安装 VSIX。

Developer Tools 的工程检查器已经作为固定 Git Tag 依赖接入主仓库。编辑器 Problems 与命令行共用同一套规则：

```powershell
npm run check:project
npm run check:project -- --format json
```

设计Item、Buff、Quest、Achievement、Numeric或自定义业务系统时，先阅读[`docs/patterns`](docs/patterns/README.md)，也可以在Developer Tools执行“TiangZ：设计业务系统”或输入`@tiangz /design buff`。规则库先确定所有权、Entity形态、生命周期、Audience和同步语义，AI只负责解释；最终仍以当前代码、项目检查和测试为准。

新增技能优先维护`game_config/Datas/SkillConfig.xlsx`与服务端专有的`SkillEffectConfig.xlsx`，用现有Action和Buff组合效果，不为每个技能复制Handler。完整步骤见[配置化技能教程](docs/tutorials/18-configured-skill.md)。

任务使用`QuestComponent -> Quest ChildEntity`保存活动状态；击杀、用道具和进图模块只同步发布领域事实，稳定事件Handler负责投影进度。任务默认仅同步给拥有者，领取奖励复用Action，不把背包逻辑写进任务Handler。完整设计与代码示例见[任务系统设计](docs/design/quest-system.md)。

## 调试与验证

```powershell
npm run build:debug
cargo run -- configs/local/debug/login-1.json
```

一个 Process 对应一个 Inspector。详见 [TypeScript 调试](docs/typescript_debugging.md)。日常开发先使用快速质量门，并单独查看锁漂移报告：

```powershell
npm run verify:fast
npm run verify:locks:warn
npm run verify:quick
```

修改协议、进程通信、mailbox、背压或生命周期后，合并前执行完整质量门：

```powershell
npm run verify
```

`verify:codegen` 根据 `codegen.manifest.json` 只读校验输入、输出哈希和生成文件集合。新增 protobuf 消息评审编号后执行 `npm run codegen:proto:update-lock`；普通 codegen 不会静默接受新 opcode。手写函数的注释要求见 [代码注释约定](docs/reference/coding-conventions.md)。

开发期的 `verify` 不强制版本、依赖、协议和 Stable Core API 锁定，方便持续调整契约；准备发布 Release 时必须执行：

```powershell
npm run verify:release
```

该命令会把开发期的报告项提升为失败项，并在发布前统一检查版本、依赖锁、协议锁、Stable Core API、生成物和完整测试。

## Linux Release构建

本机Docker Desktop使用固定的`tiangz-linux-builder:ubuntu-24.04`工具镜像生成Linux x64发布包。首次运行会安装Node、Rust、.NET Runtime、Luban和项目依赖；后续只复制当前源码并重新执行Luban表格生成、全部codegen、TS构建和Rust Release编译：

```powershell
npm run release:linux
```

发布包输出到`dist/release/TiangZ-<version>-linux-x64`。只有依赖锁、Rust工具链、Luban或Builder Dockerfile变化时才自动重建工具镜像；Cargo构建结果保存在`tiangz-linux-builder-target`命名卷中复用。`npm run release:linux:image`只准备或检查镜像，`npm run release:linux:rebuild-image`用于显式修复工具镜像。

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
npm install
npm run perf:rpc-baseline
```

使用 nvm 安装 Node 时不要加 `sudo`。`sudo` 默认看不到用户目录中的 npm，并会产生 root 所有权的构建文件。开发阶段压测入口会自动识别缺失或来自其他操作系统的 `node_modules`，并通过 `npm install` 重建；正式发布时再使用锁文件安装。

命令会自动构建 Release、启动 `BenchScene`、完成 64B 到 16KB 的 RPC 测试、关闭 Runtime，并在 `perf/results` 生成 Markdown、JSON 和服务日志。Windows 使用同一条 `npm run perf:rpc-baseline` 命令。

如果不希望把源码放到被测机器，先在本机或 CI 生成独立基准制品：

```bash
npm run perf:package
```

把 `dist/benchmark/TiangZ-rpc-benchmark-<版本>-<平台>-<架构>` 整个目录复制到目标机器后，目标机器只需要 Node.js 20+：

```bash
npm run perf:rpc-baseline -- --skip-build \\
  --warmup 10 --duration 60 \\
  --connections 8 --concurrency 512
```

制品不包含源码、`node_modules`、Rust 工具链或 Cargo 缓存；必须在与目标机器相同的平台和架构上构建。

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

## 开源协议

TiangZ 使用 [Apache License 2.0](LICENSE) 开源，版权归 2025-2026 郑昕 所有。分发或修改本项目时，请同时保留 [NOTICE](NOTICE) 中的版权与归属声明。
