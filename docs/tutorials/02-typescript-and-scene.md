# TypeScript、Model与第一个入口Scene

## 常见语法

- `new (config: RuntimeEntrySceneConfig) => EntryScene`：构造器类型，表示“可用new调用，并返回EntryScene的类”。
- `Record<string, T>`：字符串key到T的字典类型。
- `A & B`：交叉类型，一个值同时满足A和B；可以描述`globalThis`额外拥有宿主函数。
- `T | Promise<T>`：Handler可同步或异步返回。
- `@entryScene()`、`@rpc(...)`：类定义时执行装饰器，把元数据放入Registry。
- `prototype`：JavaScript类实例共享的方法对象，不是实例`this`。Hotfix通过替换Model prototype上的方法让现有实例进入新逻辑。

## 先分清Model与Hotfix

```text
app/model/<game>/       字段、构造、继承、Scene/Entity/Component稳定类型
app/hotfix/<game>/      Handler和允许在线替换的领域方法实现
```

Model随Process启动加载一次，不能在线热更。改Model必须完整构建、部署并重启Process。Hotfix只能从`#tiangz/model`导入稳定类型，不能深层导入Model或Core。

## 新增Scene

创建`app/model/mymmorpg/scenes/EchoScene.ts`：

```ts
import { EntryScene, entryScene } from "../../../core/public";

@entryScene()
export class EchoScene extends EntryScene {}
```

`@entryScene()`默认去掉类名末尾的`Scene`，因此注册类型是`Echo`。需要稳定别名时可写`@entryScene("Echo")`。

把新的游戏根加入`codegen.config.json`的Model Scene搜索范围，然后运行：

```powershell
npm run codegen
npm run typecheck
```

生成的`app/generated/bootstrap/scenes.ts`会导入Scene模块，让装饰器在Model加载时执行。无需手工维护Scene构造器表。新增Scene改变Model，不能使用`build:hotfix`上线。

## Component状态与Hotfix行为

Model声明状态和稳定方法形状：

```ts
// app/model/mymmorpg/social/SocialComponent.ts
import { Component } from "../../../core/public";

export class SocialComponent extends Component {
  protected readonly friends = new Set<string>();

  QueryFriendCount(_account: string): number {
    throw new Error("SocialComponent Hotfix is not installed");
  }
}
```

Hotfix提供方法实现：

```ts
// app/hotfix/mymmorpg/social/SocialComponentHotfix.ts
import { hotfixFor, SocialComponent } from "#tiangz/model";

@hotfixFor(SocialComponent)
export class SocialComponentHotfix extends SocialComponent {
  override QueryFriendCount(_account: string): number {
    return this.friends.size;
  }
}
```

实现类不会被实例化，只贡献prototype方法。不要给它增加字段、构造函数、静态初始化块或不同的继承关系。需要这些内容时修改Model并重启。

新Model类型还需要从`app/model/public.ts`导出，Hotfix才能通过`#tiangz/model`使用。后续会把这份导出表也交给codegen；当前不要在Hotfix中用相对路径绕过公共入口。

## 独立Handler

协议入口放在Hotfix的`handlers`目录：

```ts
import {
  type C2S_QueryFriendCount,
  type S2C_QueryFriendCount,
  type SceneRpcHandler,
  SocialComponent,
  SocialProtocol,
  SocialScene,
  rpcHandler,
} from "#tiangz/model";

@rpcHandler(SocialScene, SocialProtocol.QueryFriendCount)
export class QueryFriendCountHandler implements SceneRpcHandler<
  SocialScene,
  C2S_QueryFriendCount,
  S2C_QueryFriendCount
> {
  handle(scene: SocialScene, request: C2S_QueryFriendCount): S2C_QueryFriendCount {
    return {
      count: scene.GetComponent(SocialComponent).QueryFriendCount(request.account),
    };
  }
}
```

`tools/codegen_scenes.mjs`生成`app/generated/hotfix/handlers.ts`和`patches.ts`。Handler实例属于具体EntryScene，并经过原有Registry与mailbox；拆文件不会改变串行、并行、RPC错误或`rpcId`语义。

Handler是薄协议适配器。它可以只有一行，因为这一行负责把协议消息交给正确的Scene、Unit或Component；不要再增加Sink、Delegate或纯转发Manager。

## 构建选择

只修改`app/hotfix`行为：

```powershell
npm run build:hotfix
npm run test:hotfix
```

修改Model、Core、协议或`.native`：

```powershell
npm run build
cargo build --locked --bin TiangZ
# 部署完整配对并重启Process
```

`build:hotfix`拒绝Model变化是正确行为，不应修改manifest或脚本绕过。

## 配置启动

```json
{
  "process": { "name": "echo-dev" },
  "scenes": [
    { "name": "echo_1", "sceneType": "Echo", "ip": "127.0.0.1", "port": 7601 },
    { "name": "echo_2", "sceneType": "Echo", "ip": "127.0.0.1", "port": 7602 }
  ],
  "knownScenes": []
}
```

两个Echo Scene共享同一个V8和TS全局空间，但各自拥有实例状态、协议Registry和mailbox。不要用模块级可变变量保存某个Scene的业务状态。

## 启动顺序

1. Rust读取并验证Model/Hotfix manifest及实际文件哈希。
2. 候选在隔离V8完成无Process副作用预检。
3. 正式V8加载Model，执行`@entryScene()`并建立稳定类型。
4. 正式V8暂存并提交Hotfix generation 1。
5. Rust调用`__etsStartProcess`，`ProcessRuntime`按配置创建Scene。
6. Rust每Tick批量推送事件并调用`__etsUpdateBinary`。

常见错误：`unknown scene type`表示未运行codegen、文件不在Model Scene搜索范围或配置`sceneType`与装饰器注册名不一致。Hotfix manifest指纹错误表示稳定层已改变，应完整构建并重启。
