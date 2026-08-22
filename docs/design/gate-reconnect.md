# Gate断线重连与最终下线

## 所有权

连接和玩家路由是两种生命周期：

| 对象 | 所有者 | 生命周期 | 保存内容 |
|---|---|---|---|
| `GateSession` | Gate | 一次TCP/WebSocket/KCP连接 | account、token、Route引用 |
| `GatePlayerRoute` | Gate | 跨连接，直到最终下线 | connectionId、收发时间、Map/Unit/Actor位置 |
| `PlayerUnit` | Map | 玩家进入地图到最终下线或迁移 | 权威游戏状态、gateName与gateEpoch |

Map不保存connectionId或GateSessionId，也不启动断线Timer。Route仍只在一个Gate进程内有效；Gate崩溃后客户端重新登录，Login根据Location当前所有者和Gate健康探测选路，新Gate再通过PlayerUnit邮箱与Location CAS接管现存Unit。

## 存活检测

客户端SDK每5秒调用一次`C2G_Ping -> G2C_Ping`，响应携带Gate生成响应时的Unix毫秒。Gate在统一入站钩子中记录所有客户端帧，因此移动、技能或其他消息同样会刷新`lastReceiveTime`。GateSession是unordered，Ping作为普通TS Handler且不加锁，不会排在长时间EnterMap之后。登录使用连接与账号两级锁；进图、重连、传送和最终下线共享账号锁。断线先按账号取得锁再分离连接，超时任务取得锁后重新检查时限，避免旧连接事件或旧超时任务覆盖刚完成的重连。`lastSendTime`只表示TS已经把帧放入宿主出站队列，用于观测，不代表网络写入成功，也不参与存活判定。

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

同账号新连接优先返回Location记录的当前健康Gate；没有在线位置或当前Gate不可达时，才按带32位avalanche最终混合的Rendezvous候选顺序选择健康Gate。最终混合用于打散公共账号前缀造成的候选分数相关性；`test:gate-reconnect`同时验证配置顺序无关和12 Gate分布。旧socket之后到达的disconnect会因connectionId不匹配而被忽略。

所有等待Map RPC的Gate流程在`await`返回后必须再次校验Route仍属于当前Session。否则旧连接启动的Promise可能在新连接顶号后返回，并把ActorLocation错误地绑回旧connectionId。

Route已有Map位置时，客户端照常调用`EnterMap`，Gate内部改走`MapProtocol.SecondEnterMap`：

1. 根据Route直接调用原PlayerUnit Actor。
2. Map清除旧连接遗留的移动输入。
3. Map返回权威Entity、Numeric和Item全量快照。
4. Gate把新connectionId绑定到原ActorLocation并向客户端返回。

这条路径不创建Unit、不广播AOI进入。普通同Gate重连不修改`UnitGateComponent`；跨Gate故障接管会先提交新epoch，再原地更新Unit绑定与Native AOI delivery route。

## Gate故障接管

Gate A不可达后，B的冷Route按以下顺序接管：

1. Login发现Location仍指向A，但A的`Gate.Probe`失败，返回健康候选B。
2. B解析Location的revision、Actor InstanceId、旧gateName和gateEpoch。
3. B以旧epoch调用PlayerUnit的`RebindPlayerGate`；请求仍进入PlayerUnit有序邮箱。
4. MapHost向Location提交完整CAS，Location原子递增revision和gateEpoch。
5. MapHost原地更新`UnitGateComponent`、Actor fencing token与AOI投递路由；B再执行`SecondEnterMap`。

所有Gate转发的ActorLocation帧都携带当前epoch。接管提交后，A的迟到消息会在真实Actor mailbox入口以`ActorLocationFenceRejected`拒绝，不进入技能、道具、交易等业务Handler。A恢复后不会主动拉回玩家：Login只要探测到Location当前Gate B健康，就继续返回B。即使客户端绕过Login直接连接A，A也会因B仍可达而拒绝接管。

这不是Socket迁移。A崩溃时原连接必然断开，客户端必须重新登录并建立B连接；框架也不执行自动回切。`gate_takeover`与`actor_location_fence`指标分别记录接管结果和旧epoch拒绝，Grafana Runtime Overview直接展示两者。

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

- 所有Login与Gate必须拥有相同的已知Gate拓扑；未知旧Gate不会被盲目接管。
- Gate增删时Rendezvous Hash只影响没有健康在线归属的登录；不会主动迁移仍在线连接。
- 当前健康判断是有界`Gate.Probe`，最终正确性由Location CAS与Actor fencing保证；跨机器租约、共识服务和自动容量回切尚未实现。
- Gate接管只保留MapHost上的PlayerUnit状态；Gate本地Route、Session、Socket和排队下行不会恢复。

快速状态机验证使用`npm run test:gate-reconnect`；真实双Gate强杀、接管、Watcher重启与禁止回切使用`npm run test:gate-failover`。Timer、Gate RPC与Map销毁链路使用`npm run test:gate-timeout-runtime`，后者会实际等待约32秒，因此不属于日常快速质量门。
