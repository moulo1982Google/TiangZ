# TypeScript 与第一个入口 Scene

## 常见语法

- `new (config: RuntimeEntrySceneConfig) => EntryScene`：构造器类型，表示“可用 new 调用，并返回 EntryScene 的类”。
- `Record<string, T>`：字符串 key 到 T 的字典类型。
- `A & B`：交叉类型，一个值同时满足 A 和 B；可以描述 `globalThis` 额外拥有宿主函数。
- `T | Promise<T>`：Handler 可同步或异步返回。
- `@entryScene()`、`@rpc(...)`：类定义时执行装饰器，把元数据放入 Registry。
- `prototype`：JavaScript 类实例共享的方法对象，不是实例 `this`。

## 新增 Scene

创建 `app/demo/scenes/EchoScene.ts`：

```ts
import { entryScene } from "../../core/process/registry";
import { EntryScene } from "../../core/process/types";

@entryScene()
export class EchoScene extends EntryScene {}
```

`@entryScene()` 默认去掉类名末尾的 `Scene`，因此注册类型是 `Echo`。需要稳定别名时可写 `@entryScene("Echo")`。

运行：

```powershell
npm run codegen
npm run typecheck
```

生成的 `app/generated/hotfix/scenes.ts` 会导入 `*/scenes/*.ts`，让装饰器执行。无需手工维护 Scene 构造器表。

## 拆分 Component 与 Handler

入口 Scene 只描述业务边界、mailbox 和它拥有哪些 Component：

```ts
@entryScene()
export class SocialScene extends EntryScene {
  readonly social = this.AddComponent(SocialComponent);
}
```

状态与领域能力放在 Component：

```ts
export class SocialComponent extends Component {
  queryFriendCount(account: string): number {
    return 0;
  }
}
```

所有业务组件都继承同一个 `Component`。组件挂在 EntryScene、动态 Scene 还是 Unit 上，由 `AddComponent` 的调用位置决定，不通过 `EntrySceneComponent/SceneComponent/ActorComponent` 等不同基类表达。

每个协议入口单独放在 `handlers` 目录：

```ts
@rpcHandler(SocialScene, SocialProtocol.QueryFriendCount)
export class QueryFriendCountHandler
  implements SceneRpcHandler<SocialScene, C2S_QueryFriendCount, S2C_QueryFriendCount> {
  handle(scene: SocialScene, request: C2S_QueryFriendCount): S2C_QueryFriendCount {
    const social = scene.GetComponent(SocialComponent);
    return { count: social.queryFriendCount(request.account) };
  }
}
```

`tools/codegen_scenes.mjs` 扫描 `handlerSearchRoots` 下所有名为 `handlers` 的目录，生成 `app/generated/hotfix/handlers.ts`。业务代码不维护 Handler 总表。Handler 实例属于具体 EntryScene 实例，并经过原有 Registry 与 mailbox；拆文件不会改变串行、并行、RPC 错误或 `rpcId` 语义。

Handler 是协议适配器。它可以只有一行，因为这一行负责把协议消息交给正确的 Scene、Unit 或 Component；不要再为这一行增加 Sink、Delegate 或纯转发 Component。

推荐目录：

```text
app/<game>/
  scenes/SocialScene.ts
  social/SocialComponent.ts
  social/handlers/C2S_QueryFriendCountHandler.ts
```

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

两个 Echo Scene 共享同一个 V8 和 TS 全局空间，但各自拥有实例状态、协议 Registry 和 mailbox。不要用模块级可变变量保存某个 Scene 的私有业务状态。

## 生命周期

1. bundle 加载并执行 `@entryScene()`。
2. Rust 调用 `__etsStartProcess`。
3. `ProcessRuntime` 按 `scenes` 查找构造器并创建实例。
4. `EntryScene` 注册 RPC/Message Handler。
5. Rust每 Tick 批量推送事件并调用 `__etsUpdateBinary`。

## 目录边界

- Core：`app/core`，不依赖具体游戏。
- Generated：`app/generated`，只由 codegen 写入，包含 Scene/Handler 自动导入表。
- Demo/Game：`app/demo`、未来的 `app/mymmorpg`，可热更业务代码。

常见错误：`unknown scene type` 表示未运行 codegen、文件不在 `scenes` 目录或配置 `sceneType` 与装饰器注册名不一致。
