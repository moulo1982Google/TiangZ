# 运行时基础能力：ID、时间、Timer、协程锁与Scene事件

本页定义这些基础设施的稳定语义。业务统一从`app/core/public.ts`导入，禁止依赖`app/core/runtime/*`深层实现。

## Entity的Id与InstanceId

所有Entity都有两个身份，但用途不同：

| 字段 | 用途 | 是否持久化 | 重启后是否保持 |
|---|---|---|---|
| `Id` | 业务身份，例如玩家ID、ItemId、动态副本ID | 需要长期存在时保存 | 是 |
| `InstanceId` | 当前Process内本次对象生命的地址 | 永远不保存 | 否 |

`Id`的类型允许`string | number | bigint`，由领域决定。需要跨服合并且永久保存的实体使用`GlobalId`，服务端表现为`bigint`；JSON边界转十进制字符串，protobuf使用`uint64`。Actor消息和EntityRoot只使用`InstanceId`，旧对象销毁后，迟到消息不能命中新对象。

```ts
const itemId = GlobalIdSystem.Instance.Next();
const item = itemComponent.AddChild(Item, itemId, snapshot);

// 数据库恢复：保留原Id，只创建新的InstanceId。
const restored = itemComponent.CreateItemById(snapshot.itemId, snapshot);
```

普通发放调用`CreateItem`生成新ID；只有数据库读取、迁移恢复或灾备恢复可以调用`CreateItemById`。保存Entity时必须忽略`InstanceId`、`TimerId`、mailbox、Native handle和其他运行时引用。

## GlobalId部署身份

当前正数63位布局为`[originServerId:14][seconds:30][workerId:7][sequence:12]`：

- `originServerId`是永久来源服编号，范围1到16383。开服后不可修改、复用；合服后各实体仍保留原来源服编号。
- `workerId`是同一来源服内生成ID的Process编号，范围0到127。
- 单个worker每秒最多生成4096个持久ID，超限立即报错，不回绕。
- 系统时钟回拨时拒绝生成，避免静默重复；生产机器必须维持可靠的时间同步。
- 同一个worker停机后至少隔开一个完整秒再复用；当前分秒布局不把每次Process启动代次持久化。Watcher目前不会自动重启故障子进程，未来自动拉起策略必须执行该隔离期。

```json
{
  "process": {
    "name": "map1",
    "identity": { "originServerId": 1, "workerId": 5 }
  }
}
```

Watcher会在启动任何子进程前检查整套`StartMachine`，重复的`originServerId + workerId`会阻止启动。直接绕过Watcher启动多个配置时，运维仍必须保证该组合唯一。

`InstanceIdSystem`分别维护Entity的u32编号和Timer的JS安全整数编号。Timer高频创建不会消耗Entity编号；二者只在各自容器中寻址，不能把一个裸`number`当作另一种ID使用。

## TimeSystem

- `FrameTime`：宿主提供的单调毫秒时间，用于游戏Timer、耗时与逻辑调度；不可写入数据库。
- `ServerNow`：Unix毫秒墙钟，用于活动开放时间、日志和持久化截止时间。
- `TimerSystem.ServerTime()`：`ServerNow`的业务静态入口；不另外提供名为`TimerComponent`的类型别名，避免与真正挂载在Entity上的Component混淆。
- `ServerDeadlineAfter/RemainingServerTime/IsServerDeadlineReached`：处理可持久化截止时间。
- `FixedTime/FixedDeltaTime/FrameCount`：当前固定逻辑帧。

不要用`ServerNow`驱动每帧移动，也不要把`FrameTime`保存到数据库。

## 拥有者Timer

Component、ChildEntity和Actor使用方法名创建Timer。参数按原对象传回；方法名会在触发时从当前Hotfix prototype解析，因此长期Timer不会持有旧热更闭包。

```ts
const timerId = this.NewOnceTimer(
  3_000,
  "FinishCast",
  { skillId: 1001, targetId },
  { onCancelled: "CancelCast" },
);

protected FinishCast(args: CastArgs): void {
  // 正常到期
}

protected CancelCast(args: CastArgs, context: TimerCancelledContext): void {
  // context.reason区分玩家移动、替换技能等主动中断原因
}

this.CancelTimer(timerId, "player-moved");
```

`CancelTimer`立即使Timer失效，并且取消方法至多执行一次。Actor及其所有权链下的Timer取消方法仍进入Actor mailbox，以保持顺序。Owner销毁时框架静默清理Timer，不再回调已经失效的业务对象。旧`RemoveTimer`兼容名已经删除，业务统一使用`CancelTimer`。

`TimerSystem`闭包API供Core和稳定Model使用；Hotfix业务使用拥有者的方法名API。大量Buff不要每个创建永久重复Timer，应由`BuffComponent`维护最近到期堆并使用一个合并Timer。

## Scene协程锁

协程锁用于ordered mailbox以外的局部业务串行，例如同门派成员同时修改门派状态：

```ts
await scene.Locks.RunExclusive("Guild", guildId, async () => {
  await repository.SaveGuild(guildId);
});
```

锁身份是`Scene.InstanceId + domain + key`。相同门派串行，不同门派并行；不同Scene永不互相阻塞。队列按FIFO获取，回调抛错或Promise拒绝也会释放。默认等待60秒、单键最多1024个等待者，可通过`timeoutMs`、`signal`和`maxQueueLength`缩小边界。

它只是一台Process的单V8协程锁，不是分布式锁。跨Process操作必须先通过Scene/Actor/Location路由到唯一状态所有者，再在所有者内加锁。不要用它替代数据库事务。

无竞争时`RunExclusive`会同步进入回调，保证回调第一个`await`之前建立的屏障或状态不会被后续消息抢跑；只有锁已被占用时才异步等待。调用方仍统一`await`返回的Promise，不依赖这一实现细节安排业务完成顺序。

Prometheus暴露`tiangz_coroutine_lock_waiters`和`tiangz_coroutine_lock_timeouts_total`。

## Scene内Event

Event只用于同一Scene中彼此解耦的同步协作。API绑定当前Scene，不接受目标Scene，因此不能意外跨Scene。框架区分两种语义：

- `SyncEvent`是已经发生的通知；监听器失败会记录日志，但不会改变发布方结果。
- `VetoEvent`是尚未执行操作前的只读检查；按`order/id`稳定排序，第一个非放行码立即终止检查。

```ts
export const PlayerEvents = {
  LevelChanged: defineSyncEvent<LevelChanged>("Player.LevelChanged"),
  BeforeUseItem: defineVetoEvent<BeforeUseItem, number>("Item.BeforeUse", 0),
};

@syncEventHandler(MapScene, PlayerEvents.LevelChanged, { id: "player.level-changed.ui" })
export class LevelChangedHandler implements SyncSceneEventHandler<MapScene, LevelChanged> {
  Handle(scene: MapScene, event: LevelChanged): void {}
}

@vetoEventHandler(MapScene, PlayerEvents.BeforeUseItem, {
  id: "item.before-use.cooldown",
  order: 200,
})
export class ItemCooldownVeto implements VetoSceneEventHandler<MapScene, BeforeUseItem, number> {
  Handle(scene: MapScene, event: BeforeUseItem): number {
    return event.cooldownActive ? GameErrCode.ItemNotUsable : 0;
  }
}

scene.Events.Publish(PlayerEvents.LevelChanged, event);
const reason = scene.Events.Check(PlayerEvents.BeforeUseItem, event);
if (reason !== 0) throw new RpcError(reason, "item use vetoed");
```

两类Handler都禁止`async`、Promise和I/O。Veto Handler还必须只读，不能在检查过程中扣道具、加Buff或改Numeric，否则后续监听器否决时会留下半完成状态。监听器使用跨generation稳定的`id`，Hotfix原子替换实现；不要让每个玩家动态注册闭包。模块是否生效由监听器读取事件中的Unit/Component状态决定。

## Scene后台任务

调用方明确不等待结果、也不依赖完成时间的短异步工作使用`scene.Tasks.Spawn`：

```ts
scene.Tasks.Spawn("publish-auto-attack-state", async ({ signal }) => {
  if (signal.aborted) return;
  await publisher.Publish(state);
});
```

`Spawn`不返回任务Promise，只返回可选的本地任务ID；框架统一捕获异常，并把任务计入Scene异步在途和Hotfix切换屏障。Scene销毁或主动`Cancel(id)`只更新TiangZ自带的轻量`signal.aborted/reason`，不依赖浏览器`AbortController`；JavaScript不能强制终止一个不配合的Promise。

`Spawn`只适合有界短任务。每个Scene最多允许256个在途任务，第257个会立即失败；单个任务超过10秒会记录一次包含Scene、任务名和耗时的告警，但框架不会强杀Promise。否决检查、事务、玩家有序状态修改、需要响应的RPC不能放进去；永久循环会持续占用容量并永久阻塞Hotfix。精确时间点和周期逻辑使用Entity Timer，需要Actor顺序的异步工作使用Message/RPC或Actor Timer。

跨Scene、跨Process或需要目标mailbox顺序时使用类型化Message/RPC，而不是Event或`Spawn`。

## 验收

```powershell
npm run test:runtime-foundation
cargo test watcher::tests::
```

该自测覆盖合服ID、Timer参数与取消、所有权清理、按键串行锁、Scene事件隔离、Veto首错终止和Spawn生命周期。
