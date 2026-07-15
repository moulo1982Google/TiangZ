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
| `debug` | object? | 该 V8 的 Inspector 配置 |

`debug` 支持 `inspectorIp`、`inspectorPort`、`breakOnStart`、`allowRemote`。

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
