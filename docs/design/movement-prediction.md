# Cell 移动预测与状态同步

## 目标

方向键移动采用“客户端预测、服务端权威、按 Cell 推进”。客户端发送方向状态，不发送每帧位置；服务端和客户端都只能从当前 Cell 移动到相邻 Cell。

当前基础参数集中在两处同名常量文件：

- 服务端：`app/model/demo/movement/CellMovement.ts`
- 客户端：`client_demo/cocos_client2D_3.8.6/assets/scripts/Demo/Map/Movement/CellMovement.ts`

默认值：

- 一个 Cell：12 世界单位。
- 地图：128x128 Cell，即 1536x1536 世界单位。
- Unit 占地：3x3 Cell，演示方块为 36x36。
- 移速：每秒 10 Cell。
- 服务端地图逻辑帧：20Hz。
- 客户端方向保活：2Hz，即500ms一次；按下、转向和松开仍立即发送。
- 服务端权威推进：20Hz；AOI下行频率独立，按距离档位最高20Hz。

## 移动规则

一次移动有明确的路径状态：

```text
fromCell -> toCell
moveStartTick -> moveEndTick
```

方向键在 Cell 途中发生变化时，只更新 `desiredInput`。当前 Cell 尚未走完前，`toCell` 不允许改变；到达 Cell 中心后，下一步才使用最新方向。停止也遵守同一规则，因此角色会先走完当前 Cell，再停在 Cell 中心。

斜向移动距离为 `sqrt(2)` 个 Cell。服务端以整数逻辑帧表示时长：默认直线 2 Tick，斜线 3 Tick，避免斜向速度更快。

## 本地玩家

`LocalMovementPredictor` 在开始、转向和停止时立即发送递增 `sequence`，持续按键时每500ms发送保活。本地渲染帧直接在当前 `fromCell/toCell` 之间插值，无需等待服务器响应。Cocos窗口隐藏、Pixi页面失焦或地图销毁会主动清空按键并立即发送停止，避免遗漏`KEY_UP`后继续移动。

收到权威状态后：

1. 丢弃已确认的输入版本。
2. 如果客户端与服务端描述的是同一步，不重设本地进度，避免周期快照造成抖动。
3. 如果路径不同，以服务端的 Cell 路径和 Tick 进度重建当前步。
4. 如果服务端已经到达客户端当前目标 Cell，让客户端完成当前插值，不向后拉回。

这里不再维护“显示位置误差”和连续纠偏速度。Cell 路径本身就是双方协商单位。

## 其他玩家

`RemoteMovementSmoother` 消费服务端广播的 Cell 路径，在渲染帧中从 `fromCell` 插值到 `toCell`。

- 同一个路径的周期快照不会重置插值。
- 较晚到达的停止状态如果指向当前目标 Cell，会让当前步自然完成。
- 新路径只能从已完成的 Cell 开始，第二次移动不会先拉回旧起点。
- `serverTick` 不大于已接收 Tick 的旧状态直接丢弃。

## 消息语义

`C2M_Move` 是方向状态：

- `input_x/input_z`：X/Z地面方向，取值为 -1、0、1；停止为 `(0, 0)`。
- `sequence`：方向状态或保活版本。

`G2C_EntityMove` 是一批权威 Cell 路径。包级 `server_tick` 表示生成批次时的地图逻辑帧，`movements` 中每个 `CellMovementState` 包含：

- `from_cell_x/from_cell_z`：当前步起点 Cell。
- `to_cell_x/to_cell_z`：当前步目标 Cell。
- `move_start_tick/move_end_tick`：当前步的服务端时间区间。
- `moving`：当前是否处于 Cell 过渡中。
- `acknowledged_sequence`：服务端已应用的客户端输入版本。

`G2C_EntityMove` 在 Proto 中声明为 `latest` 广播，并以 `unit_id` 作为覆盖键。Map 只提交移动状态和当前地图 Audience；Core BroadcastHub 在上一批仍在途时合并同一 Unit 的新状态。`SceneBroadcastTransport` 按 Gate 聚合 UnitId，通过通用 `S2G_ClientBroadcast` 携带已经编码好的最终客户端帧，Gate 不再解析移动业务。

进入地图响应携带 `fixed_update_ms`。客户端用服务端实际固定帧间隔量化直线和斜线步长，不能自行假定 20Hz。

初次进入地图使用 `MapEntitySnapshot.cell_x/cell_z` 创建实体，避免用浮点世界坐标反推权威 Cell。客户端二维显示层再把X/Z映射为屏幕X/Y。

## Cocos 视口

Cocos 使用 960x640 固定设计分辨率和 `SHOW_ALL` 策略。窗口变化时只进行统一比例缩放，宽高比不一致的部分留边，不会分别缩放 X/Y 轴。

地图世界为 1536x1536，放在 960x560 的矩形遮罩内。本地玩家移动时只平移 `MapWorld` 节点形成镜头跟随，地图与实体始终共享同一世界比例。

## 代码边界

- `Demo/Map/Movement`：演示业务的 Cell 常量、本地预测和远端插值。
- `Generated/Model`：由 proto 生成的方向消息和权威路径结构。
- `Demo/Map`：键盘输入、消息接线、地图视口和 Cocos Node 显示。
- `app/model/demo/movement`与`app/model/demo/map`：服务端演示业务的Cell规则、PlayerUnit、句柄组件和地图广播。
- `src/native_data.rs`：Rust 权威 Unit 数据、Cell 状态机和移动 protobuf 投影。

`tests/fixtures/native_data/movement_regression.json` 覆盖途中转向、停止和斜向移动；执行 `npm run test:native-data` 验证 Rust 状态机与预期帧。
