# Unreal Engine 5.4.4客户端

`ue_client3D/TiangZClientUE`是与Cocos 3D使用同一服务端协议和Map 100的C++演示。公共C++ SDK不依赖UE；UE插件只负责WebSocket、游戏线程Update、坐标换算和Actor表现。

## 生成与编译

修改Proto后先执行：

```powershell
cd E:\gitee\TiangZ
npm run codegen:proto
npm run codegen:cpp-client-sdk
```

不要修改：

```text
client_sdk/cpp/include/tiangz/generated/
ue_client3D/TiangZClientUE/Plugins/TiangZClientSDK/Source/ThirdParty/
```

前者由Proto生成，后者是分发副本。UE 5.4.4在本开发机使用VS2022 MSVC 14.38；若机器只安装了14.44，应通过Visual Studio Installer补装`MSVC v143 14.38`。命令行编译：

```powershell
& "E:\Program Files\Epic Games\UE_5.4\Engine\Build\BatchFiles\Build.bat" `
  TiangZClientUEEditor Win64 Development `
  "-Project=E:\gitee\TiangZ\ue_client3D\TiangZClientUE\TiangZClientUE.uproject" `
  -WaitMutex -NoHotReloadFromIDE
```

## 运行Demo

先启动服务端：

```powershell
cargo run --bin TiangZ -- configs/local/all-in-one.json
```

再用UE 5.4.4打开`TiangZClientUE.uproject`并运行。Demo会自动使用随机账号依次调用：

```text
LoginMgr.GetLoginServiceAddr
-> Login.Login
-> Gate.LoginGate
-> Gate.EnterMap(Map 100)
-> Gate.MapSnapshotReady
```

进入地图后会消费`G2C_AoiDelta`、`G2C_EntityNavigate`和`G2C_EntityNumeric`，并每5秒调用一次`Gate.Ping`维持Gate在线状态。操作为：左键点击地面寻路，W/S前后，A/D转向，按住右键时A/D横移，右键水平移动调整角色朝向，滚轮调整相机距离，`E`键开关红色动态门。

动态门与Cocos 3D使用相同的地图局部坐标、物理尺寸和`Map.ToggleDemoDoor`协议。按`E`后，UE等待服务端响应再显示或隐藏门；关闭后点击门后地面会得到绕行路径，重新打开后恢复直线路径。Rust会按烘焙`agentRadius`扩大动态障碍的导航占用，UE不得把半径再次加到门尺寸中。红门Actor关闭本地碰撞，只负责显示；UE没有本地位置预测，继续插值服务端权威位置即可，不能用UE碰撞结果代替Rust TileCache状态。

## SDK边界

`client_sdk/cpp`只使用标准C++20类型。UE Adapter位于`Plugins/TiangZClientSDK`，把`IWebSocket`收到的完整二进制消息送入`RpcSocket`；网络回调不直接改UObject，`FTiangZLoginFlow::Tick()`在游戏线程调用`RpcSocket::Update()`后才执行协议Handler。

服务端坐标是米制Y-Up：`X/Z`为地面，`Y`为高度，Yaw绕Y轴。UE是厘米制Z-Up，因此转换只发生在Demo表现边界：

```text
TiangZ (X, Y, Z) meters -> UE (X, Z, Y) * 100 centimeters
TiangZ yaw radians      -> 90 - RadiansToDegrees(TiangZ yaw)
```

UE代码中的`TiangZYaw`始终属于协议坐标，键盘、鼠标和权威Push都修改这个值；只有设置Actor表现时才调用`TiangZYawToUnrealRotation()`。禁止把`FRotator::Yaw`直接发送给服务端，否则输入、权威移动和摄像机会使用两套方向定义。

公共协议禁止出现`FVector`、`FString`、UObject或UE模块依赖。当前UE Adapter只实现WebSocket；选择TCP/KCP应立即报“不支持”，后续必须用独立Adapter实现。

## 自动化验证

UE Automation测试名为`TiangZ.ClientSDK`，覆盖嵌套数组、正负64位整数、动态门RPC、RPC ID、未知字段跳过和截断包拒绝：

```powershell
& "E:\Program Files\Epic Games\UE_5.4\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" `
  "E:\gitee\TiangZ\ue_client3D\TiangZClientUE\TiangZClientUE.uproject" `
  -unattended -nop4 -nosplash -NullRHI `
  "-ExecCmds=Automation RunTests TiangZ.ClientSDK; Quit" `
  "-TestExit=Automation Test Queue Empty" -log
```
