# 公共API与版本稳定性

TiangZ从`0.3.10-alpha.0`开始建立可执行的公共API边界。目标不是承诺`0.x`阶段永不调整，而是让业务依赖明确、破坏性变化可发现、可评审并有迁移记录。

## 版本身份

根目录`Cargo.toml`的`package.version`是唯一版本源。`package.json`、`package-lock.json`和README只保存同步副本，由以下命令检查：

```powershell
npm run verify:version
cargo run -- --version
```

Phase 3.10对应目标版本`0.3.10`。开发阶段使用SemVer预发布版本：

```text
0.3.10-alpha.0
0.3.10-alpha.1
0.3.10-beta.1
0.3.10-rc.1
0.3.10
```

Phase 3.10.1、3.10.2等是工作项，不使用四段版本号。客户端协议兼容性仍由Protocol Fingerprint判断，不能用产品版本代替协议指纹。

Phase 4使用`0.4.x`版本线。`0.4.0`包含一次明确记录的空间协议破坏性升级；此后普通协议演进仍必须兼容schema lock，不能把`0.x`版本当作随意改写既有字段的理由。

## 四类代码边界

### Stable

`app/core/public.ts`是服务端TypeScript业务唯一稳定入口。业务代码只能从该文件导入Core能力：

```ts
import {
  Component,
  EntryScene,
  unitRpcHandler,
  component,
  entryScene,
} from "../../core/public";
```

稳定表示：

- 名称、泛型方向和核心语义不会被无记录地修改；
- 破坏性变化必须显式更新API锁和迁移记录；
- Demo和新游戏目录只能依赖该入口，不能深层import Core实现文件。

`app/core/public-api.lock.json`锁定稳定导出符号集合。普通构建只验证，不会自动接受变化。

### Experimental

实验能力必须在文档和命名中明确标注，不能从`app/core/public.ts`导出后仍声称“内部可随意修改”。当前Rust NativeData原型、io_uring和部分KCP能力仍属于实验或平台限定能力，它们各自由配置和专项文档约束，不自动获得Stable承诺。

如果以后需要业务直接试用实验性Core API，应增加独立`app/core/experimental.ts`入口；在此之前不建立空的兼容层。

### Internal

除`app/core/public.ts`之外的`app/core`实现文件，以及`src`中的Rust Runtime实现，默认都是Internal。框架自身可以相互引用，业务代码不能依赖其文件布局、注册表、Host op或内部生命周期方法。

Internal调整不要求业务迁移说明，但必须继续通过公共API夹具和全量测试。

### Generated

以下目录由codegen拥有：

```text
app/generated/
src/generated/
cocos_client2D/assets/scripts/Generated/
pixi_client/src/Generated/
```

Generated不是Stable或Internal源码，禁止手工编辑。稳定契约来自proto、`.native`原型、生成器版本、opcode/schema锁和Protocol Fingerprint。

## 自动检查

```powershell
npm run verify:core-api
```

该命令执行三项检查：

1. 使用TypeScript类型系统解析`app/core/public.ts`的真实导出，并与`public-api.lock.json`比较；
2. 拒绝Model对Core实现文件的深层import、Hotfix绕过`#tiangz/model`深层import，也拒绝Core/Model反向依赖业务Hotfix；
3. 编译并运行`tools/core_public_api_self_test.ts`，证明一个独立业务模块只依赖Stable入口即可定义EntryScene、Unit、Component和Handler。

新增非破坏性公共API或完成破坏性变更评审后，显式执行：

```powershell
npm run core-api:update-lock
npm run verify:core-api
```

不得把`core-api:update-lock`放进普通codegen或构建流程，否则API漂移会被静默接受。

## 破坏性变更流程

修改或删除Stable API前必须完成：

1. 说明现有API为什么无法继续维护，以及受影响的业务调用点；
2. 优先增加新API并保留旧API一个迁移周期；
3. 迁移Demo和公共文档，不让样例继续教授旧写法；
4. 更新`public-api.lock.json`；
5. 在下方迁移记录写明旧写法、新写法和目标版本；
6. 同步更新AI项目上下文和AI业务开发手册；
7. 执行`npm run verify:quick`，涉及运行时语义时执行完整`npm run verify`。

## 迁移记录

### 开发中

- 新增`CommitPreparedTransfer`与`TransferStagingRegistry`，统一同进程迁移提交前回滚和跨进程目标端Prepare/Commit/Abort幂等语义。
- 旧业务无需迁移；普通Component不直接依赖这两个协调API。

### 0.3.10-alpha.0

- 新增`app/core/public.ts`作为业务唯一Stable入口；原有Core深层路径改为Internal。
- Demo全部迁移到公共入口，功能语义不变。
- 新增公共API锁、依赖方向检查和独立业务夹具。
- Cargo版本成为项目版本源，CLI支持`--version`和`-V`。

### 0.3.10-alpha.1

- 完成Phase 3.10.2 RPC与Actor正确性矩阵。
- `rpcId`回绕时避让在途调用；本地显式timeout和远程transport timeout语义冻结。
- 迟到/重复Response、连接断开、Process停机与Actor销毁均有确定性清理测试。
- 此版本未改变Stable公共导出集合，也未改变客户端协议fingerprint。

### 0.3.10-alpha.2

- 完成Phase 3.10.3确定性故障注入矩阵。
- 新增运行期Process终止、Inner断线、慢客户端、真实背压、Handler异常、非法帧、重连风暴和保存失败验收。
- 故障能力只存在于测试边界，不新增生产配置字段或Stable公共API。
- 此版本未改变客户端协议fingerprint。

### 0.3.10-alpha.3

- Actor明确收敛为Scene、Session、Unit三类mailbox目标的统称，不再作为业务需要继承的Stable基类。
- 删除`Actor`、`@actor`、`@handler`、`actorRpcHandler/actorMessageHandler`等旧Stable入口；Unit协议迁移到`unitRpcHandler/unitMessageHandler`。
- 新增`Session`、`SessionComponent`与`sessionRpcHandler/sessionMessageHandler`。客户端连接消息直接进入unordered Session mailbox；需要一致性的业务按稳定Key显式使用协程锁，PlayerUnit等权威Actor独立声明ordered。
- 删除只为登录串行而存在的`LoginActor`；Login和Gate均使用独立Session Handler，Gate会话状态统一保存在GateSession Entity。
- 此版本未改变客户端协议fingerprint；旧业务代码只需按真实目标将Actor Handler改为Unit Handler或Session Handler。

### 0.3.10-alpha.4

- Runtime彻底删除字符串`@handler`、动态组件Handler hooks与`ProcessHost.call/send`旁路，Scene/Session/Unit统一使用生成descriptor和类型化Handler。
- Stable入口移除不再承载可调用语义的`MessageTarget`，同时删除未使用的`ISocial*`与`IRank*`预设协议基类。
- `app/generated`只生成服务端协议；客户端生成物以`client_sdk/typescript/Generated`为唯一来源。
- 正常bundle不再包含Bench Scene和压测Handler；测试与性能脚本迁移到`build:bench`。
- 删除LogScene及其演示协议。历史opcode仍在lock中永久保留，不会被新消息复用。

### 0.3.10-alpha.5

- 服务端TS拆分为`app/model`与`app/hotfix`，构建产物拆分为`model.js`和`hotfix.js`。
- Model成为Process生命周期内不可变边界；字段、构造、继承、协议、Stable Core API或Native schema变化必须重启Process。
- Hotfix只允许通过`#tiangz/model`使用稳定类型，并只提交方法实现与Handler绑定；不提供字段migration或Model reload API。
- 新增Hotfix staging、prototype/Handler事务提交、失败回滚、隔离V8预检和兼容指纹校验。
- `app/core/public.ts`新增Hotfix行为声明所需Stable API；变更由`public-api.lock.json`锁定。

### 0.3.10-alpha.6

- 新增`systemFor` Stable API与Generated Bootstrap必需System注册；公开System签名由codegen冻结为Model声明，签名变化要求重启Process。
- PlayerUnit、LoginComponent与ItemComponent迁移到ET风格Hotfix System，Model不再手写抛错方法空壳。
- 新增3000玩家基线与1Hz Reload A/B runner和正式报告；90/90次Reload成功，Move吞吐无可见下降。
- Developer Tools升级到`v0.11.0`，VS Code与CI共同识别`@systemFor`和生成入口。

### 0.3.10-alpha.8

- Native Entity正式使用codegen类型池与Unit冷热布局；generation handle和TS NativeRef API保持兼容。
- NativeData指标增加Rust Pool、TS NativeRef和帧尾scratch容量；帧尾直接编码最终输出buffer。
- Developer Tools对Model长期字段类型稳定性执行错误级检查。

### 0.3.10-alpha.9

- Stable Core新增`ChildEntity`和Component子Entity容器API，统一Item、Buff、动态Quest与Achievement实例的身份、Root索引、Timer和级联销毁语义。
- ChildEntity明确不拥有mailbox和网络地址；Unit仍是地图Actor，二者不能互换。
- Item迁移为真实ChildEntity，NativeItemRef由Item自身持有并使用ProcessHost分配的真实InstanceId；Item局部规则和集合规则分别由Hotfix System承载。
- 新增`perf:child-entity`微基准，防止子Entity生命周期能力出现无依据的性能回归。

### 0.3.10-rc.1

- 冻结`0.3.10`的Stable API、Model/Hotfix边界、协议指纹和Native Schema，不再接受功能扩展。
- Windows与Linux使用同一提交执行依赖审计、完整`verify`和最终制品smoke；RC期间只接受发布阻塞修复。
- RPC系统错误响应从生成Codec创建完整默认对象；账号断线与重进交叠时重新查询权威目录，避免使用已销毁Unit引用。

### 0.3.10

- 运行时代码、Stable API、协议指纹与Native Schema均与通过双平台最终矩阵的`0.3.10-rc.1`一致。
- Windows与Linux制品均从版本化Git提交构建，在最终制品目录完成登录、进图、状态同步、移动和多人生命周期smoke，并生成SHA-256清单。
- 本版本作为Phase 0至Phase 3.10的稳定框架基线；后续功能和业务扩展使用新版本规划，不回写本Tag。

### 0.4.0

- 冻结地图局部米制`X/Y/Z + Yaw`，Grid2D地面轴从旧`Y`迁移为`Z`。
- `MapConfig`增加`Grid2D/NavMesh3D`空间模式、三维出生点和导航资源身份。
- Rust按MapInstance管理空间生命周期，Cocos 2D与Pixi通过适配层继续使用二维显示坐标。
- 这是显式破坏性协议版本；旧`0.3.10`客户端不得连接`0.4.x`服务端。

### 0.3.10-alpha.7

- Hotfix从每代独立ESM改为固定脚本名IIFE；Model仍只加载一次，并通过只读桥提供稳定公开类型，避免V8 ModuleMap和脚本URL随generation增长。
- Component与Actor的一次性、重复Timer统一改为方法名API，触发时解析当前Hotfix prototype；进程级`TimerSystem`闭包API仅供Core和稳定层使用。
- NumericComponent生命周期和领域行为迁入`@systemFor`，Model只保留Native handle状态。
- 新增8秒慢RPC切换屏障和100 generation资源长稳命令，并将慢RPC验收纳入完整`npm run verify`。
