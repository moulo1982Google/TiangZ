#include "TiangZLoginFlow.h"

#include "TiangZWebSocketTransport.h"

using namespace tiangz::protocol::demo;

FTiangZLoginFlow::FTiangZLoginFlow(tiangz::client::ClientEndpoint InLoginMgrEndpoint)
    : LoginMgrEndpoint(MoveTemp(InLoginMgrEndpoint))
{
}

FTiangZLoginFlow::~FTiangZLoginFlow()
{
    Close();
}

void FTiangZLoginFlow::SetCallbacks(FProgress InProgress, FError InError, FReady InReady,
    FAoiDelta InAoiDelta, FNavigate InNavigate, FNumeric InNumeric, FPing InPing)
{
    OnProgress = MoveTemp(InProgress);
    OnError = MoveTemp(InError);
    OnReady = MoveTemp(InReady);
    OnAoiDelta = MoveTemp(InAoiDelta);
    OnNavigate = MoveTemp(InNavigate);
    OnNumeric = MoveTemp(InNumeric);
    OnPing = MoveTemp(InPing);
}

void FTiangZLoginFlow::Start(FString InAccount, std::uint32_t InMapId)
{
    Close();
    Account = MoveTemp(InAccount);
    MapId = InMapId;
    ConnectLoginMgr();
}

void FTiangZLoginFlow::Tick()
{
    if (ManagerSocket) ManagerSocket->Update();
    if (LoginSocket) LoginSocket->Update();
    if (GateSocket) GateSocket->Update();
    TickPing();
}

void FTiangZLoginFlow::Close()
{
    if (ManagerSocket) ManagerSocket->Close();
    if (LoginSocket) LoginSocket->Close();
    if (GateSocket) GateSocket->Close();
    ManagerSocket.reset();
    LoginSocket.reset();
    GateSocket.reset();
    EnterResponse.reset();
    MapReady.reset();
    LoginToken.clear();
    bReady = false;
    bPingInFlight = false;
    bNavigateToInFlight = false;
    bNavigateInputInFlight = false;
}

bool FTiangZLoginFlow::NavigateTo(float X, float Y, float Z, std::uint32_t InSequence)
{
    if (!bReady || !GateSocket || bNavigateToInFlight) return false;
    bNavigateToInFlight = true;
    C2M_NavigateTo Request;
    Request.targetX = X;
    Request.targetY = Y;
    Request.targetZ = Z;
    Request.sequence = InSequence;
    GateSocket->Call(Map_NavigateTo, MoveTemp(Request),
        [this](M2C_NavigateTo) { bNavigateToInFlight = false; },
        [this](const std::string& Error) { bNavigateToInFlight = false; Fail(Error); });
    return true;
}

bool FTiangZLoginFlow::NavigateInput(std::int32_t Forward, std::int32_t Strafe, float Yaw,
    std::uint32_t InSequence)
{
    if (!bReady || !GateSocket || bNavigateInputInFlight) return false;
    bNavigateInputInFlight = true;
    C2M_NavigateInput Request;
    Request.forward = Forward;
    Request.strafe = Strafe;
    Request.yaw = Yaw;
    Request.sequence = InSequence;
    GateSocket->Call(Map_NavigateInput, MoveTemp(Request),
        [this](M2C_NavigateInput) { bNavigateInputInFlight = false; },
        [this](const std::string& Error) { bNavigateInputInFlight = false; Fail(Error); });
    return true;
}

std::unique_ptr<FTiangZLoginFlow::FSocket> FTiangZLoginFlow::CreateSocket(
    const tiangz::client::ClientEndpoint& Endpoint)
{
    auto Socket = std::make_unique<FSocket>(CreateTiangZWebSocketTransport(Endpoint));
    Socket->SetErrorHandler([this](std::string Error) { Fail(Error); });
    return Socket;
}

void FTiangZLoginFlow::ConnectLoginMgr()
{
    Progress(TEXT("正在连接 LoginMgr..."));
    ManagerSocket = CreateSocket(LoginMgrEndpoint);
    ManagerSocket->SetConnectedHandler([this]
    {
        C2S_GetLoginServiceAddr Request;
        ManagerSocket->Call(LoginMgr_GetLoginServiceAddr, MoveTemp(Request),
            [this](S2C_GetLoginServiceAddr Response)
            {
                ManagerSocket->Close();
                ConnectLogin(Response);
            },
            [this](const std::string& Error) { Fail(Error); });
    });
    ManagerSocket->Connect();
}

void FTiangZLoginFlow::ConnectLogin(const S2C_GetLoginServiceAddr& Address)
{
    CurrentEndpoint = LoginMgrEndpoint;
    CurrentEndpoint.host = Address.ip;
    CurrentEndpoint.port = static_cast<std::uint16_t>(Address.port);
    Progress(FString::Printf(TEXT("正在连接 Login %s:%u..."), UTF8_TO_TCHAR(Address.ip.c_str()), Address.port));
    LoginSocket = CreateSocket(CurrentEndpoint);
    LoginSocket->SetConnectedHandler([this]
    {
        C2S_Login Request;
        Request.account = TCHAR_TO_UTF8(*Account);
        LoginSocket->Call(Login_Login, MoveTemp(Request),
            [this](S2C_Login Response)
            {
                LoginSocket->Close();
                ConnectGate(Response);
            },
            [this](const std::string& Error) { Fail(Error); });
    });
    LoginSocket->Connect();
}

void FTiangZLoginFlow::ConnectGate(const S2C_Login& Login)
{
    LoginToken = Login.token;
    CurrentEndpoint = LoginMgrEndpoint;
    CurrentEndpoint.host = Login.gateIp;
    CurrentEndpoint.port = static_cast<std::uint16_t>(Login.gatePort);
    Progress(FString::Printf(TEXT("正在连接 Gate %s:%u..."), UTF8_TO_TCHAR(Login.gateIp.c_str()), Login.gatePort));
    GateSocket = CreateSocket(CurrentEndpoint);
    GateSocket->On(Client_MapReady, [this](G2C_MapReady Message)
    {
        MapReady = MoveTemp(Message);
        TryFinishEnter();
    });
    GateSocket->On(Client_AoiDelta, [this](G2C_AoiDelta Message)
    {
        if (OnAoiDelta) OnAoiDelta(MoveTemp(Message));
    });
    GateSocket->On(Client_EntityNavigate, [this](G2C_EntityNavigate Message)
    {
        if (OnNavigate) OnNavigate(MoveTemp(Message));
    });
    GateSocket->On(Client_EntityNumeric, [this](G2C_EntityNumeric Message)
    {
        if (OnNumeric) OnNumeric(MoveTemp(Message));
    });
    GateSocket->SetConnectedHandler([this]
    {
        C2G_LoginGate Request;
        Request.account = TCHAR_TO_UTF8(*Account);
        Request.token = LoginToken;
        GateSocket->Call(Gate_LoginGate, MoveTemp(Request),
            [this](G2C_LoginGate) { EnterMap(); },
            [this](const std::string& Error) { Fail(Error); });
    });
    GateSocket->Connect();
}

void FTiangZLoginFlow::EnterMap()
{
    Progress(TEXT("正在进入 Map 100..."));
    C2G_EnterMap Request;
    Request.mapId = MapId;
    Request.mapInstanceId = 0;
    GateSocket->Call(Gate_EnterMap, MoveTemp(Request),
        [this](G2C_EnterMap Response)
        {
            EnterResponse = MoveTemp(Response);
            TryFinishEnter();
        },
        [this](const std::string& Error) { Fail(Error); }, std::chrono::minutes(10));
}

void FTiangZLoginFlow::TryFinishEnter()
{
    if (bReady || !EnterResponse.has_value() || !MapReady.has_value()) return;
    bReady = true;
    if (OnReady) OnReady(*EnterResponse, *MapReady);
    C2G_MapSnapshotReady Request;
    Request.unitId = EnterResponse->unitId;
    GateSocket->Call(Gate_MapSnapshotReady, MoveTemp(Request), [](G2C_MapSnapshotReady) {},
        [this](const std::string& Error) { Fail(Error); });
    NextPingAt = std::chrono::steady_clock::now();
}

void FTiangZLoginFlow::TickPing()
{
    const auto Now = std::chrono::steady_clock::now();
    if (!bReady || !GateSocket || bPingInFlight || Now < NextPingAt) return;
    bPingInFlight = true;
    PingStartedAt = Now;
    C2G_Ping Request;
    GateSocket->Call(Gate_Ping, MoveTemp(Request),
        [this](G2C_Ping Response)
        {
            const auto CompletedAt = std::chrono::steady_clock::now();
            const auto Latency = std::chrono::duration_cast<std::chrono::milliseconds>(
                CompletedAt - PingStartedAt).count();
            bPingInFlight = false;
            NextPingAt = CompletedAt + std::chrono::seconds(5);
            if (OnPing) OnPing(Latency, Response.serverTime);
        },
        [this](const std::string& Error)
        {
            bPingInFlight = false;
            NextPingAt = std::chrono::steady_clock::now() + std::chrono::seconds(5);
            Fail(Error);
        });
}

void FTiangZLoginFlow::Fail(const std::string& Message)
{
    if (OnError) OnError(UTF8_TO_TCHAR(Message.c_str()));
}

void FTiangZLoginFlow::Progress(const FString& Message) const
{
    if (OnProgress) OnProgress(Message);
}
