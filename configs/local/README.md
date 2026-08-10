# 本地启动配置

日常开发只需要在下面两个入口中选择一个：

| 入口 | 用途 |
|---|---|
| `cluster/StartMachine.json` | 推荐入口。由 Watcher 启动同目录的多进程部署，支持开发期 Hotfix 与 Hot 配置重载。 |
| `all-in-one.json` | 单进程、单 V8 调试入口，包含两个 Gate、静态地图和空载动态副本 Host；账号目录在进程内存中，适合协议和界面调试，重启会清空注册账号。 |
| `all-in-one-dbproxy.json` | DBProxy重启恢复演示；先启动本地DBProxy，并把`TIANGZ_DBPROXY_AUTH_TOKEN`设为DBProxy使用的同一令牌。完整步骤见[DBProxy玩家快照持久化](../../docs/tutorials/19-dbproxy-player-persistence.md)。 |

登录界面首次使用时点击“注册”，用户名会同时成为角色名。要验证“停服后仍能登录”，必须使用`all-in-one-dbproxy.json`；普通`all-in-one.json`不会把账号写入磁盘。

其余目录由入口引用，通常不需要直接操作：

```text
cluster/  一套可整体复制的多进程部署包：StartMachine、各Process和known-scenes
debug/    Inspector 等显式调试变体，不参与默认启动
```

部署配置只描述 Process、Scene、网络端口与 Runtime 参数。策划维护的地图、道具、玩家基础数值等游戏数据位于 `game_config/`，不要放进这里。
