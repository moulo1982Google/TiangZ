# Godot 4.7.1客户端

`client_demo/godot-3d-4.7.1`是TiangZ的Godot 4.7.1 GDScript灰盒客户端。它和Cocos3D、UE 5.4.4使用相同的服务端坐标、Map 100、NavMesh移动和动态门协议，目的是验证“引擎只负责表现，服务端负责权威空间状态”。

## 运行

先在TiangZ根目录启动服务端：

```powershell
cd E:\gitee\TiangZ
cargo run --bin TiangZ -- configs/local/all-in-one.json
```

用Godot 4.7.1打开：

```text
E:\gitee\TiangZ\client_demo/godot-3d-4.7.1\project.godot
```

运行主场景即可。Godot客户端使用`ws://127.0.0.1:7000`开始登录，再根据服务端返回的地址连接Login和Gate；不把Gate端口写死在客户端业务里。

## 操作

- 左键点击绿色地面：调用`C2M_NavigateTo`，服务端NavMesh寻路并广播权威位置。
- W/S：提交前后方向输入。
- A/D：改变TiangZ协议Yaw并提交方向输入。
- 按住鼠标右键时 A/D：提交相对角色朝向的横向移动；松开右键后恢复A/D转身。
- 按住鼠标右键拖动：摄像机围绕玩家水平旋转，并限频提交新的朝向。
- `E`：调用`Map.ToggleDemoDoor`，只有服务端响应后才显示或隐藏红门。
- 鼠标滚轮：调整跟随相机距离。
- `1`：切换平A；`2/3`：使用生命药水；`4-8`：选择怪物后施放五个演示技能；`Q/R`：接取或交付任务。

进入地图后，`TiangZClient`会把`G2C_SkillCastState`、`G2C_SkillProjectile`、`G2C_SkillImpact`、`G2C_BuffAdded/Removed/Detail`、`G2C_QuestProgress`、`G2C_ItemChanged`和`G2C_EntityState`转换成信号，`main.gd`只维护状态和表现：技能显示读条并创建简单弹道，Buff显示中文名和剩余时间，任务显示目标进度，怪物根据Numeric和Alive状态显示HP与死亡。客户端不本地结算技能伤害、Buff效果或任务奖励。

## 文件职责

```text
main.tscn                         Godot入口场景
scripts/proto_reader.gd           有边界检查的protobuf字段读取
scripts/generated/tiangz_proto.gd 由Proto自动生成的协议字段和Codec
scripts/tiangz_client.gd          WebSocket、登录流程、RPC、Push分发
scripts/main.gd                   Node3D、相机、输入、单位和门表现
```

Godot协议层不是另一套手写协议。Proto新增或修改消息后，在TiangZ根目录执行`npm run codegen:godot-client-sdk`，或者直接执行包含它的`npm run codegen`；生成器会覆盖`scripts/generated/tiangz_proto.gd`。`tiangz_client.gd`只维护连接流程、业务调用和Push分发，`main.gd`只维护节点表现，禁止手工修改msgcode、字段编号和Codec。

## 坐标与权威边界

TiangZ坐标是米制Y-Up：X/Z为地面，Y为高度，Yaw=0朝+Z。Godot 3D也可直接使用这套坐标，因此本演示只把普通数值转换为Godot `Vector3`，不把`Vector3`放进协议。

Godot不复制Rust NavMesh、TileCache、Agent半径或动态碰撞。点击寻路和方向移动只提交意图，位置来自`G2C_EntityNavigate`；门的物理尺寸由服务端业务提交，Rust按烘焙Agent规格扩张导航占用。Godot只做权威位置的平滑显示，不做独立客户端碰撞预测。

Godot当前只实现WebSocket。选择TCP或KCP必须等对应Transport Adapter完成后再开放，不能静默降级为WebSocket。
