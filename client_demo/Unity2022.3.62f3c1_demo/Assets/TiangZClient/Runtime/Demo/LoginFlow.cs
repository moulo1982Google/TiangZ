#nullable enable
using System;
using System.Threading;
using System.Threading.Tasks;
using TiangZ.Client.Generated.Demo;

namespace TiangZ.Client.Demo
{

public sealed class EnterGameResult
{
    public S2C_Login Login { get; set; } = null!;
    public G2C_EnterMap EnterMap { get; set; } = null!;
    public G2C_MapReady MapReady { get; set; } = null!;
    public RpcSocket GateSocket { get; set; } = null!;
    public GateClient Gate { get; set; } = null!;
    public MapClient Map { get; set; } = null!;
}

/// <summary>
/// Standard LoginMgr -> Login -> Gate -> Map flow used by the Unity demo.
/// Unity 示例使用的标准 LoginMgr -> Login -> Gate -> Map 流程。
/// </summary>
public sealed class LoginFlow : IDisposable
{
    private RpcSocket? managerSocket;
    private RpcSocket? loginSocket;
    private RpcSocket? gateSocket;

    public LoginFlow(ClientEndpoint loginMgrEndpoint)
    {
        LoginMgrEndpoint = loginMgrEndpoint;
    }

    public ClientEndpoint LoginMgrEndpoint { get; }
    public EnterGameResult? Current { get; private set; }

    public async Task<EnterGameResult> EnterGameAsync(string account, uint mapId, CancellationToken cancellationToken = default)
    {
        Close();
        managerSocket = new RpcSocket(LoginMgrEndpoint);
        await managerSocket.ConnectAsync(cancellationToken);
        var loginAddress = await new LoginMgrClient(managerSocket).GetLoginServiceAddrAsync(new C2S_GetLoginServiceAddr(), cancellationToken);
        managerSocket.Close();
        managerSocket = null;

        loginSocket = new RpcSocket(new ClientEndpoint(loginAddress.Ip ?? throw new InvalidOperationException("LoginMgr未返回Login地址"), checked((ushort)loginAddress.Port), LoginMgrEndpoint.Secure));
        await loginSocket.ConnectAsync(cancellationToken);
        var login = await new LoginClient(loginSocket).LoginAsync(new C2S_Login { Account = account }, cancellationToken);
        loginSocket.Close();
        loginSocket = null;

        gateSocket = new RpcSocket(new ClientEndpoint(login.GateIp ?? throw new InvalidOperationException("Login未返回Gate地址"), checked((ushort)login.GatePort), LoginMgrEndpoint.Secure));
        await gateSocket.ConnectAsync(cancellationToken);
        var gate = new GateClient(gateSocket);
        await gate.LoginGateAsync(new C2G_LoginGate { Account = login.Account, Token = login.Token }, cancellationToken);
        var mapReadyTask = gateSocket.WaitForMessageAsync(ClientMessages.MapReady, cancellationToken);
        var enterMap = await gate.EnterMapAsync(new C2G_EnterMap { MapId = mapId, MapInstanceId = 0 }, cancellationToken);
        var mapReady = await mapReadyTask;
        Current = new EnterGameResult
        {
            Login = login,
            EnterMap = enterMap,
            MapReady = mapReady,
            GateSocket = gateSocket,
            Gate = gate,
            Map = new MapClient(gateSocket),
        };
        return Current;
    }

    /// <summary>
    /// Pumps every socket that can still be part of the login flow.
    /// 登录流程的三个阶段都依赖主线程泵消息，不能只更新最终的 Gate Socket。
    /// </summary>
    public int Update(int maxMessages = 256)
    {
        var handled = 0;
        handled += managerSocket?.Update(maxMessages) ?? 0;
        handled += loginSocket?.Update(maxMessages) ?? 0;
        handled += gateSocket?.Update(maxMessages) ?? 0;
        return handled;
    }

    public void Close()
    {
        Current = null;
        gateSocket?.Close();
        loginSocket?.Close();
        managerSocket?.Close();
        gateSocket = null;
        loginSocket = null;
        managerSocket = null;
    }

    public void Dispose() => Close();
}
}
