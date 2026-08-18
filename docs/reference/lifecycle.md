# 生命周期与玩家下线

## Process 与 Scene 生命周期

一个 Process/V8 中的入口 Scene 按配置顺序执行：

1. 创建全部 EntryScene。
2. 依次执行 `onStart()`。
3. 全部启动后依次执行 `onReady()`。
4. 停机时按相反顺序执行 `onStop()`。
5. 所有 stop 工作完成后销毁内部 Scene、Actor、Component 和 Singleton。

生命周期允许返回 `Promise<void>`。启动失败会反向清理已经创建的对象；停止阶段即使某个 Scene 报错，也会继续清理其他 Scene，最后用聚合错误让进程以失败状态退出。

```ts
@entryScene()
export class MapHostScene extends EntryScene {
  protected override onStop(): Promise<void> {
    return this.GetComponent(MapHostComponent)
      .KickAllPlayers("map-host-stopping");
  }
}
```

直接运行 Process 配置时支持以下优雅停机信号：

- Windows：`Ctrl+C` 和 `CTRL_BREAK_EVENT`。
- Linux：`SIGINT` 和 `SIGTERM`。

`process.lifecycle.stopTimeoutMs` 是整个 TS stop 的等待上限，默认 10000ms。`Stop-Process -Force`、任务管理器“结束任务”、`kill -9` 和进程崩溃无法执行任何应用层保存逻辑。

通过 `StartMachine.json` 启动时，Watcher 会同时等待运维信号与全部子进程状态。默认情况下，任一子进程提前退出都会被视为拓扑故障，Watcher立即通知其余子进程优雅停机并以非零状态退出。只有显式配置`process.lifecycle.restart`的进程会在原Watcher内按时间窗、最大次数和退避时间有界重启；重启预算耗尽后仍回到整组失败收束。正常停机时Watcher不会触发重启，而是同时通知所有子进程，再按各自`stopTimeoutMs`等待。Watcher意外退出导致控制管道EOF时，子进程也会主动收尾，避免成为孤儿进程。

`restart.maxAttempts/windowMs/backoffMs`默认分别为`3/60000/1000`，允许范围分别为`1..100`、`1000..3600000`和`1000..120000`。至少1秒的退避也保证同一`workerId`重启后不会在GlobalId秒级代次上复用旧值。Watcher会向新进程重放本次生命周期内最近广播的Hotfix和配置数据候选。该能力只恢复Process，不自动赋予业务数据恢复语义；MapHost必须配合DBProxy、Location所有权代次和Gate重新路由。当前本地验收只为`cluster-dbproxy/map-2.json`启用，其他进程继续失败收束。

配置了 `process.observability.health` 时，`/ready` 会在停机开始时立即返回 503，供负载均衡先摘除流量；`/live` 会保持 200，直到 V8 业务线程真正退出。

## 玩家下线

玩家离开地图和玩家下线是两个不同语义：

- `RemovePlayerAndBroadcast()`：用于地图切换，只离开当前地图，不表示账号离线。
- `PlayerUnit.Offline(reason)`：用于断网、Ping 超时、管理员踢人和停服，必须执行玩家保存。

所有真实下线路径都进入 `PlayerUnit.Offline()`。该方法内部委托 `PlayerPersistenceComponent`，第一次调用创建保存 Promise，重复调用返回同一个 Promise，因此 Gate 断线和 Map 停服同时发生时也只保存一次。

```ts
await player.Offline("client-disconnect");
```

业务代码不应写成：

```ts
await repository.Save(player);
KickPlayer(player);
```

踢人功能只负责终止会话；保存属于 Player 自身下线生命周期。当前 Demo 使用 `InMemoryPlayerRepository` 验证调用链，接数据库时实现 `PlayerRepository.Save()` 即可替换，`PlayerUnit`、Map 和 Gate 不需要改变。

异步保存不能放进同步 `OnDestroy()`。`OnDestroy()` 只负责释放已经不需要等待的资源；进程退出前必须在 `onStop()` 中等待 `Offline()` 完成，然后才能销毁 Unit。

## Map 批量踢人

`MapComponent.KickAllPlayers(reason)` 执行：

1. 按玩家绑定的 Gate 分组。
2. 向每个 Gate 发送一条 `M2G_KickPlayers` 批量消息。
3. Gate按`unitId`找到长期`GatePlayerRoute`并先标记`removing`，重复踢人不会再次触发清理；旧物理连接不再拥有地图生命周期。
4. Map 并行等待所有玩家的幂等保存。
5. 保存完成后删除 Unit；任一保存失败都会记录数量并让停机失败。

停机时跨进程踢人消息采用尽力投递，不能成为 Map 保存的前置依赖；Gate 进程自身也会关闭全部客户端连接。这样 Map 和 Gate 同时收到操作系统停机信号时不会互相等待。

普通网络断开不属于最终下线：Gate销毁`GateSession`但保留`GatePlayerRoute`和Map Unit；30秒内重连调用`SecondEnterMap`恢复视图。只有Gate的重连宽限扫描确认超时，才调用Map的`PlayerOffline`。Map不得创建连接超时Timer，也不得把`connectionId`或`GateSessionId`写入Unit。
