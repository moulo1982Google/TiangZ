# 外置游戏模块

更新时间：2026-09-03。

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

这不是第二套配置系统。宿主`game_config/`与模块`game_config/`使用同一Luban编译能力，只是schema所有权和发布范围不同：宿主表属于TiangZ内置领域，模块表属于对应游戏。模块应使用生成的`Tables`解析自己的payload，再投影到Core已有的中立Profile；不得把原始导入JSON直接强转为业务类型。`RuntimeDataPack`仍然只是部署信封，负责发现、所有权、大小、哈希和冻结，不取代Luban schema。来源数据库、Excel或第三方服务器导入器只负责产出模块Luban源数据，不能成为运行时格式。

模块配置目前与运行时数据包一样是冷发布：schema或数据改变后重新生成、重新打包并重启Process。Core内置`GameConfig`的冷热表Reload机制不会自动套用到外置模块。

## Manifest v1

```json
{
  "formatVersion": 1,
  "id": "org.example.greeting",
  "version": "1.0.0",
  "description": "Example module",
  "engine": {
    "minVersion": "0.4.0",
    "maxVersionExclusive": "0.5.0"
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

完整构建包含 `codegen:module-config`。模块配置 schema 固定在 Model 中，`build:game-config` 将所有模块数据打包进同一个候选，与既有 `reload-config <candidate>` 一起验证和发布。通过 `ModuleConfigRegistry.Get(moduleId).tables` 读取不可变原始表，也可由模块自己的 Luban Tables 构造领域视图。候选必须包含完整模块集合；任一模块数据验证失败，原目录保持不变。客户端导出独立分发，不由服务端热更自动推送客户端。

配置跨 schema 的处理是重新生成 Tables、构建和重启；不能把新 schema 塞进旧 Model。已捕获的领域 Profile/快照不会自动更新，消费者明确决定何时重读并投影配置。

### 持久化版本迁移

`VersionedEntityCodec` 可声明 `migrations: [{ fromVersion: 1, toVersion: 2, Migrate(payload) { ... } }]`。每一步把旧版字节转换为下一版本，必须同步、确定性、无外部副作用；若 payload 内含版本字段，同样由该转换升级。生成 Codec 可在模块 Model 中通过对象展开添加迁移声明，无需修改生成文件。

Repository Load 遇到旧版本时先完整转换和 Decode 校验，再用原 revision CAS 保存；并发冲突重新加载权威数据，未知或未来版本拒绝。Save 的不明确回执沿用既有同 requestId 重试。这里迁移的是 DBProxy 通用记录 payload，不执行数据库 DDL，也不枚举全库；批量迁移调度和停服窗口由部署方管理。升级写入后，旧版 Codec 会拒绝新版本，不能把代码回滚等同于数据可逆。

### Native 模块

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

中立夹具位于 `tools/fixtures/game-modules/greeting`，只验证通用 Component/System，不包含 MMORPG 或 WoW 概念。

数据库实跑需要明确指定独立验收实例：`npm run test:module-dbproxy-migration -- --endpoint <地址:端口> --env-file <环境文件>`，也可通过 `TIANGZ_DBPROXY_AUTH_TOKEN` 注入令牌。此验收在 `org.tiangz.module-migration.acceptance` namespace 留下独立记录，覆盖旧数据升级、第二个 TiangZ 进程重读及旧 Codec 写入拒绝；不会停止 DBProxy 容器或扫描其他 namespace。故障与并发竞争由普通单测注入，数据库实跑不默认包含在本机无数据库的验证矩阵中。

## 复合实体能力边界

`NpcUnit`、`MonsterUnit` 等类只表达稳定身份和基础生命周期，不应被当作互斥的玩法标签。外置模块可以在实体发布前通过强类型装配器给 NPC 组合 `NumericComponent`、`CombatComponent`、`SkillComponent` 等通用能力；普通服务 NPC 不装配这些组件，快照仍保持空数值集。这样“任务提供者同时具备战斗状态”由模块数据决定，不需要把来源游戏的 NPC flag、脚本事件或 entry 加入 Core。

组件可装配不等于战斗生命周期已经自动成立。玩家敌对关系、仇恨、AI、死亡清理、尸体和重生必须分别有明确的中立所有者；在这些契约完成前，模块不得因为实体已有 `CombatComponent` 就绕过现有目标资格或直接复用 `MonsterComponent` 的私有集合。扩展顺序、数值快照和整实体回滚是当前已经稳定的基础，跨实体类型的战斗目标与生命周期属于后续独立能力。
