# TiangZ Godot 4.7.1 3D Demo

这是TiangZ的Godot 4.7.1 WebSocket演示工程。它与Cocos3D、UE 5.4.4共用同一套服务端协议和Map 100导航主链，当前覆盖：

- LoginMgr、Login、Gate登录与进入Map 100；
- `G2C_EntityNavigate`权威位置和基础AOI进入/离开；
- 左键请求服务端NavMesh寻路；
- W/S方向移动与A/D转身；
- `E`键请求服务端动态门；
- 5秒Gate Ping和服务端时间显示；
- Godot米制Y-Up表现，不把Godot节点类型写入协议。

## 启动

先在TiangZ根目录启动服务端：

```powershell
cargo run --bin TiangZ -- configs/local/all-in-one.json
```

然后用Godot 4.7.1打开本目录的`project.godot`并运行主场景。当前Godot适配只实现WebSocket；TCP/KCP未实现时应直接报不支持，不能假装降级。

## 操作

左键点击绿色地面会提交`C2M_NavigateTo`，移动由Rust权威推进；W/S提交`C2M_NavigateInput`，普通模式A/D改变TiangZ协议Yaw，按住鼠标右键时A/D提交横向移动，拖动鼠标左右旋转摄像机并更新朝向；`E`切换服务端动态门，滚轮调整镜头距离。

## SDK边界

`scripts/generated/tiangz_proto.gd`是由主工程从Proto生成的Godot协议编解码层，`scripts/tiangz_client.gd`是WebSocket、登录流程、RPC和Push分发层，`scripts/main.gd`只处理Godot节点和表现。修改Proto后，在TiangZ根目录执行`npm run codegen:godot-client-sdk`，不能手工修改生成的msgcode、字段编号或Codec。

Godot客户端不复制Rust NavMesh、TileCache或权威碰撞。门的真实尺寸由服务端业务提交，角色半径由Rust按烘焙Agent规格处理；Godot只在服务端响应后更新门的显示。
