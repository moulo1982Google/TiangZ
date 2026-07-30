# Gate断线重连与最终下线

## 所有权

连接和玩家路由是两种生命周期：

| 对象 | 所有者 | 生命周期 | 保存内容 |
|---|---|---|---|
| `GateSession` | Gate | 一次TCP/WebSocket/KCP连接 | account、token、Route引用 |
| `GatePlayerRoute` | Gate | 跨连接，直到最终下线 | connectionId、收发时间、Map/Unit/Actor位置 |
| `PlayerUnit` | Map | 玩家进入地图到最终下线或迁移 | 权威游戏状态、长期gateName |

Map不保存connectionId或GateSessionId，也不启动断线Timer。当前Demo的Route只在一个Gate进程内有效；Location负责跨进程Actor位置与迁移锁，但尚不接管Gate进程崩溃后的连接故障转移。

## 存活检测

客户端SDK每5秒发送一次单向`C2G_Ping`。Gate在统一入站钩子中记录所有客户端帧，因此移动、技能或其他消息同样会刷新`lastReceiveTime`。`lastSendTime`只表示TS已经把帧放入宿主出站队列，用于观测，不代表网络写入成功，也不参与存活判定。

Gate每1秒扫描全部Route：

- 在线Route连续30秒没有入站消息：进入最终下线。
- socket断开的Route：保留30秒重连宽限。
- 出站广播持续发生：不会延长上述期限。

这是一个Gate级合并扫描器，不是每玩家Timer。

## 重连状态机

```text
online
  -> transport disconnect -> disconnected
  -> new connection       -> online
  -> receive timeout      -> removing

disconnected
  -> new connection       -> online
  -> grace timeout        -> removing
```

同账号新连接使用带32位avalanche最终混合的Rendezvous Hash回到相同Gate，并在Gate内原子替换旧connectionId。最终混合用于打散公共账号前缀造成的候选分数相关性；`test:gate-reconnect`同时验证配置顺序无关和12 Gate分布。旧socket之后到达的disconnect会因connectionId不匹配而被忽略。

所有等待Map RPC的Gate流程在`await`返回后必须再次校验Route仍属于当前Session。否则旧连接启动的Promise可能在新连接顶号后返回，并把ActorLocation错误地绑回旧connectionId。

Route已有Map位置时，客户端照常调用`EnterMap`，Gate内部改走`MapProtocol.SecondEnterMap`：

1. 根据Route直接调用原PlayerUnit Actor。
2. Map清除旧连接遗留的移动输入。
3. Map返回权威Entity、Numeric和Item全量快照。
4. Gate把新connectionId绑定到原ActorLocation并向客户端返回。

这条路径不创建Unit、不广播AOI进入、不修改UnitGateComponent。首次进入和玩家主动传送仍调用MapHost的`EnterMap`。

## 最终下线

Route进入`removing`后禁止再次附着连接，Gate只发起一次`MapProtocol.PlayerOffline`：

```text
Gate timeout
  -> Map PlayerOffline
      -> PlayerUnit.Offline(reason)
      -> PlayerDirectory/UnitComponent移除
      -> AOI EntityLeave
  -> response
  -> Gate删除Route
```

Map保存失败仍会记录错误并完成Unit清理；Gate在RPC成功、失败或超时后都会回收本地Route，避免永久保留失效连接状态。正式持久化接入后，应由持久化可靠队列保证失败保存可恢复，而不是让Gate无限重试。

## 当前边界

- 粘滞Gate依赖各Login实例拥有相同Gate拓扑。
- Gate增删时Rendezvous Hash只重映射部分新登录账号；Location当前不会迁移仍在线的Gate连接。
- Gate进程崩溃会丢失内存Route；Gate故障转移、跨进程Map实例定位和全局在线目录仍是后续工作。

快速状态机验证使用`npm run test:gate-reconnect`；真实Timer、Gate RPC与Map销毁链路使用`npm run test:gate-timeout-runtime`，后者会实际等待约32秒，因此不属于日常快速质量门。
