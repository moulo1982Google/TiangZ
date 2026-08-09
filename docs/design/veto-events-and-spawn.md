# Veto Event与后台任务设计

## 目标

TiangZ把“现在能不能做”和“做完后通知别人”分成不同能力：

```text
业务请求
  -> VetoEvent同步检查
  -> 第一个非0错误码立即返回
  -> 全部通过
  -> 执行不可逆业务
  -> SyncEvent / Broadcast / RPC通知结果
```

以使用红药为例，死亡、控制、道具CD、公共CD和Buff叠加上限分别属于不同模块。`C2M_UseItemHandler`只把协议值交给`ItemComponent.UseItemTransactional`，领域方法发布`ItemEvents.BeforeUse`检查；新增限制只需新增一个Hotfix Veto Handler。

## 为什么不是普通Event

普通同步Event表达“事情已经发生”，某个监听器失败不应回滚其他监听器。Veto Event表达“事情还没发生，是否允许”，所以必须满足：

1. 同步完成，调用方在当前调用栈立刻得到错误码。
2. 按`order`和稳定`id`确定顺序，结果可复现。
3. 第一个非放行码立即终止，后续监听器不执行。
4. 监听器只读，不能产生需要回滚的副作用。
5. 返回Promise、非法错误码或抛异常都视为契约错误并让当前业务失败。

这类能力在其他系统里也常叫Guard、Policy Chain、Filter Chain或Interceptor。TiangZ使用`VetoEvent`强调“任何一个模块都能否决”，但它不是投票：没有多数决，也不会收集全部原因。

## 注册方式与热更

```ts
@vetoEventHandler(MapScene, ItemEvents.BeforeUse, {
  id: "item.before-use.global-cooldown",
  order: 300,
})
export class GlobalCooldownVeto
  implements VetoSceneEventHandler<MapScene, BeforeUseItemEvent, number> {
  Handle(_scene: MapScene, event: BeforeUseItemEvent): number {
    return event.unit.GetComponent(CooldownComponent).IsGlobalCooldown
      ? GameErrCode.GlobalCooldown
      : SystemErrCode.Success;
  }
}
```

监听器类在Hotfix Bundle加载时注册到稳定绑定槽，业务运行时不为每个Unit、Buff或状态对象注册闭包。所谓“模块激活”由Handler读取Component或Native状态判断；未激活直接返回放行码。这样避免每个实体的订阅表、销毁解绑、重复注册和旧generation闭包泄漏。

`id`是热更身份，发布后不要随意改名。`order`越小越先执行，相同顺序按`id`排序。顺序只用于便宜校验优先或错误码优先级，Veto Handler之间仍不得通过副作用互相依赖。

## BeforeUseItem调用范例

定义位于`app/model/demo/item/ItemEvents.ts`，监听示例位于`app/hotfix/demo/item/handlers/BeforeUseItemVetoHandlers.ts`，调用位于`app/hotfix/demo/item/ItemComponentSystem.ts`：

```ts
const reason = unit.DomainScene().Events.Check(ItemEvents.BeforeUse, {
  unit,
  item,
  config,
});
if (reason !== SystemErrCode.Success) {
  throw new RpcError(reason, "item use vetoed");
}

const plan = PlanItemUseTransaction(unit, item.Id, item.configId);
await persistence.ApplyTransaction(operationId, plan.data, EncodeItemUseReceipt(plan.receipt));
ApplyItemUseTransaction(unit, plan.receipt, plan.inventory);
```

`ItemNotFound`等构造检查由ItemComponent完成；真正会被其他模块持续扩展的策略才进入Veto链。Planner和Commit仍保留数量、版本、CD与回执不变量，不能因为前面检查过就删除领域对象自己的最终校验。Veto只读且同步，DBProxy等待发生在全部Veto通过之后。

## Spawn语义

`scene.Tasks.Spawn(name, body)`对应“启动后不等待结果”的短任务：

- 当前调用方不获得Promise，也不能误把它当成已经完成。
- 任务异常由Scene Logger统一记录，不产生未处理Promise。
- ProcessHost聚合入口Scene和动态MapScene的在途任务并进入Hotfix排空屏障；旧任务完成前不会提交新generation。
- `Cancel`和Scene销毁会更新TiangZ轻量`signal.aborted/reason`，任务必须主动配合取消；该令牌不依赖浏览器`AbortController`。
- 永久循环、无限重试和长时间订阅禁止使用Spawn，否则Hotfix永远无法排空。

下面这些情况不能使用Spawn：

| 需求 | 正确能力 |
|---|---|
| 使用道具前检查 | VetoEvent |
| 需要调用结果 | `await` RPC/普通Promise |
| 玩家状态必须串行 | PlayerUnit ordered mailbox |
| 精确延迟或周期 | Entity Timer |
| 跨Scene通知 | Message/RPC |
| 短期非关键发布、遥测或缓存预热 | Spawn |

Spawn工厂会保留当前Hotfix generation直到任务结束，这是安全保证，不是免费能力。业务应让任务有明确上限，并在可能阻塞的I/O中使用`signal`。
