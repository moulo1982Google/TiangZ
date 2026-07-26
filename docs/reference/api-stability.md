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

## 四类代码边界

### Stable

`app/core/public.ts`是服务端TypeScript业务唯一稳定入口。业务代码只能从该文件导入Core能力：

```ts
import {
  Component,
  EntryScene,
  actorRpcHandler,
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
2. 拒绝`app/demo`对Core实现文件的深层import，也拒绝Core反向依赖Demo或Generated；
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
