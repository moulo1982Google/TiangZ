# Unit与ActorUnit边界

## 设计目标

地图上的玩家、怪物和NPC都需要UnitId、Component、AOI与完整生命周期，但不代表它们都需要独立mailbox。若每只怪物都成为Actor，地图固定桶仍会批量推进它们，同时Runtime又要维护一套从未使用的Actor路由和MailBoxComponent，语义与成本都会重复。

TiangZ因此把“地图实体”和“可寻址Actor能力”拆开：

```text
Entity
├── Actor                         Session等非Unit Actor
└── OwnedEntity                   本地所有权与Timer生命周期
    ├── ChildEntity               Item、Buff、动态Quest
    └── Unit                      普通地图实体
        ├── MonsterUnit           无mailbox，地图固定桶驱动
        └── ActorUnit             显式Actor能力
            └── PlayerUnit        @actor({ mailbox: "ordered" })
```

## 统一创建入口

业务不判断本地或Actor路径，两类Unit都使用`UnitComponent.Create`：

```ts
const units = map.GetComponent(UnitComponent);

const monster = units.Create(monsterUnitId, MonsterUnit, monsterArgs);
const player = units.Create(playerUnitId, PlayerUnit, playerArgs);
```

框架在Create内部执行以下规则：

1. `Unit`且没有`@actor`：建立本地Entity所有权，注册Root和生命周期，不创建mailbox。
2. `ActorUnit`且声明`@actor`：建立Actor路由、Root和MailBoxComponent。
3. 普通Unit声明`@actor`：立即报错，要求改为ActorUnit。
4. ActorUnit遗漏`@actor`：立即报错，拒绝使用隐式默认mailbox。

两条成功路径最终进入同一个`UnitId -> Unit`集合，因此AOI、Component、查询和销毁代码不分叉。

## Handler边界

只有ActorUnit能注册Unit Handler：

```ts
@unitRpcHandler(PlayerUnit, MapProtocol.UseItem)
export class C2M_UseItemHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_UseItem,
  M2C_UseItem
> {
  handle(player: PlayerUnit, request: C2M_UseItem): M2C_UseItem {
    return player.UseItem(request.itemId);
  }
}
```

普通MonsterUnit没有直接网络入口。客户端攻击怪物时，消息目标仍是玩家ActorUnit，然后由玩家领域方法调用同地图MonsterComponent：

```text
C2M_AttackMonster
-> PlayerUnit.AttackMonster(monsterUnitId)
-> MapScene.GetComponent(MonsterComponent).Attack(player, monsterUnitId)
```

这保留玩家有序业务边界，又避免每只怪物维护mailbox。

## Timer与销毁

- ActorUnit自身及其Component/ChildEntity Timer进入Actor mailbox，继承ordered或unordered语义。
- 普通Unit及其子对象使用本地Timer生命周期，不获得Actor串行保证；高数量怪物仍应优先使用地图固定更新桶。
- 两类Unit都必须通过`UnitComponent.Remove(unitId)`销毁。普通Unit清理本地所有权和Root；ActorUnit额外清理Actor路由与mailbox。
- Map停机时先让Unit离开AOI，再调用统一Remove；不能直接调用ProcessHost底层销毁绕过业务清理。

## 选择规则

选择ActorUnit必须同时回答“谁会按InstanceId给它发消息”和“为什么需要独立mailbox”。如果答案只是“它是一个Unit”或“以后可能有消息”，就使用普通Unit。需要大量实体批处理、固定桶AI或AOI Subject的怪物/NPC默认使用普通Unit；玩家等跨Scene直达且需要跨`await`串行的对象使用ActorUnit。
