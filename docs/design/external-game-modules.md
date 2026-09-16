# 外置游戏模块

更新时间：2026-09-15。当前宿主开发基线：`0.6.0-alpha.0`。

## 宿主装配模式

2026-09-16：`modules:create` / `project:create` 支持 `--with-rust` 生成 Native 扩展壳。独立工程显式 setup/check/host-build/build/start/smoke 已接入组合构建与二进制校验；自动 dev 仍不支持 Native。参见[入门教程](../tutorials/module-starter.md)。只有 op、没有具体实体的 schema 保留生成器要求的抽象 Entity 根，不输出无意义的 Rust 实体 Store。

当前工作重点是完善 TiangZ 的通用开发流程；SLG 仅作接入验证，不以增加 SLG 玩法代替框架改进。

`--host-profile modules` 选择只装配 Core 和显式外置模块的 TypeScript 宿主，也是当前默认且唯一支持的模式；旧 `demo` 明确报错。宿主通过 `ProcessBootstrap` 提供进程生命周期、事件投递、出站打包和 Hotfix 屏障。

在 TiangZ 根目录执行（路径仅为示例）：

```powershell
node tools/create_game_module.mjs --id org.example.game --path ../MyGame/modules/game --host-profile modules
node tools/prepare_game_modules.mjs --modules-dir ../MyGame/modules --host-profile modules
node tools/typecheck_game_modules.mjs --modules-dir ../MyGame/modules --host-profile modules
node tools/build_runtime_bundles.mjs --modules-dir ../MyGame/modules --out-dir ../MyGame/dist --host-profile modules
node tools/build_game_config_data.mjs --modules-dir ../MyGame/modules --out-dir ../MyGame/dist --initial
```

业务 Scene、模块协议和配置仍按下文定义及生成；空脚手架不自带可运行游戏 Scene。启动沿用显式 `--runtime-root` 与游戏自己的进程配置。

新手应优先使用 `npm run project:create -- --path ../MyGame --id org.example.game` 创建可运行教学工程，而不是从空模块拼接启动流程。工程通过 `tiangz.project.json` 和宿主通用工具保持上述模块/宿主模式一致；详见[模块入门工程](../tutorials/module-starter.md)。

- `modules` 模式不注册内置 Scene、不装配 MMORPG Hotfix、不公开 `NpcUnit/PlayerUnit` 等示例类型；`#tiangz/model` 对应宿主 Model/Core/通用领域稳定契约。脚手架、编辑器 paths、类型检查和 Bundle 构建使用同一个模式。
- 构建器在发布前检查类型和实际打包输入，禁止带入 MMORPG 和内置配置；选择错误的模式会明确报错，不静默兜底。
- 配置仍使用现有 Rust 校验的数据包信封：内置表为空，模块表继续由 ModuleConfigRegistry 校验并提交，不新增数据库或第二套配置系统。
- `buildMode=modules` 同时进入 Model/Hotfix 清单及源码指纹；切换模式必须成对构建并重启。Hotfix-only 命令也必须带相同的 `--host-profile modules`。
- Rust 宿主也不再注册内置 MMORPG ops；模块通过 Native 组合构建提供扩展，保留 Native 指纹和二进制哈希检查。
- `dev_runtime.mjs --project <工程目录>` 读取 tiangz.project.json，TS 模块复用同一 Watcher/候选发布循环；创建的入门工程通过 `npm run dev` 调用。旧 demo 宿主已移除，默认且唯一受支持的装配模式为 modules。该入口目前拒绝 Native 组合模块，不冒充生产部署工具；Model/协议/模块或启动配置变化提示停止并重启，不自动迁移或清空状态。

框架验收使用 `npm run test:module-host`：生成不含 SLG 内容的最小模块，检查独立构建、真实进程启停、内置 Scene 拒绝、示例类型误用和跨模式 Hotfix 拒绝。该项已加入完整 `npm run verify`。

TiangZ 的模块机制用于让一个独立游戏或功能包复用同一 Runtime，而不把领域源码放进 `app/core`。模块是构建与发布单元，不是新的 Actor 类型，也不是绕过 Scene、mailbox、Hotfix 和 DBProxy 边界的插件后门。

## 借鉴与取舍

AzerothCore 允许把独立仓库放入 `modules/`，在构建期发现模块，通过 loader 和 Script Hook 扩展行为，并携带独立配置。官方文档同时说明安装模块需要重新配置、编译和重启。TiangZ 借鉴这些稳定经验：

- 独立目录或仓库；
- 构建期发现和统一组合入口；
- 模块自己的版本、依赖、能力和配置边界；
- Core 提供扩展点，领域模块不修改 Core。

TiangZ 不照搬任意 CMake、Bash 或 SQL 安装 Hook。模块不能在发现阶段执行脚本，数据库变更也不能绕过 DBProxy 和显式迁移流程。参考：[AzerothCore Modular Structure](https://www.azerothcore.org/wiki/the-modular-structure)、[Create a Module](https://www.azerothcore.org/wiki/create-a-module)、[Installing a Module](https://www.azerothcore.org/wiki/installing-a-module)。

## 安装与发现

默认扫描 `modules/` 的直接子目录；每个目录必须包含 `tiangz.module.json`。第三方目录被主仓库忽略，可以是独立 clone，也可以是指向独立工作区的目录链接。测试或组合构建可以显式指定另一个父目录：

```powershell
npm run modules:list
npm run modules:validate
npm run modules:typecheck
npm run modules:create -- --id org.example.greeting --path modules/greeting
npm run modules:codegen-config -- --module-root modules/greeting
node tools/build_runtime_bundles.mjs --modules-dir ..\game-modules
$env:TIANGZ_MODULES_DIR='..\game-modules'
npm run dev
```

模块目录被发现后不能静默跳过错误：缺 manifest、重复 ID、未知字段、路径逃逸、版本不兼容、依赖缺失或循环依赖都会在构建前失败。
模块根联接解析后，源码、协议输出和编辑器 paths 均以真实源码目录为基准；安装目录仅保留为 installedRoot，用于识别安装位置。相同模块换一个安装深度不应改写生成导入或依赖路径。模块内部的文件/目录联接仍受原有安全限制。
每个模块还必须提供自己的`tsconfig.json`；普通构建和Hotfix候选都会先独立类型检查全部已安装模块。`TIANGZ_MODULES_DIR`让构建、目录工具和开发宿主使用同一模块集合，开发宿主也会监听这些模块声明的Hotfix源码根。

## 代码模块与运行时数据包

代码模块描述“如何运行”，运行时数据包描述“运行哪些资料”。一个模块可以拥有任意多个数据包；增加地图切片、关卡或区域资料不应复制模块Model/Hotfix入口。部署配置通过`process.dataPacks.sources`指定文件或目录，路径相对当前Process配置文件解析。目录递归发现的文件必须命名为`runtime.pack.json`：

```json
{
  "formatVersion": 1,
  "id": "org.example.greeting.content.starter",
  "ownerModuleId": "org.example.greeting",
  "contentHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "source": "catalog:v1:starter",
  "payload": { "selection": { "sceneType": "Example" }, "entries": [] }
}
```

宿主在V8和Scene创建前完成确定性发现、单包/总量限制、严格信封解析、重复ID、符号链接与哈希格式校验，并追加实际文件的`fileHash`。Core随后验证所有者已存在于封闭模块图、ID使用所有者命名空间、payload是无环纯JSON树，并深冻结整个目录。`RuntimeDataPackRegistry.Instance.List(moduleId)`和`Get(id)`是Stable只读入口；Core不解释selection和payload schema，也不负责把资料变成Entity。所有者模块仍须通过目标领域的Profile/Factory做原子装配和引用校验。

当前数据包随Process启动全量载入，改变后必须重启；它不是热更新入口。数据包不能执行代码、SQL或安装Hook，也不能保存玩家和世界事件等可变权威状态。海量全世界资料后续应以同一信封和指纹语义扩展分区/provider，并通过DBProxy或独立内容服务读取，而不是让Scene直接连接数据库。

### 模块自有 Luban 配置

外置游戏模块可以在自己的仓库中声明一份 Luban 工程。Core 只提供固定版本编译器、路径安全校验、确定性输出和指纹，不认识模块的表名与字段：

```json
"gameConfig": {
  "project": "game_config/luban.conf",
  "target": "server",
  "generatedCode": "src/hotfix/generated/config",
  "generatedData": "game_config/generated"
}
```

`project`和两个输出目录都必须位于模块根内，`generatedCode`还必须位于声明的Hotfix源码根内。执行`npm run modules:codegen-config -- --module-root <模块目录>`会调用Core固定的Luban版本，开启`validationFailAsError`，生成模块自己的`schema.ts`、`fingerprint.ts`、聚合`server.json`和`module-game-config.manifest.json`；追加`--check`只验证提交/构建产物没有过期。生成清单同时记录schema、数据与源文件SHA-256。

这不是第二套配置系统。宿主`game_config/`与模块`game_config/`使用同一Luban编译能力，只是schema所有权和发布范围不同：宿主内置信封为空，游戏表全部属于对应模块。模块应使用生成的`Tables`解析自己的payload，再投影到Core已有的中立Profile；不得把原始导入JSON直接强转为业务类型。`RuntimeDataPack`仍然只是部署信封，负责发现、所有权、大小、哈希和冻结，不取代Luban schema。来源数据库、Excel或第三方服务器导入器只负责产出模块Luban源数据，不能成为运行时格式。

模块配置 schema 改变后必须重新生成、完整构建并重启 Process；同 schema 的数据更新可通过完整配置候选走既有 `reload-config`，详见下文“配置导出与运行时更新”。这与启动时载入、仍需重启的 `RuntimeDataPack` 不同；已捕获的数据快照也不会自动更新。

## Manifest v1

只使用 TypeScript 客户端的模块可在 `protocol` 中设置 `"generateGodot": false`。省略或设为 true 保留原双 SDK 生成行为；false 时不生成、不检查、不发布 Godot 输出，产物清单不再列出 Godot。关闭不会自动删除旧目录，避免误删用户文件；确认不再使用后单独归档。该选项进入模块图，切换后须重新生成、构建并重启。

```json
{
  "formatVersion": 1,
  "id": "org.example.greeting",
  "version": "1.0.0",
  "description": "Example module",
  "engine": {
    "minVersion": "0.6.0-alpha.0",
    "maxVersionExclusive": "0.7.0"
  },
  "dependencies": [],
  "capabilities": ["example.greeting"],
  "entries": {
    "model": "src/model/index.ts",
    "hotfix": "src/hotfix/index.ts"
  },
  "gameConfig": {
    "project": "game_config/luban.conf",
    "target": "server",
    "generatedCode": "src/hotfix/generated/config",
    "generatedData": "game_config/generated"
  }
}
```

依赖使用 `[minVersion, maxVersionExclusive)`，加载顺序是稳定拓扑序，同层按模块 ID 排序。模块图采用规范 JSON 和 SHA-256 进入 Model/Hotfix 冻结契约；增删模块、改变版本/依赖/manifest 或修改模块 Model 后，`build:hotfix`会拒绝并要求完整部署、重启 Process。

## Model 与 Hotfix 入口

Model 入口只在不可变 Model Bundle 装载时执行，通过 Stable Core API 显式登记：

```ts
import { Component, component, defineGameModule } from "#tiangz/core";

@component()
export class GreetingComponent extends Component {
  protected count = 0;
}

export interface GreetingComponent {
  Increment(): number;
}

defineGameModule({
  id: "org.example.greeting",
  version: "1.0.0",
  modelExports: { GreetingComponent },
  requiredSystems: [GreetingComponent],
});
```

Hotfix 入口是显式 loader，导入本模块的 System 与 Handler。它只从 `#tiangz/model` 取得 TiangZ 稳定 Model，从 `#tiangz/module` 取得本模块登记的不可变 Model 导出：

```ts
import { systemFor } from "#tiangz/model";
import { GreetingComponent } from "#tiangz/module";

@systemFor(GreetingComponent)
class GreetingComponentSystem extends GreetingComponent {
  override Increment(): number {
    this.count += 1;
    return this.count;
  }
}
```

模块 Model 的相对导入只能留在声明的 `modelRoots`，Hotfix 相对导入只能留在 `hotfixRoots`，入口本身也必须位于对应声明根内。源码树内不允许符号链接；模块根本身仍可作为指向独立工作区的目录链接。Hotfix 深层导入 Model/Core 会在静态门禁和 bundle 阶段失败。模块不保存模块级可变业务状态；状态仍属于 Scene、Entity 或 Component。

## 强类型 Entity 装配

模块需要给现有稳定Entity增加Component时，使用Core的强类型装配器，不修改目标工厂的领域源码，也不注册无类型字符串Hook：

```ts
import {
  entityExtensionHandler,
  type EntityExtensionHandler,
} from "#tiangz/model";
import { GreetingCounterComponent, GreetingEntity } from "#tiangz/module";

@entityExtensionHandler(GreetingEntity, { id: "org.example.greeting.counter" })
class GreetingEntityExtension implements EntityExtensionHandler<GreetingEntity> {
  Attach(entity: GreetingEntity): void {
    entity.AddComponent(GreetingCounterComponent);
  }
}
```

目标领域的Entity工厂在实例尚未发布时调用`applyEntityExtensions(entity)`。装配同步、按`order/id`确定顺序、每个Entity只成功执行一次，并进入Hotfix完整绑定集合；增加、删除或重命名装配器需要完整重启。失败由调用方现有工厂回滚整个Entity，Core不保存模块业务状态。可迁移Component仍须显式`@transferable()`，持久化仍须经过领域Repository和DBProxy。

玩家的模块私有长期状态可以通过`PlayerPersistenceComponent.RegisterPersistenceExtension`注册同步的`Capture/Restore`钩子。每个钩子只提交稳定命名空间、正整数版本和不透明`Uint8Array`；TiangZ把这些值作为runtime快照的一部分做校验、复制、Revision/CAS和重启恢复，不解释其内容。未装载的模块ID会在再次保存时原样保留，避免滚动部署丢数据。模块仍须自行实现版本迁移、业务不变量和跨地图`@transferable()`状态；该入口不等同于跨玩家事务，也不允许把来源游戏字段加入Core。

当前MMORPG领域把这一边界应用到`MapScene`、`PlayerUnit`、`MonsterUnit`、`NpcUnit`、`InteractableUnit`和`SummonedUnit`。地图扩展发生在`MapRuntimeProfileComponent`装入默认冷配置之后、AOI与地图空间创建之前；怪物扩展发生在`MonsterSpawnProfileComponent`装入默认Area坐标之后、首次定位和AOI发布之前；NPC与可交互物扩展发生在基础身份、位置、静态资料和运行时内容增量装配完成之后，但一定早于领域索引与AOI发布。任何扩展失败都由原工厂移除整个Unit，不能留下已发布的半成品。模块给NPC组合`NumericComponent`时，NPC快照会自动使用同一中立数值复制策略；没有该组件的普通服务型NPC仍返回空数值集。外置模块只提供经过校验的资料，TiangZ仍拥有空间实现、刷怪生命周期、追击与回巢语义。每份可覆盖资料最多接受一个外部所有者，冲突必须失败，不能把模块加载顺序当作内容优先级。

客户端表现同样保持边界：`UnitPresentation`提供`AOI`和玩家`Self`两种逻辑受众，并允许模块以自身命名空间键发送不透明`Extension`表现。Core只验证Unit、目标和受众，不认识外部协议字段；具体客户端适配器决定是否及如何投影该键。模块协议由自己的 Proto、锁文件和客户端 SDK 生成链路负责，Core 只组合并注册服务端描述符。

需要批量装入地图怪物内容时，`MapHost`还会在同一阶段创建`MonsterContentProfileComponent`。模块以稳定所有者ID原子登记模板和刷点；同一登记中的刷点只能引用本所有者的模板，重复ID、跨所有者引用或无效数值会在任何资料发布前失败。完整内容包可以由唯一所有者调用`ReplaceColdContent`，避免与演示冷刷点混合；装配完成后`Seal`禁止运行期改写。`MonsterComponent`随后统一消费冷配置和目录资料，继续拥有Unit、AOI、战斗、尸体和重生。刷新周期位于刷点，允许同一模板的不同槽位采用不同周期。名称与模型ID在Unit创建时从已解析模板冻结，AOI快照不再回查只覆盖演示内容的Luban表，因此外部定义ID不会形成第二条隐式配置依赖。中立Training Dummy自测证明该能力不依赖具体游戏数据库或编号。

模板还可以提供按玩家等级预计算的`rewardExperienceByPlayerLevel`。Core验证并冻结曲线，在怪物死亡事实提交后只负责选择奖励、进入玩家mailbox和复用持久化Progression事务；来源游戏的经验公式与客户端通知格式分别属于内容生成器和协议适配器。幂等事务必须区分稳定刷点与本次怪物生命周期，防止复活刷怪被误判为同一次奖励。

刷点还可声明协议中立的脱战空闲序列：初次/重复延迟使用服务端确定性选择，动作按相对延迟执行，并可让同一内容所有者的另一个稳定刷点实体播放表现。目标刷点不存在或跨所有者时整批登记失败；进入战斗会丢弃当前空闲执行进度，回归后重新初始化。来源引擎的事件号、动作号、GUID和定时动作表只能由外置适配器解释，不能出现在TiangZ内容契约或运行日志中。

地图扩展还可以为Grid2D声明`externalMovementSnapshots.maxDeltaMeters`，供已有协议网关提交完成客户端场景碰撞后的局部位置。该声明只改变TiangZ接受何种移动输入，不把客户端协议、地图原点或具体跑速带入主工程；PlayerUnit与Rust仍拥有边界、序号、位移上限、AOI和持久化。没有声明时位置字段必须被拒绝，NavMesh3D不支持这一兼容模式。

MMORPG地图在执行`MapScene`装配器前创建`SkillDefinitionProfileComponent`。模块可以用自己的ID登记完整、只读的`SkillDefinition`，`SkillMapComponent`仍统一执行目标、距离、CD、Action、Combat和AOI；外置定义不能覆盖Luban冷配置，也不能按加载顺序覆盖另一个模块。资料保存在地图Component中，不允许模块级可变目录。运行时数据包解决了通用发现、信封、所有权与冻结，但具体表schema、跨表引用、客户端导出和内容迁移仍由模块及其导入工具负责。

召唤物同样由中立`SummonComponent`持有所有权槽、Unit生命周期、AOI、跟随和协战；模块只提交冻结的`OwnedSummonDefinition`。同进程地图传送直接携带`OwnedSummonTransferState`，跨Process则由通用`PlayerTransferSnapshot.owned_summons`编码同一组数值，在目标地图重建新的临时Unit。两种传送都只恢复所有权槽、创建能力和冻结定义，目标、位置、Native句柄和战斗中间态不会跨地图复制；目标槽位必须为空，任一候选创建失败会回滚本批召唤物与未发布Owner。重新登录持久化仍未纳入 v1，不能把临时召唤物误写入玩家持久快照。

## 生命周期和热更

```text
安装/删除模块、Model、依赖图变化
  -> 完整构建 Model + Hotfix
  -> Process 重启

模块已有 System/Handler 的纯行为变化
  -> Hotfix candidate
  -> 现有排空、预检、事务提交和回滚
```

即使构建使用 `--hotfix-entry` 替换主 Hotfix 入口，构建器仍会在外层组合所有已安装模块的 Hotfix loader；自定义入口不能绕过或意外丢失模块绑定。中立构建夹具和正式 Hotfix 操作验收都会覆盖这一点。

模块没有通用 `onLoad/onUnload` 业务回调。Process、Scene、Entity 和 Component 已经提供确定的生命周期；再增加一个任意模块回调会制造第二套所有权。新增/删除 Handler 同样属于冻结路由集合变化，不能伪装成 Hotfix。

## 模块自有 Protobuf 与客户端 SDK

### 开发工具保障（2026-09-15）

`modules:typecheck` 还会核对模块 Hotfix 从 `#tiangz/module` 的命名值导入是否出现在入口的 `defineGameModule.modelExports` 中；缺失时报告文件、行号和名称。仅用于类型的值应显式使用 `import type`。这项检查覆盖入口中可识别的注册调用和命名导入；间接注册、动态访问仍依赖运行时验证。

`npm run modules:prepare -- --modules-dir <目录>` 根据当前宿主和直接依赖同步模块 `tsconfig.json` 的 TiangZ paths 与宿主方法声明，使普通 TypeScript/编辑器也能解析跨模块公开 API。命令保留其他配置项；当前要求严格 JSON，遇到 JSONC 会明确拒绝，避免丢失注释。追加 `--check` 只检查配置是否需要同步。切换宿主、添加或删除依赖后重新运行；运行时和构建仍独立校验依赖权限。

模块协议生成先在模块内的临时目录完成所有输出和锁候选，再验证整个模块集合的 opcode。`codegen:module-protocol -- --check` 比较实际产物，不修复过期文件，也不修改锁。正常生成仅替换有变化的目标；发布失败恢复旧产物和锁，回滚失败时保留临时备份并报告路径。该机制提供命令失败回滚，不提供进程崩溃或多个并发生成命令间的事务保证，应串行运行生成命令。

协议源目录与两个锁文件名均使用 manifest 声明。服务端输出不能覆盖 Model 根、模块入口或已有手写文件；客户端输出不能覆盖 Model 源码。生成目录是生成器专有目录，不应存放业务文件。

`npm run dev` 会监听模块 Luban 工程所在目录，忽略声明的配置生成目录，生成模块配置后与宿主配置一起构建候选。schema 变化仍要求完整构建和重启。工程目录以外的额外输入应通过显式生成命令处理。

模块可以在 `tiangz.module.json.protocol` 中声明自己的 Proto 源目录、opcode/schema 锁、服务端生成目录、TypeScript 客户端 SDK 目录和 Godot 输出目录：

```json
"protocol": {
  "source": "proto",
  "opcodeLock": "proto/opcode.lock.json",
  "schemaLock": "proto/schema.lock.json",
  "serverOutput": "src/model/generated/protocol",
  "typescriptOutput": "generated/typescript",
  "godotOutput": "generated/godot",
  "godotClassName": "WastelandProto"
}
```

`npm run codegen:module-protocol` 会逐模块调用宿主固定版本的 Proto/Godot 生成器。服务端描述符和 Codec 留在模块 Model 源码根，客户端 TypeScript 与 Godot GDScript 留在模块自己的输出目录；宿主只负责把模块描述符注册进 Model bundle，不读取模块字段，也不把模块文件写入 `app/core`。opcode 锁和 schema 锁由模块提交并参与完整构建指纹，模块 opcode 还会和宿主及其他模块做全局冲突校验。

新消息先在模块 Proto 中追加，再执行 `npm run codegen:module-protocol:update-lock`；日常构建使用严格锁校验，锁不一致会在生成阶段失败。生成的 `protocol.manifest.json` 记录源文件、锁指纹和输出位置，`--check` 不会更新锁。

## v1 明确边界

既有 v1 提供 TypeScript Model/Hotfix 模块图、版本与依赖校验、独立类型检查、显式入口、不可变导出桥、强类型 Entity 装配、模块指纹、模块自有 Luban 工程与 Protobuf/SDK，以及宿主校验的运行时数据包。本轮扩展的具体接口如下；实际验收状态以[模块化推进记录](module-completion-plan.md)为准。

### 跨模块 API

`"publicApi": "src/model/public.ts"` 声明 Model 源码根中的公开文件。消费者在 dependencies 中声明直接依赖和版本窗口，然后使用 `import { Counter, type Options } from "#tiangz/modules/org.example.provider"`。未声明依赖、传递依赖和深层路径被类型检查与构建拒绝。公开入口只导出稳定类型和不可变常量；有状态服务仍由 Scene/Entity/Component 拥有。Hotfix 读取公共 Model 桥，不复制 Provider 的 Model。公开 API 属于 Model 源码指纹，改变它必须重建重启。

### 配置导出与运行时更新

gameConfig 可增加 `client` 对象：`{ "target": "client", "generatedCode": "generated/client/config", "generatedData": "generated/client/data" }`。客户端 target 必须在模块 Luban 工程中显式选择客户端分组，生成器不会把服务端 JSON 直接复制给客户端。

Godot 客户端同步脚本会把每个模块的协议 SDK 和客户端配置复制到 `client/godot/generated/modules/<sanitized-module-id>/`，并写入 `.module-sdk-manifest.json`。清单记录模块 ID、版本、目录、协议类名和是否有客户端配置；每次同步都会清理生成根目录中不属于当前模块集合的旧目录，并拒绝模块 ID 清洗后产生的目录冲突。该目录属于生成物，客户端不得直接编辑。模块卸载后若业务仍硬编码加载该模块，Godot 应在加载阶段明确失败，而不是继续使用陈旧 SDK。

完整构建包含 `codegen:module-config`。模块配置 schema 固定在 Model 中，`build:game-config` 将所有模块数据打包进同一个候选，与既有 `reload-config <candidate>` 一起验证和发布。通过 `ModuleConfigRegistry.Get(moduleId).tables` 读取不可变原始表，也可由模块自己的 Luban Tables 构造领域视图。候选必须包含完整模块集合；任一模块数据验证失败，原目录保持不变。客户端导出独立分发，不由服务端热更自动推送客户端。

配置跨 schema 的处理是重新生成 Tables、构建和重启；不能把新 schema 塞进旧 Model。已捕获的领域 Profile/快照不会自动更新，消费者明确决定何时重读并投影配置。

### 持久化版本迁移

`VersionedEntityCodec` 可声明 `migrations: [{ fromVersion: 1, toVersion: 2, Migrate(payload) { ... } }]`。每一步把旧版字节转换为下一版本，必须同步、确定性、无外部副作用；若 payload 内含版本字段，同样由该转换升级。生成 Codec 可在模块 Model 中通过对象展开添加迁移声明，无需修改生成文件。

Repository Load 遇到旧版本时先完整转换和 Decode 校验，再用原 revision CAS 保存；并发冲突重新加载权威数据，未知或未来版本拒绝。Save 的不明确回执沿用既有同 requestId 重试。这里迁移的是 DBProxy 通用记录 payload，不执行数据库 DDL，也不枚举全库；批量迁移调度和停服窗口由部署方管理。升级写入后，旧版 Codec 会拒绝新版本，不能把代码回滚等同于数据可逆。

### Native 模块

Native 扩展返回宿主 `deno_core::Extension`，因此必须使用 Cargo 解析出的同一个 deno_core crate，只有版本字符串相同仍不够（不同来源的 crate 具有不同 Rust 类型身份）。组合构建在编译前检查每个模块及其正常依赖的实际图；不兼容时报告模块 ID、模块版本与宿主版本，要求调整模块 Cargo.toml 并重新解析组合锁，不自动改依赖。测试模板读取宿主 Cargo metadata 的依赖要求，避免宿主升级后仍生成旧版本扩展。

```json
"native": {
  "source": "native",
  "crate": "rust",
  "crateName": "example_native",
  "generatedRust": "rust/src/generated",
  "generatedTypeScript": "src/model/generated/native"
}
```

模块 crate 的 `lib.rs` 声明 `pub mod generated; pub mod native_data; pub use generated::{extension, BOOTSTRAP};`，在 `native_data` 中实现生成 ABI 引用的 op。生成器提供原生类型、池布局和 TypeScript 句柄；具体 Store 的生命周期由 crate 实现，仍须保证 generation/释放语义。Rust 扩展在进程创建时装入，同名 op 使用模块 ID 隔离。`codegen:module-native` 使用宿主固定生成器，`build:module-native` 通过临时 Cargo 清单静态组合宿主与模块 crate，不更改宿主 Cargo.toml。模块 crate 不得声明自定义 build script；普通依赖仍走 Cargo 锁文件。`--check` 只检查编译，正式构建不传该参数。使用构建器报告的二进制启动对应 Model；身份不符在启动时拒绝。

### 模块部署边界

模块安装、升级、删除修改构建期模块集合：先准备完整依赖目录，执行目录验证、codegen、模块类型检查和完整 Model/Hotfix/Native 构建，再以版本化目录部署并优雅重启进程。缺少被依赖模块时不能构建。保留旧制品用于回滚，但有持久化迁移时必须另行验证旧版本读兼容性。运行期 Model reload、改变冻结路由或卸载已有对象类型不提供接口；这是 AGENTS.md 的硬边界，不是一个待补的热更开关。

`npm run release:package` 读取 `TIANGZ_MODULES_DIR`，自动选择组合 Native 构建；首次组合先用 `build:module-native -- --check` 生成临时工作区及锁，发布编译要求 `--locked`。制品携带模块图、二进制 SHA256 和组合 Cargo.lock。完整配置、Model、Hotfix 与 Native 身份不一致时拒绝打包，默认在临时制品目录运行冒烟，成功后才发布带内容摘要的最终目录，不覆盖旧制品。`--debug` 用于开发验收；没有这个参数时是 release 配置。部署操作仍使用现有 Watcher/服务管理流程切换工作目录并优雅重启，不自动操作运行中的其他游戏。

生成器会先准备所有输出，再替换模块声明的目录；某个输出失败则恢复已替换目录，遗留文件会在成功生成时移除。完整 Model/Hotfix 编译也会先完成编译再写 Model，避免 Hotfix 编译失败破坏旧 Model。发行制品的最终目录只在完整打包成功后出现。

独立工作区可先将完整 bundle 构建到自己的目录，再使用 `release:package -- --skip-build --bundle-dir <目录>` 打包；该目录需要包含 Model/Hotfix、配置启动包和 smoke client。`node tools/release/package_release.mjs --smoke-existing <制品目录>` 会核对 SHA256SUMS 并运行既有发布冒烟，用于复验保留的制品；冒烟使用本机示例端口，应与其他本机验收串行运行。

## 验证

```powershell
npm run modules:validate
npm run modules:typecheck
npm run test:game-modules
npm run test:module-extensions
npm run test:module-native-runtime
npm run verify:hotfix-boundary
npm run verify:core-api
```

`tools/fixtures/game-modules/greeting` 是框架自有中立组件与实体扩展夹具，不依赖 MMORPG。纯模块宿主验收由 `test:module-host` 的独立夹具完成。

### 只读模块导航

`npm run modules:inspect -- --modules-dir <目录>` 列出模块入口、公开 API、带装饰器的状态类型与行为绑定，以及未静态连接入口的声明。`--json` 输出版本化 JSON（位置从 1 开始计数），供 Developer Tools 展示导航；模块目录、版本、依赖和路径规则复用构建目录校验，不另写一套插件规则。

导航不执行模块代码、不写文件、不构建、不启动进程。静态相对值 import/export 用于标记文件是否从入口可达，type-only 导入不计入；动态装配、间接装饰器和条件执行无法由此证明，告警不是类型检查或热更许可。实际发布继续使用类型、构建、冻结指纹和运行时检查。

System/Handler 的本模块目标可经静态命名导入、别名、命名空间与 re-export 定位，结果带 targetLocation；插件据真实源位置关联状态/行为，不按同名类型猜测。跨模块目标、动态表达式和无法唯一解析的导出标记 unresolved。该导航不是另一个 TypeScript 类型检查器。

职责边界：TiangZ Runtime 拥有运行语义；TiangZ 通用开发工具拥有模板、构建和确定性检查/解析；Developer Tools 插件拥有引导、导航、任务入口与错误呈现。终端和 CI 不依赖插件即可调用通用工具；插件不能静默修改协议锁或绕过热更边界。

数据库实跑需要明确指定独立验收实例：`npm run test:module-dbproxy-migration -- --endpoint <地址:端口> --env-file <环境文件>`，也可通过 `TIANGZ_DBPROXY_AUTH_TOKEN` 注入令牌。此验收在 `org.tiangz.module-migration.acceptance` namespace 留下独立记录，覆盖旧数据升级、第二个 TiangZ 进程重读及旧 Codec 写入拒绝；不会停止 DBProxy 容器或扫描其他 namespace。故障与并发竞争由普通单测注入，数据库实跑不默认包含在本机无数据库的验证矩阵中。

## 复合实体能力边界

`NpcUnit`、`MonsterUnit` 等类只表达稳定身份和基础生命周期，不应被当作互斥的玩法标签。外置模块可以在实体发布前通过强类型装配器给 NPC 组合 `NumericComponent`、`CombatComponent`、`SkillComponent` 等通用能力；普通服务 NPC 不装配这些组件，快照仍保持空数值集。这样“任务提供者同时具备战斗状态”由模块数据决定，不需要把来源游戏的 NPC flag、脚本事件或 entry 加入 Core。

组件可装配不等于战斗生命周期已经自动成立。玩家敌对关系、仇恨、AI、死亡清理、尸体和重生必须分别有明确的中立所有者；在这些契约完成前，模块不得因为实体已有 `CombatComponent` 就绕过现有目标资格或直接复用 `MonsterComponent` 的私有集合。扩展顺序、数值快照和整实体回滚是当前已经稳定的基础，跨实体类型的战斗目标与生命周期属于后续独立能力。
