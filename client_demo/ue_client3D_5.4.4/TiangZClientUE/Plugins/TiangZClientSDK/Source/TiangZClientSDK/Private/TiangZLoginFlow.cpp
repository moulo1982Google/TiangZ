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
    FAoiDelta InAoiDelta, FNavigate InNavigate, FNumeric InNumeric,
    FEntityState InEntityState, FDemoDoorState InDemoDoorState,
    FAutoAttackState InAutoAttackState, FPing InPing)
{
    OnProgress = MoveTemp(InProgress);
    OnError = MoveTemp(InError);
    OnReady = MoveTemp(InReady);
    OnAoiDelta = MoveTemp(InAoiDelta);
    OnNavigate = MoveTemp(InNavigate);
    OnNumeric = MoveTemp(InNumeric);
    OnEntityState = MoveTemp(InEntityState);
    OnDemoDoorState = MoveTemp(InDemoDoorState);
    OnAutoAttackState = MoveTemp(InAutoAttackState);
    OnPing = MoveTemp(InPing);
}

void FTiangZLoginFlow::SetFeatureCallbacks(FItemChanged InItemChanged, FBuffAdded InBuffAdded,
    FBuffRemoved InBuffRemoved, FBuffDetail InBuffDetail,
    FQuestProgress InQuestProgress, FSkillCastState InSkillCastState,
    FSkillProjectile InSkillProjectile, FSkillImpact InSkillImpact)
{
    OnItemChanged = MoveTemp(InItemChanged);
    OnBuffAdded = MoveTemp(InBuffAdded);
    OnBuffRemoved = MoveTemp(InBuffRemoved);
    OnBuffDetail = MoveTemp(InBuffDetail);
    OnQuestProgress = MoveTemp(InQuestProgress);
    OnSkillCastState = MoveTemp(InSkillCastState);
    OnSkillProjectile = MoveTemp(InSkillProjectile);
    OnSkillImpact = MoveTemp(InSkillImpact);
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
    bToggleDemoDoorInFlight = false;
    bToggleAutoAttackInFlight = false;
    bUseItemInFlight = false;
    bCastSkillInFlight = false;
    bAcceptQuestInFlight = false;
    bCompleteQuestInFlight = false;
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

bool FTiangZLoginFlow::ToggleDemoDoor(bool bClosed, FToggleDemoDoor OnCompleted)
{
    if (!bReady || !GateSocket || bToggleDemoDoorInFlight) return false;
    bToggleDemoDoorInFlight = true;
    C2M_ToggleDemoDoor Request;
    Request.closed = bClosed;
    GateSocket->Call(Map_ToggleDemoDoor, MoveTemp(Request),
        [this, Completion = MoveTemp(OnCompleted)](M2C_ToggleDemoDoor Response) mutable
        {
            bToggleDemoDoorInFlight = false;
            if (Completion) Completion(Response.closed, Response.changed);
        },
        [this](const std::string& Error)
        {
            bToggleDemoDoorInFlight = false;
            Fail(Error);
        });
    return true;
}

bool FTiangZLoginFlow::ToggleAutoAttack(bool bEnabled, std::uint32_t TargetUnitId,
    FToggleAutoAttack OnCompleted)
{
    if (!bReady || !GateSocket || bToggleAutoAttackInFlight) return false;
    bToggleAutoAttackInFlight = true;
    C2M_ToggleAutoAttack Request;
    Request.enabled = bEnabled;
    Request.targetUnitId = TargetUnitId;
    GateSocket->Call(Map_ToggleAutoAttack, MoveTemp(Request),
        [this, Completion = MoveTemp(OnCompleted)](M2C_ToggleAutoAttack Response) mutable
        {
            bToggleAutoAttackInFlight = false;
            if (Completion) Completion(MoveTemp(Response));
        },
        [this](const std::string& Error)
        {
            bToggleAutoAttackInFlight = false;
            Fail(Error);
        });
    return true;
}

bool FTiangZLoginFlow::UseItem(std::uint64_t ItemId, FUseItem OnCompleted)
{
    if (!bReady || !GateSocket || bUseItemInFlight) return false;
    bUseItemInFlight = true;
    C2M_UseItem Request;
    Request.itemId = ItemId;
    GateSocket->Call(Map_UseItem, MoveTemp(Request),
        [this, Completion = MoveTemp(OnCompleted)](M2C_UseItem Response) mutable
        {
            bUseItemInFlight = false;
            if (Completion) Completion(MoveTemp(Response));
        },
        [this](const std::string& Error)
        {
            bUseItemInFlight = false;
            Fail(Error);
        });
    return true;
}

bool FTiangZLoginFlow::CastSkill(std::uint32_t SkillId, std::uint32_t TargetUnitId, FCastSkill OnCompleted)
{
    if (!bReady || !GateSocket || bCastSkillInFlight) return false;
    bCastSkillInFlight = true;
    C2M_CastSkill Request;
    Request.skillId = SkillId;
    Request.targetUnitId = TargetUnitId;
    GateSocket->Call(Map_CastSkill, MoveTemp(Request),
        [this, Completion = MoveTemp(OnCompleted)](M2C_CastSkill Response) mutable
        {
            bCastSkillInFlight = false;
            if (Completion) Completion(MoveTemp(Response));
        },
        [this](const std::string& Error)
        {
            bCastSkillInFlight = false;
            Fail(Error);
        });
    return true;
}

bool FTiangZLoginFlow::AcceptQuest(std::uint32_t QuestConfigId, FAcceptQuest OnCompleted)
{
    if (!bReady || !GateSocket || bAcceptQuestInFlight) return false;
    bAcceptQuestInFlight = true;
    C2M_AcceptQuest Request;
    Request.questConfigId = QuestConfigId;
    GateSocket->Call(Map_AcceptQuest, MoveTemp(Request),
        [this, Completion = MoveTemp(OnCompleted)](M2C_AcceptQuest Response) mutable
        {
            bAcceptQuestInFlight = false;
            if (Completion) Completion(MoveTemp(Response));
        },
        [this](const std::string& Error)
        {
            bAcceptQuestInFlight = false;
            Fail(Error);
        });
    return true;
}

bool FTiangZLoginFlow::CompleteQuest(std::uint32_t QuestConfigId, FCompleteQuest OnCompleted)
{
    if (!bReady || !GateSocket || bCompleteQuestInFlight) return false;
    bCompleteQuestInFlight = true;
    C2M_CompleteQuest Request;
    Request.questConfigId = QuestConfigId;
    GateSocket->Call(Map_CompleteQuest, MoveTemp(Request),
        [this, Completion = MoveTemp(OnCompleted)](M2C_CompleteQuest Response) mutable
        {
            bCompleteQuestInFlight = false;
            if (Completion) Completion(MoveTemp(Response));
        },
        [this](const std::string& Error)
        {
            bCompleteQuestInFlight = false;
            Fail(Error);
        });
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
    GateSocket->On(Client_EntityState, [this](G2C_EntityState Message)
    {
        if (OnEntityState) OnEntityState(MoveTemp(Message));
    });
    GateSocket->On(Client_DemoDoorState, [this](G2C_DemoDoorState Message)
    {
        if (OnDemoDoorState) OnDemoDoorState(Message.closed);
    });
    GateSocket->On(Client_AutoAttackState, [this](G2C_AutoAttackState Message)
    {
        if (OnAutoAttackState) OnAutoAttackState(MoveTemp(Message));
    });
    GateSocket->On(Client_ItemChanged, [this](G2C_ItemChanged Message)
    {
        if (OnItemChanged) OnItemChanged(MoveTemp(Message));
    });
    GateSocket->On(Client_BuffAdded, [this](G2C_BuffAdded Message)
    {
        if (OnBuffAdded) OnBuffAdded(MoveTemp(Message));
    });
    GateSocket->On(Client_BuffRemoved, [this](G2C_BuffRemoved Message)
    {
        if (OnBuffRemoved) OnBuffRemoved(MoveTemp(Message));
    });
    GateSocket->On(Client_BuffDetail, [this](G2C_BuffDetail Message)
    {
        if (OnBuffDetail) OnBuffDetail(MoveTemp(Message));
    });
    GateSocket->On(Client_QuestProgress, [this](G2C_QuestProgress Message)
    {
        if (OnQuestProgress) OnQuestProgress(MoveTemp(Message));
    });
    GateSocket->On(Client_SkillCastState, [this](G2C_SkillCastState Message)
    {
        if (OnSkillCastState) OnSkillCastState(MoveTemp(Message));
    });
    GateSocket->On(Client_SkillProjectile, [this](G2C_SkillProjectile Message)
    {
        if (OnSkillProjectile) OnSkillProjectile(MoveTemp(Message));
    });
    GateSocket->On(Client_SkillImpact, [this](G2C_SkillImpact Message)
    {
        if (OnSkillImpact) OnSkillImpact(MoveTemp(Message));
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
    GateSocket->Call(Gate_MapSnapshotReady, MoveTemp(Request), [this](G2C_MapSnapshotReady Response)
    {
        if (OnDemoDoorState) OnDemoDoorState(Response.demoDoorClosed);
    },
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
