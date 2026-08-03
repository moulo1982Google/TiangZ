# 故障排查

## unknown scene type

确认class使用`@entryScene()`，文件位于`serverBundles.sceneSearchRoots`的`*/scenes/*.ts`范围，执行过`npm run codegen`，并检查`app/generated/bootstrap/scenes.ts`。

## Hotfix-only构建拒绝Model变化

`npm run build:hotfix`只适用于行为变化。字段、构造、继承、Core、协议锁或`.native`变化都会改变冻结指纹；应执行完整`npm run build`，部署配对的Model/Hotfix并重启Process。不要手工修改manifest绕过检查。

## scene not found / ambiguous scene

`knownScenes` 缺目标会 not found；`callOne` 对应多个同类型实例会 ambiguous。多实例先 `many()`，按业务规则选择具体 Scene。

## scene already exists

同一 ProcessHost 中动态 Scene ID 冲突。入口 Scene 创建子 Scene 时使用 `childSceneId(localId)`。

## JS did not set a result

通常表示 Tick 返回的 Promise 未完成或被拒绝。重点检查 ordered Scene 之间是否形成 RPC 调用环。通知类反向链路应使用 `send`，不要用等待响应的 `call`。

## RPC timeout

依次检查 Scene 地址、进程是否监听、Inner Token、目标队列背压、Handler 耗时、Response msgcode 和 payload rpcId。

## 断点不命中

使用 `npm run build:debug`，确认 `debug` 位于 `process` 下，附加该 Process 的 Inspector 端口。生产 bundle 默认没有 sourcemap。

## cargo run 无法选择 binary

项目有多个二进制，使用：

```powershell
cargo run --bin TiangZ -- configs/local/all-in-one.json
```
