# 故障注入测试

Phase 3.10.3把关键异常变成可重复执行的验收矩阵。TiangZ不在生产配置和业务API中提供随机丢包、随机异常或睡眠开关；测试通过Fake依赖、畸形输入、真实有界队列、主动关闭Socket和终止子进程，在故障所属边界确定性注入。

## 一键执行

```powershell
npm run test:fault-injection
```

该命令会构建Runtime并占用本地Demo端口。执行前应停止手工启动的TiangZ、Cocos压测客户端和其他占用`7000-7301`端口的程序。

需要快速检查纯TS边界时使用：

```powershell
npm run test:fault-injection:core
```

只执行真实进程、TCP、慢客户端和过载链路时使用：

```powershell
npm run test:fault-injection:runtime
```

## 验收矩阵

| 故障 | 注入位置 | 必须成立的结果 |
| --- | --- | --- |
| Process退出 | 所有端口就绪后强制终止Watcher的一个真实子进程 | Watcher非零退出、记录unexpected exit、兄弟进程和全部端口关闭 |
| Inner断线 | RPC在途时由测试Server关闭持久TCP | 同连接全部pending失败、计数归零、`disconnected_calls`准确 |
| 慢客户端 | 不消费容量为1的下行队列并继续广播 | 只关闭慢连接、发送shutdown、`slow_client_disconnects`递增 |
| 队列过载 | 高并发请求填满真实Runtime有界入站队列 | 生产者受到背压、队列深度最终归零、健康本地客户端不被误踢 |
| Handler异常 | RPC和Message Handler同步或异步抛错 | RPC返回`HandlerFailed`且保留rpcId；Message只记失败；后续正常消息继续成功 |
| 非法帧 | 短帧、损坏protobuf和非法ActorLocation信封 | 不崩溃；可识别RPC返回`DecodeFailed`；不可识别短帧只记系统错误；后续帧正常处理 |
| 重连风暴 | 连续5000次Location换代和1000次玩家Gate Session改绑 | 旧连接/Session失效，最新Location和所有权不被迟到断线移除 |
| 保存失败 | Fake Repository固定拒绝保存 | 失败向下线/停机调用者传播；并发下线路径共享同一Promise且只写一次 |

## 设计约束

- 故障注入代码只放在`tools`、Rust测试模块或测试Fake中，不能进入`configs`的生产字段。
- 不用随机概率决定测试是否触发；次数、断点和期望错误必须确定。
- 测试不仅断言“出现错误”，还要断言故障后的资源清理、计数和下一次正常操作。
- 慢客户端与队列过载不同：前者测试下行消费者太慢，后者测试入站生产者快于业务线程。
- 保存失败不能静默吞掉，也不能无界自动重试；重试策略属于后续持久化设计。
- Process退出测试必须先确认子进程已正常监听，再终止其中一个，避免把配置启动失败误当作运行期崩溃。

## 与质量门的关系

`npm run verify`已经通过既有命令覆盖同一矩阵：快速门运行协议、Actor、持久化和全部Rust测试，随后运行Runtime、mailbox、背压和Watcher验收。`test:fault-injection`提供按故障主题组织的独立入口，便于框架改动后单独复现。

外网单机的500玩家、DBProxy持久化、AOF backlog、MapHost和动态副本长时间恢复演练，见[外网500玩家七日故障演练](../tutorials/21-external-chaos-drill.md)。该演练通过双重安全开关执行真实进程与容器故障，不属于日常`npm run verify`。
