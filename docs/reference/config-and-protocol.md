# 配置与协议参考

## RuntimeConfig

| 字段 | 类型 | 含义 |
|---|---|---|
| `process` | `ProcessConfig` | 当前 OS 进程/V8 |
| `scenes` | `SceneConfig[]` | 当前进程实际启动的入口 Scene，至少一个 |
| `knownScenes` | `SceneConfig[]` | 路由目录；省略或为空时默认等于 `scenes` |

## ProcessConfig

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | string | Process 唯一名称，也作为 ProcessHost ID |
| `game` | object? | 固定 Game.Update 与掉帧补偿策略，默认 20Hz |
| `scheduling` | object? | Process 事件批处理与空闲 Tick 策略，默认 `adaptive` |
| `observability` | object? | 延迟采样等运行时观测配置 |
| `debug` | object? | 该 V8 的 Inspector 配置 |

`debug` 支持 `inspectorIp`、`inspectorPort`、`breakOnStart`、`allowRemote`。

`game` 支持：

```json
{
  "fixedUpdateMs": 50,
  "maxCatchUpSteps": 2
}
```

- `fixedUpdateMs`：业务 `Game.Update` 固定间隔，默认 50ms，即 20Hz；范围为 1 到 10000ms。
- `maxCatchUpSteps`：Process 短暂停顿后单次 Pump 最多补跑多少帧，默认 2，范围为 1 到 100。超出的旧帧会计入 `skippedFixedUpdates`，不会形成死亡螺旋。

`scheduling` 支持：

```json
{
  "mode": "adaptive",
  "idleTickMs": 50,
  "maxEventsPerUpdate": 512,
  "coalesceMicros": 250
}
```

- `mode`：`low-latency`、`throughput` 或 `adaptive`。
- `idleTickMs`：没有网络事件时 Runtime Pump 的最长等待时间，必须大于 0。Rust 实际等待取它与 `fixedUpdateMs` 的较小值，保证固定帧和游戏定时器不会被饿住。
- `maxEventsPerUpdate`：单次注入 V8 的事件上限，范围为 1 到 4096。
- `coalesceMicros`：高负载下允许的微秒级聚合窗口，最大 10000；低延迟模式默认 0。

这些字段都可省略并使用模式默认值。生产配置应按同一业务负载比较吞吐和 p95/p99 后再覆盖默认值。

## SceneConfig

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | string | Scene 实例唯一名 |
| `sceneType` | string | `@entryScene()` 注册类型 |
| `ip` | string | 外部/Inner Listener IP |
| `port` | u16 | Listener 端口 |

同一进程内 Scene name 和 endpoint 必须唯一。Inspector 端口不能与任何 Scene 端口冲突。

## StartMachine

`machines[].innerIp` 匹配本机地址，`machines[].processes` 列出要启动的进程配置。每个配置文件仍只创建一个 Process/V8。

## 网络帧

```text
[length: u32 BE][msgcode: u16 BE][protobuf payload]
```

`length` 不进入 TS。RPC 的 `rpcId/error/message` 属于 protobuf payload，不是公共帧头。普通 Message 不要求 `rpcId`。

Outer TCP/WebSocket 只允许客户端消息号；Inner TCP 握手后只允许内部消息号。当前 Demo 的消息号范围由 proto 文件名起始 ID 和定义顺序生成。

## 业务代码扫描

`codegen.config.json` 的 `hotfix.sceneSearchRoots` 控制 EntryScene 扫描根目录，`hotfix.handlerSearchRoots` 控制独立 Handler 扫描根目录。默认都可设为 `app`，因此 `app/demo`、`app/mymmorpg` 等平级游戏目录无需登记单独的 Scene 或 Handler 总表。
