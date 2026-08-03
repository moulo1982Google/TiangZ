#pragma once

#include <chrono>
#include <functional>
#include <memory>

#include "tiangz/client/RpcSocket.h"
#include "tiangz/generated/demo/Protocol.h"

/** UE演示使用的登录纵向链路；协议与RpcSocket仍属于可脱离UE的C++ SDK。 / UE demo login orchestration; protocol and RpcSocket remain engine-independent. */
class TIANGZCLIENTSDK_API FTiangZLoginFlow final
{
public:
    using FProgress = std::function<void(const FString&)>;
    using FError = std::function<void(const FString&)>;
    using FReady = std::function<void(
        const tiangz::protocol::demo::G2C_EnterMap&,
        const tiangz::protocol::demo::G2C_MapReady&)>;
    using FAoiDelta = std::function<void(tiangz::protocol::demo::G2C_AoiDelta)>;
    using FNavigate = std::function<void(tiangz::protocol::demo::G2C_EntityNavigate)>;
    using FNumeric = std::function<void(tiangz::protocol::demo::G2C_EntityNumeric)>;
    using FDemoDoorState = std::function<void(bool bClosed)>;
    using FPing = std::function<void(std::int64_t LatencyMs, std::int64_t ServerTimeMs)>;
    using FToggleDemoDoor = std::function<void(bool bClosed, bool bChanged)>;

    explicit FTiangZLoginFlow(tiangz::client::ClientEndpoint LoginMgrEndpoint);
    ~FTiangZLoginFlow();

    FTiangZLoginFlow(const FTiangZLoginFlow&) = delete;
    FTiangZLoginFlow& operator=(const FTiangZLoginFlow&) = delete;

    void SetCallbacks(FProgress InProgress, FError InError, FReady InReady,
        FAoiDelta InAoiDelta, FNavigate InNavigate, FNumeric InNumeric,
        FDemoDoorState InDemoDoorState, FPing InPing);
    void Start(FString Account, std::uint32_t MapId);
    void Tick();
    void Close();

    bool NavigateTo(float X, float Y, float Z, std::uint32_t Sequence);
    bool NavigateInput(std::int32_t Forward, std::int32_t Strafe, float Yaw, std::uint32_t Sequence);
    /** 切换服务端权威动态门；完成回调只在游戏线程Update中执行。 / Toggles the authoritative demo door; completion runs only from game-thread Update. */
    bool ToggleDemoDoor(bool bClosed, FToggleDemoDoor OnCompleted);
    [[nodiscard]] bool IsReady() const { return bReady; }

private:
    using FSocket = tiangz::client::RpcSocket;
    using FProtocol = tiangz::protocol::demo::G2C_EnterMap;

    std::unique_ptr<FSocket> CreateSocket(const tiangz::client::ClientEndpoint& Endpoint);
    void ConnectLoginMgr();
    void ConnectLogin(const tiangz::protocol::demo::S2C_GetLoginServiceAddr& Address);
    void ConnectGate(const tiangz::protocol::demo::S2C_Login& Login);
    void EnterMap();
    void TryFinishEnter();
    void TickPing();
    void Fail(const std::string& Message);
    void Progress(const FString& Message) const;

    tiangz::client::ClientEndpoint LoginMgrEndpoint;
    tiangz::client::ClientEndpoint CurrentEndpoint;
    std::unique_ptr<FSocket> ManagerSocket;
    std::unique_ptr<FSocket> LoginSocket;
    std::unique_ptr<FSocket> GateSocket;
    FString Account;
    std::string LoginToken;
    std::uint32_t MapId = 100;
    std::optional<tiangz::protocol::demo::G2C_EnterMap> EnterResponse;
    std::optional<tiangz::protocol::demo::G2C_MapReady> MapReady;
    FProgress OnProgress;
    FError OnError;
    FReady OnReady;
    FAoiDelta OnAoiDelta;
    FNavigate OnNavigate;
    FNumeric OnNumeric;
    FDemoDoorState OnDemoDoorState;
    FPing OnPing;
    std::chrono::steady_clock::time_point NextPingAt{};
    std::chrono::steady_clock::time_point PingStartedAt{};
    bool bReady = false;
    bool bPingInFlight = false;
    bool bNavigateToInFlight = false;
    bool bNavigateInputInFlight = false;
    bool bToggleDemoDoorInFlight = false;
};
