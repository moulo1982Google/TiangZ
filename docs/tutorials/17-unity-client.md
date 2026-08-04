# Unity 2022.3 C#客户端

本教程把Unity当作TiangZ的一个客户端表现层。协议、登录、Gate、Map、AOI和权威移动仍由服务端决定；Unity只负责输入、相机、场景对象和渲染。

## 工程与生成

Unity示例工程是：

```text
client_demo/Unity2022.3.62f3c1_demo/
```

C# SDK唯一源码在主工程：

```text
client_sdk/csharp/
```

协议或SDK源码变化后，在TiangZ根目录执行：

```powershell
npm run codegen:csharp-client-sdk
dotnet build client_sdk/csharp/TiangZ.Client.csproj
```

生成器会把可运行的C#源码复制到：

```text
client_demo/Unity2022.3.62f3c1_demo/Assets/TiangZClient/Runtime/
```

这里的文件是Generated副本，不要直接修改。Unity业务代码放在`Assets/TiangZClient/Demo`或自己的业务目录。

## 启动与运行

先启动本地后端：

```powershell
npm run build
cargo run --bin TiangZ -- configs/local/all-in-one.json
```

打开Unity 2022.3，加载`Assets/Scenes/SampleScene.unity`并点击Play。场景中的`TiangZ Unity Demo`组件默认连接`127.0.0.1:7000`，也可以在Inspector修改：

```text
LoginMgr Host：登录管理器地址
LoginMgr Port：登录管理器端口
Account：测试账号；每个客户端使用不同账号
Map Id：默认100
Auto Connect：进入Play后自动登录
```

示例会完成LoginMgr -> Login -> Gate -> Map 100，注册AOI Push后请求初始快照；动态门状态从快照响应恢复。运行时支持：

- WASD：发送权威方向移动意图。
- W/S：前进和后退；A/D：改变角色朝向，方向与 Unity 场景一致。
- 按住鼠标右键后，A/D 改为横移，拖动鼠标旋转镜头，滚轮缩放镜头距离。
- E：请求服务器切换中间动态门；门的显示只接受服务器状态。
- 鼠标左键地面：发送权威寻路目标。
- 远端实体：只插值服务端`G2C_EntityNavigate`状态。
- 每5秒：通过Gate Ping显示网络往返耗时和服务器时间。
- F5：关闭当前连接并重新登录。

## 客户端调用边界

Unity表现代码不手写协议数字。登录和进图由`LoginFlow`编排，业务调用生成Client：

```csharp
var flow = new LoginFlow(new ClientEndpoint("127.0.0.1", 7000));
var game = await flow.EnterGameAsync("unity-demo", 100, cancellationToken);

// Unity Update中每帧调用，Push和RPC完成回到主线程处理。
flow.Update(256);

await game.Map.NavigateToAsync(new C2M_NavigateTo
{
    TargetX = 4f,
    TargetY = 0f,
    TargetZ = 6f,
    Sequence = 1,
}, cancellationToken);
```

`RpcSocket`的网络线程只入队，不能从网络线程修改Unity对象。`Vector3`、Transform和Camera只存在于Unity表现层；协议继续使用米制`x/y/z/yaw`，不要把Unity厘米或`Quaternion`写回协议。当前C# Adapter只支持桌面WebSocket，TCP/KCP未实现时必须显式报错。

## 常见错误

- 修改了`Assets/TiangZClient/Runtime/Generated`：重新运行codegen，手工修改会丢失。
- 把`MapSnapshotReady`之前注册AOI Handler：可能错过初始快照；应先注册Push，再调用该RPC。
- 在`Task.Run`或网络回调中操作Transform：Unity对象只能在主线程更新。
- 把服务端米制坐标转换成Unity坐标后再发回服务器：转换只在表现边界进行。
- 选择TCP/KCP却期待自动降级：当前SDK会明确报告不支持，不能静默改协议。
