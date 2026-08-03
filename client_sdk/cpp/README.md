# TiangZ C++ Client SDK

该目录是与引擎无关的C++客户端SDK源目录。协议结构、Codec、msgcode和RPC描述符由主工程Proto生成；UE只提供Transport、线程切换、坐标和对象表现适配。

开发者不要修改`include/tiangz/generated`。修改Proto后执行：

```powershell
npm run codegen:proto
npm run codegen:cpp-client-sdk
```

生成结果会作为完整头文件目录复制到UE插件，未来Unity Native、独立C++客户端或其他引擎也可以使用同一份SDK。

公共层只处理字节帧、protobuf wire、RPC pending、Push注册、超时和有界入站队列。网络线程只能把完整帧放入队列；引擎主线程必须周期调用`RpcSocket::Update()`，所有业务回调都从这里分发。平台Adapter必须明确实现所选Transport，不支持TCP或KCP时直接报错，不能悄悄改用WebSocket。

业务不填写msgcode和rpcId，直接使用生成描述符：

```cpp
using namespace tiangz::protocol::demo;

Socket.On(Client_EntityNumeric, [](G2C_EntityNumeric Message) {
    // 更新引擎侧表现状态；权威数值仍来自服务端。
});

C2G_Ping Request;
Socket.Call(Gate_Ping, Request,
    [](G2C_Ping Response) { /* Response.serverTime */ },
    [](const std::string& Error) { /* 统一错误处理 */ });
```

UE插件及运行示例见`docs/tutorials/14-unreal-engine-client.md`。
